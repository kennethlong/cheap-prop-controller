import { LIMITS, type TimelineEvent } from "./model";

export type RecordingMode = "overdub" | "replace";

/** Capture one held control onto the scene's fixed time grid. */
export function quantizeRecordedInterval(
  outputId: string,
  active: boolean,
  startMs: number,
  endMs: number,
  durationMs: number,
  id: string,
): TimelineEvent | null {
  if (
    ![startMs, endMs, durationMs].every(Number.isFinite) ||
    durationMs < LIMITS.tickMs ||
    endMs < startMs ||
    endMs < 0 ||
    startMs >= durationMs
  )
    return null;
  const duration = Math.floor(durationMs / LIMITS.tickMs) * LIMITS.tickMs;
  const start = Math.min(
    duration - LIMITS.tickMs,
    Math.max(0, Math.round(startMs / LIMITS.tickMs) * LIMITS.tickMs),
  );
  const end = Math.min(
    duration,
    Math.max(
      start + LIMITS.tickMs,
      Math.round(endMs / LIMITS.tickMs) * LIMITS.tickMs,
    ),
  );
  return { id, outputId, active, startMs: start, endMs: end };
}

/**
 * A take replaces only its covered ranges during overdub. Replace mode clears
 * all armed channels first, including armed channels with no recorded presses.
 * The caller applies the returned events as one undoable edit.
 */
export function applyRecording(
  existing: TimelineEvent[],
  recorded: TimelineEvent[],
  armedOutputIds: string[],
  mode: RecordingMode,
  createId: () => string,
): TimelineEvent[] {
  const armed = new Set(armedOutputIds);
  let result = existing
    .filter((event) => mode !== "replace" || !armed.has(event.outputId))
    .map((event) => ({ ...event }));
  for (const capture of recorded) {
    if (!armed.has(capture.outputId) || capture.endMs <= capture.startMs)
      continue;
    const next: TimelineEvent[] = [];
    for (const event of result) {
      if (
        event.outputId !== capture.outputId ||
        event.endMs <= capture.startMs ||
        event.startMs >= capture.endMs
      ) {
        next.push(event);
        continue;
      }
      const hasLeft = event.startMs < capture.startMs;
      if (hasLeft) next.push({ ...event, endMs: capture.startMs });
      if (event.endMs > capture.endMs)
        next.push({
          ...event,
          id: hasLeft ? createId() : event.id,
          startMs: capture.endMs,
        });
    }
    next.push({ ...capture });
    result = next;
  }
  // Keep untouched lanes byte-for-byte in their original ordering. Normalize
  // edited lanes so adjacent presses do not waste EEPROM event records.
  const touched = new Set(
    recorded
      .filter((event) => armed.has(event.outputId))
      .map((event) => event.outputId),
  );
  const normalized = result.filter((event) => !touched.has(event.outputId));
  for (const outputId of touched) {
    const lane = result
      .filter((event) => event.outputId === outputId)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let previous: TimelineEvent | undefined;
    for (const event of lane) {
      if (
        previous &&
        (previous.active ?? true) === (event.active ?? true) &&
        event.startMs <= previous.endMs
      ) {
        previous.endMs = Math.max(previous.endMs, event.endMs);
      } else {
        previous = { ...event };
        normalized.push(previous);
      }
    }
  }
  return normalized;
}
