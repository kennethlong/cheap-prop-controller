import { useEffect, useRef, useState } from "react";
import { Play, RotateCcw, Save, Square } from "lucide-react";
import type { MediaTrack } from "../shared/model";

interface AudioTrimEditorProps {
  track: MediaTrack;
  waveform?: number[];
  durationMs?: number;
  loaded: boolean;
  onApply(startMs: number, endMs: number | null): void;
  onPreview(startMs: number, endMs: number): void;
  onStop(): void;
  onSave?(startMs: number, endMs: number): Promise<void>;
}

const seconds = (value: number) => (value / 1000).toFixed(3);

/** Keep the source audio intact; edit the selection that preview/export use. */
export function AudioTrimEditor({
  track,
  waveform,
  durationMs,
  loaded,
  onApply,
  onPreview,
  onStop,
  onSave,
}: AudioTrimEditorProps) {
  const duration = Math.max(0, Math.round(durationMs ?? track.durationMs ?? 0));
  const [startText, setStartText] = useState(seconds(track.trimStartMs ?? 0));
  const [endText, setEndText] = useState(seconds(track.trimEndMs ?? duration));
  const [saving, setSaving] = useState(false);
  const waveformRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;

  useEffect(() => {
    setStartText(seconds(track.trimStartMs ?? 0));
    setEndText(seconds(track.trimEndMs ?? duration));
  }, [track.number, track.name, track.trimStartMs, track.trimEndMs, duration]);
  useEffect(() => () => stopRef.current(), []);

  const start = Math.round(Number(startText) * 1000);
  const end = Math.round(Number(endText) * 1000);
  const valid =
    duration > 0 &&
    startText.trim() !== "" &&
    endText.trim() !== "" &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= duration;
  const changed =
    start !== (track.trimStartMs ?? 0) || end !== (track.trimEndMs ?? duration);
  const startRatio = duration ? Math.max(0, Math.min(1, start / duration)) : 0;
  const endRatio = duration ? Math.max(0, Math.min(1, end / duration)) : 1;
  const setBoundary = (boundary: "start" | "end", value: number) => {
    onStop();
    if (boundary === "start") {
      setStartText(seconds(Math.max(0, Math.min(value, end - 1))));
    } else {
      setEndText(seconds(Math.min(duration, Math.max(value, start + 1))));
    }
  };
  const dragTo = (clientX: number) => {
    const bounds = waveformRef.current?.getBoundingClientRect();
    if (!bounds || !dragging.current) return;
    setBoundary(
      dragging.current,
      Math.round(((clientX - bounds.left) / bounds.width) * duration),
    );
  };

  return (
    <section
      className="audio-trim-editor"
      aria-label={`Audio editor for ${track.name}`}
    >
      <div className="row between wrap">
        <div>
          <h3>Choose the part to play</h3>
          <p className="hint">
            Drag the handles or enter times, then apply the trim. Your original
            audio file stays unchanged.
          </p>
        </div>
        <span className="badge">Source {seconds(duration)} s</span>
      </div>
      <div
        ref={waveformRef}
        className={`trim-waveform ${duration ? "" : "unavailable"}`}
        data-testid={`trim-waveform-${track.number}`}
      >
        {waveform?.length ? (
          <svg
            viewBox={`0 0 ${waveform.length} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d={waveform
                .map((peak, index) => {
                  const height = Math.max(0.75, peak * 43);
                  return `M${index} ${50 - height}V${50 + height}`;
                })
                .join(" ")}
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        ) : (
          <div className="trim-waveform-placeholder">
            {duration
              ? "Link the audio file to see its waveform and preview the selection."
              : "Link an audio file before setting its start and end."}
          </div>
        )}
        {duration > 0 && valid && (
          <>
            <div
              className="trim-excluded"
              style={{ left: 0, width: `${startRatio * 100}%` }}
            />
            <div
              className="trim-excluded"
              style={{ left: `${endRatio * 100}%`, right: 0 }}
            />
            <div
              className="trim-selection"
              style={{
                left: `${startRatio * 100}%`,
                width: `${(endRatio - startRatio) * 100}%`,
              }}
            />
            {(["start", "end"] as const).map((boundary) => (
              <div
                key={boundary}
                className={`trim-handle ${boundary}`}
                role="slider"
                tabIndex={0}
                aria-label={`Trim ${boundary} handle`}
                aria-valuemin={boundary === "start" ? 0 : (start + 1) / 1000}
                aria-valuemax={
                  boundary === "start" ? (end - 1) / 1000 : duration / 1000
                }
                aria-valuenow={(boundary === "start" ? start : end) / 1000}
                aria-valuetext={`${seconds(boundary === "start" ? start : end)} seconds`}
                style={{
                  left: `${(boundary === "start" ? startRatio : endRatio) * 100}%`,
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  dragging.current = boundary;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  onStop();
                }}
                onPointerMove={(event) => {
                  if (dragging.current === boundary) dragTo(event.clientX);
                }}
                onPointerUp={(event) => {
                  if (dragging.current !== boundary) return;
                  dragTo(event.clientX);
                  dragging.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  dragging.current = null;
                }}
                onKeyDown={(event) => {
                  const current = boundary === "start" ? start : end;
                  const step = event.shiftKey ? 1000 : 10;
                  const value =
                    event.key === "ArrowLeft" || event.key === "ArrowDown"
                      ? current - step
                      : event.key === "ArrowRight" || event.key === "ArrowUp"
                        ? current + step
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? duration
                            : null;
                  if (value === null) return;
                  event.preventDefault();
                  setBoundary(boundary, value);
                }}
              >
                <span>{boundary === "start" ? "IN" : "OUT"}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="trim-ruler mono">
        <span>0.000 s</span>
        <span>{seconds(duration / 2)} s</span>
        <span>{seconds(duration)} s</span>
      </div>
      <div className="trim-controls">
        <label>
          Beginning offset (seconds)
          <input
            aria-label="Trim start seconds"
            type="number"
            min="0"
            max={duration / 1000}
            step="0.001"
            disabled={!duration}
            value={startText}
            onChange={(event) => {
              onStop();
              setStartText(event.target.value);
            }}
          />
        </label>
        <label>
          End (seconds)
          <input
            aria-label="Trim end seconds"
            type="number"
            min="0.001"
            max={duration / 1000}
            step="0.001"
            disabled={!duration}
            value={endText}
            onChange={(event) => {
              onStop();
              setEndText(event.target.value);
            }}
          />
        </label>
        <div className="trim-length">
          <span className="muted small">Selected duration</span>
          <strong className="mono" data-testid="trim-duration">
            {valid ? `${seconds(end - start)} s` : "—"}
          </strong>
        </div>
        <button
          className="primary"
          disabled={!valid || !changed}
          onClick={() => {
            onStop();
            onApply(start, end === duration ? null : end);
          }}
        >
          Apply trim
        </button>
        <button
          disabled={!duration}
          onClick={() => {
            onStop();
            setStartText("0.000");
            setEndText(seconds(duration));
            onApply(0, null);
          }}
        >
          <RotateCcw size={14} /> Full track
        </button>
      </div>
      {!valid && duration > 0 && (
        <p className="danger-text small" role="alert">
          Enter a start at or after 0 and an end after the start, no later than{" "}
          {seconds(duration)} seconds.
        </p>
      )}
      <div className="row wrap">
        <button
          disabled={!valid || !loaded}
          onClick={() => onPreview(start, end)}
        >
          <Play size={14} /> Preview selection
        </button>
        <button disabled={!loaded} onClick={onStop}>
          <Square size={14} /> Stop selection
        </button>
        {onSave && (
          <button
            disabled={!valid || !loaded || !track.path || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(start, end);
              } finally {
                setSaving(false);
              }
            }}
          >
            <Save size={14} /> {saving ? "Saving MP3…" : "Save trimmed MP3…"}
          </button>
        )}
        <span className="hint">
          {changed
            ? "Apply to use this selection in your scene."
            : "Selection applied to this track."}
        </span>
      </div>
      <p className="hint">
        Export files for MP3 cards creates the trimmed audio for your players.
        Re-export and copy the files to every card after changing a trim.
      </p>
    </section>
  );
}
