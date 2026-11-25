import type { HLC, NoteDocument } from '../types';
import { createId, getDeviceId } from './storage';

/**
 * Local-First Delta Sync & Non-Destructive Conflict Resolution Engine (FR-SYN-01, CUJ 6).
 *
 * - Uses Hybrid Logical Clocks (HLC) to detect causal divergence across offline devices.
 * - Never silently overwrites user ink: if two devices edited the same note offline,
 *   produces a clearly labeled conflict copy ("Note Name — Conflict Copy [Device, Date]")
 *   while preserving both versions intact.
 */

export function tickHLC(prev: HLC, now = Date.now()): HLC {
  const deviceId = getDeviceId();
  if (now > prev.ts) {
    return { ts: now, counter: 0, deviceId };
  }
  return { ts: prev.ts, counter: prev.counter + 1, deviceId };
}

export interface SyncMergeResult {
  merged: NoteDocument;
  conflictCopy: NoteDocument | null;
}

export function mergeNoteVersions(local: NoteDocument, remote: NoteDocument): SyncMergeResult {
  // Identical HLC -> no-op
  if (
    local.hlc.ts === remote.hlc.ts &&
    local.hlc.counter === remote.hlc.counter &&
    local.hlc.deviceId === remote.hlc.deviceId
  ) {
    return { merged: local, conflictCopy: null };
  }

  // Same device or strict linear progression with identical page stroke counts -> fast-forward newer
  const localPageIds = new Set(local.pages.map((p) => p.pageId));
  const remotePageIds = new Set(remote.pages.map((p) => p.pageId));
  const sharedPages = [...localPageIds].filter((id) => remotePageIds.has(id));

  let hasConcurrentPageConflict = false;
  for (const pid of sharedPages) {
    const localStrokes = local.strokesByPage[pid] ?? [];
    const remoteStrokes = remote.strokesByPage[pid] ?? [];
    const localIds = new Set(localStrokes.map((s) => s.id));
    const remoteIds = new Set(remoteStrokes.map((s) => s.id));
    const localOnly = localStrokes.some((s) => !remoteIds.has(s.id));
    const remoteOnly = remoteStrokes.some((s) => !localIds.has(s.id));
    if (localOnly && remoteOnly && local.hlc.deviceId !== remote.hlc.deviceId) {
      hasConcurrentPageConflict = true;
      break;
    }
  }

  if (!hasConcurrentPageConflict) {
    const winner =
      remote.hlc.ts > local.hlc.ts ||
      (remote.hlc.ts === local.hlc.ts && remote.hlc.counter > local.hlc.counter)
        ? remote
        : local;
    return { merged: winner, conflictCopy: null };
  }

  // Non-destructive conflict copy creation (CUJ 6)
  const dateLabel = new Date(remote.updatedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const conflictCopy: NoteDocument = {
    ...structuredClone(remote),
    id: createId('note'),
    title: `${remote.title} — Conflict Copy [${remote.hlc.deviceId.slice(0, 8)}, ${dateLabel}]`,
    updatedAt: Date.now(),
    hlc: tickHLC(local.hlc),
  };

  return { merged: local, conflictCopy };
}
