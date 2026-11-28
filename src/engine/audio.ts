import type { AudioSegment, AudioSession } from '../types';
import { createId, quireStorage } from './storage';
import { logDiagnostic } from './diagnostics';

/**
 * Crash-Safe Audio Recording & Stroke-Timestamp Clock (FR-AUD-01..04).
 *
 * - Uses hardware AAC (`audio/mp4`) on iPadOS/Safari with WebM/Opus fallback on Chromium/Firefox.
 * - Streams encoded 10-second chunks via `O(1)` OPFS `FileSystemSyncAccessHandle` byte appends
 *   and checkpoints `durationMs` + `segments` to SQLite every 10s so crashes/battery exhaustion
 *   recover playable audio with accurate duration (NFR 6.1).
 * - Holds `navigator.wakeLock.request('screen')` on iPadOS 18.4+ PWAs (with hidden looping
 *   `<video playsinline>` fallback for iPadOS <18.4) and cleanly segments on `visibilitychange`
 *   or unexpected mic track mute.
 */

export type RecordingState = 'idle' | 'recording' | 'paused';

// Minimal 1x1 silent MP4 data URI for iPadOS <18.4 Wake Lock fallback when navigator.wakeLock is absent
const SILENT_FALLBACK_VIDEO =
  'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAu1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0OCByMjY0MyA1YzY1NzA0IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlyaWdodCAyMDAzLTIwMTUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgZmlsbGVyPTEgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAW1lAQAA//8=';

export class AudioSyncRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private fallbackVideoEl: HTMLVideoElement | null = null;
  private state: RecordingState = 'idle';
  private noteId: string | null = null;
  private sessionId: string | null = null;
  private blobKey: string | null = null;
  private mimeType = 'audio/mp4';
  private accumulatedMs = 0;
  private segmentStartPerf = 0;
  private segments: AudioSegment[] = [];
  private onInterruption?: (reason: string) => void;
  private onCheckpoint?: (durationMs: number, segments: AudioSegment[]) => void;
  private visibilityListener: (() => void) | null = null;
  private pendingFlushChain: Promise<void> = Promise.resolve();

  constructor(options?: {
    onInterruption?: (reason: string) => void;
    onCheckpoint?: (durationMs: number, segments: AudioSegment[]) => void;
  }) {
    this.onInterruption = options?.onInterruption;
    this.onCheckpoint = options?.onCheckpoint;
  }

  get recordingState(): RecordingState {
    return this.state;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get activeNoteId(): string | null {
    return this.noteId;
  }

  getElapsedMs(): number {
    if (this.state === 'recording') {
      return Math.round(this.accumulatedMs + (performance.now() - this.segmentStartPerf));
    }
    return Math.round(this.accumulatedMs);
  }

  private pickSupportedMimeType(): string {
    if (typeof MediaRecorder === 'undefined') return 'audio/mp4';
    const candidates = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  }

  async start(existingSessionCount: number, noteId?: string): Promise<AudioSession> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is unavailable in this browser context.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.mimeType = this.pickSupportedMimeType() || 'audio/webm';
    this.noteId = noteId ?? null;
    this.sessionId = createId('aud');
    this.blobKey = `audio_${this.sessionId}`;
    this.accumulatedMs = 0;
    this.segments = [];
    this.segmentStartPerf = performance.now();

    const options: MediaRecorderOptions = { audioBitsPerSecond: 48_000 };
    if (this.mimeType) options.mimeType = this.mimeType;

    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        const chunk = ev.data;
        this.enqueueChunkFlush(chunk);
      }
    };

    this.mediaRecorder.onpause = () => {
      if (this.state === 'recording') {
        const segStart = Math.round(this.accumulatedMs);
        this.accumulatedMs += performance.now() - this.segmentStartPerf;
        this.segments.push({ startMs: segStart, endMs: Math.round(this.accumulatedMs) });
        this.state = 'paused';
      }
    };

    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onmute = () => {
        if (this.state === 'recording') {
          this.pause();
          this.onInterruption?.('Audio input was interrupted. Recording paused safely.');
        }
      };
    }

    // Listen to visibilitychange for screen-lock / app-switch segmentation & WakeLock re-acquire
    if (typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'hidden') {
          if (this.state === 'recording') {
            this.pause();
            this.onInterruption?.('Screen locked or app backgrounded — recording paused safely.');
          }
        } else if (document.visibilityState === 'visible') {
          if (this.state === 'recording') {
            void this.acquireWakeLock();
          }
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    // 10-second crash-safe streaming flush interval (PRD NFR 6.1)
    this.mediaRecorder.start(10_000);
    this.state = 'recording';
    await this.acquireWakeLock();

    return {
      id: this.sessionId,
      name: `Recording ${existingSessionCount + 1}`,
      createdAt: Date.now(),
      durationMs: 0,
      mimeType: this.mimeType,
      blobKey: this.blobKey,
      segments: [],
    };
  }

  private enqueueChunkFlush(chunk: Blob): void {
    const key = this.blobKey;
    const noteId = this.noteId;
    const sessionId = this.sessionId;
    if (!key) return;

    this.pendingFlushChain = this.pendingFlushChain
      .then(async () => {
        await quireStorage.appendBlobChunk(key, chunk);
        const elapsed = this.getElapsedMs();
        const liveSegments: AudioSegment[] =
          this.state === 'recording'
            ? [...this.segments, { startMs: Math.round(this.accumulatedMs), endMs: elapsed }]
            : [...this.segments];
        if (noteId && sessionId) {
          await quireStorage.updateAudioSessionCheckpoint(noteId, sessionId, elapsed, liveSegments);
        }
        this.onCheckpoint?.(elapsed, liveSegments);
      })
      .catch((err) => {
        logDiagnostic('error', 'audio', 'Failed to flush 10s audio chunk to OPFS', err);
      });
  }

  pause(): void {
    if (this.state !== 'recording' || !this.mediaRecorder) return;
    const segStart = Math.round(this.accumulatedMs);
    this.accumulatedMs += performance.now() - this.segmentStartPerf;
    this.segments.push({ startMs: segStart, endMs: Math.round(this.accumulatedMs) });
    if (this.mediaRecorder.state === 'recording') {
      try {
        this.mediaRecorder.requestData();
      } catch {
        // ignore if unsupported
      }
      this.mediaRecorder.pause();
    }
    this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused' || !this.mediaRecorder) return;
    this.segmentStartPerf = performance.now();
    if (this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
    this.state = 'recording';
    void this.acquireWakeLock();
  }

  async stop(): Promise<{ durationMs: number; segments: AudioSegment[] }> {
    if (!this.mediaRecorder) {
      return { durationMs: Math.round(this.accumulatedMs), segments: [...this.segments] };
    }
    if (this.state === 'recording') {
      const segStart = Math.round(this.accumulatedMs);
      this.accumulatedMs += performance.now() - this.segmentStartPerf;
      this.segments.push({ startMs: segStart, endMs: Math.round(this.accumulatedMs) });
    }

    const recorder = this.mediaRecorder;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        resolve();
      }
    });

    await this.pendingFlushChain;
    if (this.blobKey) {
      await quireStorage.finalizeBlobStream(this.blobKey);
    }

    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.mediaRecorder = null;
    this.state = 'idle';
    await this.releaseWakeLock();

    const finalDuration = Math.round(this.accumulatedMs);
    const finalSegments = [...this.segments];
    if (this.noteId && this.sessionId) {
      await quireStorage
        .updateAudioSessionCheckpoint(this.noteId, this.sessionId, finalDuration, finalSegments)
        .catch(() => {});
    }

    return {
      durationMs: finalDuration,
      segments: finalSegments,
    };
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock?.request) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        return;
      }
    } catch {
      // Fall through to hidden video fallback for iPadOS <18.4
    }

    if (typeof document !== 'undefined' && !this.fallbackVideoEl) {
      try {
        const video = document.createElement('video');
        video.setAttribute('playsinline', '');
        video.muted = true;
        video.loop = true;
        video.src = SILENT_FALLBACK_VIDEO;
        video.style.cssText =
          'position:fixed;width:1px;height:1px;opacity:0.001;pointer-events:none;top:0;left:0;';
        document.body.appendChild(video);
        await video.play().catch(() => {});
        this.fallbackVideoEl = video;
      } catch {
        // Non-fatal
      }
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      // ignore
    }
    this.wakeLock = null;
    if (this.fallbackVideoEl) {
      try {
        this.fallbackVideoEl.pause();
        this.fallbackVideoEl.remove();
      } catch {
        // ignore
      }
      this.fallbackVideoEl = null;
    }
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
