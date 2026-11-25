/**
 * 120 Hz Vsync-Phase-Locked Scroll Controller Bus.
 *
 * Reads scrollLeft / scrollTop synchronously at 2x display refresh cadence (4.167 ms for 120 Hz)
 * using MessageChannel + phase-locked setTimeout anchored to requestAnimationFrame timestamps.
 * Divides by the active DPR scale factor when paired with a DPR-scaled scroll plane so
 * sub-point scroll offsets are preserved without integer CSS-pixel rounding.
 */

export interface ScrollReading {
  left: number;
  top: number;
  at: number;
}

export interface ScrollBusOptions {
  read: () => { left: number; top: number };
  onReading: (reading: ScrollReading) => void;
  onIdle?: () => void;
  displayHz?: number;
  samplesPerFrame?: number;
  leadMs?: number;
  settleMs?: number;
}

export function createScrollBus(options: ScrollBusOptions) {
  const displayHz = options.displayHz ?? 120;
  const samplesPerFrame = options.samplesPerFrame ?? 2;
  const leadMs = options.leadMs ?? 1;
  const settleMs = options.settleMs ?? 250;
  const stepMs = 1000 / displayHz / samplesPerFrame;

  const channel = new MessageChannel();
  let running = false;
  let vsync = 0;
  let rafId = 0;
  let timerId = 0;
  let targetAt = 0;
  let lastChangeAt = 0;
  let last = options.read();

  const nextTarget = (anchor: number, earliest: number): number =>
    anchor + Math.ceil((earliest - anchor + leadMs) / stepMs) * stepMs - leadMs;

  const rafLoop = (ts: number) => {
    vsync = ts;
    if (running) {
      rafId = requestAnimationFrame(rafLoop);
    }
  };

  const stop = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    window.clearTimeout(timerId);
    options.onIdle?.();
  };

  const sample = () => {
    if (!running) return;
    const now = performance.now();
    const current = options.read();
    if (current.left !== last.left || current.top !== last.top) {
      last = current;
      lastChangeAt = now;
      options.onReading({ left: current.left, top: current.top, at: now });
    }
    if (now - lastChangeAt > settleMs) {
      stop();
      return;
    }
    channel.port2.postMessage(null);
  };

  channel.port1.addEventListener('message', () => {
    if (!running) return;
    const now = performance.now();
    targetAt = nextTarget(vsync || now, Math.max(now, targetAt + stepMs / 2));
    timerId = window.setTimeout(sample, Math.max(0, targetAt - now));
  });
  channel.port1.start();

  return {
    wake() {
      lastChangeAt = performance.now();
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(rafLoop);
        sample();
      }
    },
    isRunning() {
      return running;
    },
    dispose() {
      stop();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
