/**
 * ProMotion 120 Hz Governor for iOS / iPadOS WebKit.
 *
 * Implements the three-part WebKit ProMotion wake protocol:
 * 1. `.quire-rate-mark`: 1px GPU-composited transform animation registering an active CAAnimation.
 * 2. `.quire-display-pacer`: hidden overflow:scroll container continuously smooth-scrolling
 *    across a 240px range every 120ms so UIKit's UIScrollView CADisplayLink NEVER drops out
 *    of CAFrameRateRange(80, 120, 120) between words or strokes on M1/M2/M4 iPad Pro.
 * 3. Empty main-thread requestAnimationFrame loop: forces RemoteLayerTreeDrawingAreaProxy::didRefreshDisplay
 *    to call scrollingCoordinatorProxy->sendScrollingTreeNodeUpdate() unconditionally (bypassing
 *    m_waitingForDidScrollReply in RemoteScrollingCoordinatorProxy.cpp).
 *
 * Holds 120 Hz warm for `holdMs` (default 15s while an ink tool is active) so starting a new word
 * never suffers a 2–4 frame 60->120 Hz ProMotion PLL ramp-up delay, then parks cleanly on idle.
 */
export class ProMotionGovernor {
  private host: HTMLElement;
  private rateMark: HTMLSpanElement;
  private pacer: HTMLDivElement;
  private scrollKeep: HTMLSpanElement;
  private active = false;
  private pinned = false;
  private rafId = 0;
  private holdTimer = 0;
  private pacerForward = true;
  private lastPacerAt = -Infinity;
  private lastVsync = 0;
  private readonly holdMs: number;
  private readonly pacerPeriodMs: number;
  private readonly onStatusChange?: (active: boolean) => void;

  constructor(
    host: HTMLElement,
    options?: {
      holdMs?: number;
      pacerPeriodMs?: number;
      scrollContainer?: HTMLElement;
      onStatusChange?: (active: boolean) => void;
    }
  ) {
    this.host = host;
    this.holdMs = options?.holdMs ?? 850;
    this.pacerPeriodMs = options?.pacerPeriodMs ?? 180;
    this.onStatusChange = options?.onStatusChange;

    this.rateMark = document.createElement('span');
    this.rateMark.className = 'quire-rate-mark';
    this.rateMark.setAttribute('aria-hidden', 'true');

    this.pacer = document.createElement('div');
    this.pacer.className = 'quire-display-pacer';
    this.pacer.setAttribute('aria-hidden', 'true');
    const pacerInner = document.createElement('div');
    pacerInner.style.height = '16px';
    pacerInner.style.width = '1px';
    this.pacer.appendChild(pacerInner);

    // Defeats WebKit's 10 Hz scroll throttling during URL bar resize transitions
    this.scrollKeep = document.createElement('span');
    this.scrollKeep.className = 'quire-scroll-keep';
    this.scrollKeep.setAttribute('aria-hidden', 'true');
    (options?.scrollContainer ?? this.host).appendChild(this.scrollKeep);
  }

  get isActive(): boolean {
    return this.active;
  }

  get vsyncTimestamp(): number {
    return this.lastVsync;
  }

  wake(): void {
    window.clearTimeout(this.holdTimer);
    if (!this.active) {
      this.active = true;
      this.host.appendChild(this.rateMark);
      this.host.appendChild(this.pacer);
      this.stepPacer(performance.now());
      this.rafId = requestAnimationFrame(this.tick);
      this.onStatusChange?.(true);
    }
    if (!this.pinned) {
      this.holdTimer = window.setTimeout(() => this.park(), this.holdMs);
    }
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    if (pinned) {
      this.wake();
    } else if (this.active) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => this.park(), this.holdMs);
    }
  }

  park(): void {
    if (!this.active) return;
    window.clearTimeout(this.holdTimer);
    cancelAnimationFrame(this.rafId);
    this.rateMark.remove();
    this.pacer.remove();
    this.lastPacerAt = -Infinity;
    this.active = false;
    this.onStatusChange?.(false);
  }

  dispose(): void {
    this.park();
    this.scrollKeep.remove();
  }

  private tick = (ts: number): void => {
    if (!this.active) return;
    this.lastVsync = ts;
    this.stepPacer(ts);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private stepPacer(now: number): void {
    if (now - this.lastPacerAt < this.pacerPeriodMs) return;
    this.lastPacerAt = now;
    const targetTop = this.pacerForward ? 8 : 0;
    this.pacerForward = !this.pacerForward;
    try {
      this.pacer.scrollTo({
        top: targetTop,
        behavior: 'smooth',
      });
    } catch {
      this.pacer.scrollTop = targetTop;
    }
  }
}
