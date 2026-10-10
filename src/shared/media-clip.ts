import type { MediaTrack } from "./model";

/** Safe render bounds; semantic validation and export reject invalid ranges. */
export function getMediaClip(track: MediaTrack, actualDurationMs?: number) {
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const sourceMs = Math.max(
    0,
    finite(actualDurationMs)
      ? actualDurationMs
      : finite(track.durationMs)
        ? track.durationMs
        : finite(track.trimEndMs)
          ? track.trimEndMs
          : 0,
  );
  const startMs = Math.min(
    sourceMs,
    Math.max(0, finite(track.trimStartMs) ? track.trimStartMs : 0),
  );
  const endMs = Math.max(
    startMs,
    Math.min(sourceMs, finite(track.trimEndMs) ? track.trimEndMs : sourceMs),
  );
  return { startMs, endMs, durationMs: endMs - startMs };
}
