/**
 * Single-Active-Window OPFS Lock Coordinator via BroadcastChannel.
 *
 * OPFS `FileSystemSyncAccessHandle` (used by SQLite `opfs-sahpool` VFS) takes an exclusive
 * lock per origin. When a user opens Quire in a second tab or iPadOS Split View window:
 * 1. The newly active window broadcasts `claim-lock`.
 * 2. Any previous owner immediately flushes pending saves, pauses its OPFS VFS handles,
 *    shows a calm "Paused in another tab" overlay, and replies `lock-released`.
 * 3. The claiming window acquires/unpauses its OPFS handles cleanly with zero
 *    `NoModificationAllowedError` crashes.
 */

export type WindowLockMessage =
  | { type: 'claim-lock'; tabId: string; ts: number }
  | { type: 'lock-released'; tabId: string; forTabId: string };

export class WindowLockCoordinator {
  private readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private isOwner = true;
  private onYieldLock: () => Promise<void>;
  private onResumeLock: () => Promise<void>;
  private pendingAckResolve: (() => void) | null = null;

  constructor(options: {
    onYieldLock: () => Promise<void>;
    onResumeLock: () => Promise<void>;
  }) {
    this.tabId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `tab_${Math.random().toString(36).slice(2, 10)}`;
    this.onYieldLock = options.onYieldLock;
    this.onResumeLock = options.onResumeLock;

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('quire-window-lock-v1');
      this.channel.onmessage = (ev: MessageEvent<WindowLockMessage>) => {
        const msg = ev.data;
        if (!msg || msg.tabId === this.tabId) return;

        if (msg.type === 'claim-lock') {
          if (this.isOwner) {
            this.isOwner = false;
            void this.onYieldLock().finally(() => {
              this.channel?.postMessage({
                type: 'lock-released',
                tabId: this.tabId,
                forTabId: msg.tabId,
              } satisfies WindowLockMessage);
            });
          } else {
            this.channel?.postMessage({
              type: 'lock-released',
              tabId: this.tabId,
              forTabId: msg.tabId,
            } satisfies WindowLockMessage);
          }
        } else if (msg.type === 'lock-released' && msg.forTabId === this.tabId) {
          this.pendingAckResolve?.();
          this.pendingAckResolve = null;
        }
      };
    }
  }

  get ownsLock(): boolean {
    return this.isOwner;
  }

  /**
   * Claims exclusive OPFS ownership, waiting briefly (up to 350ms) for any other tab to yield.
   */
  async claimOwnership(): Promise<void> {
    if (!this.channel) {
      this.isOwner = true;
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAckResolve = null;
        resolve();
      }, 350);

      this.pendingAckResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      this.channel?.postMessage({
        type: 'claim-lock',
        tabId: this.tabId,
        ts: Date.now(),
      } satisfies WindowLockMessage);
    });

    const wasPaused = !this.isOwner;
    this.isOwner = true;
    if (wasPaused) {
      await this.onResumeLock();
    }
  }

  dispose(): void {
    this.channel?.close();
    this.channel = null;
  }
}
