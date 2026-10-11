import { useEffect, useRef, useState } from "react";
import type { SceneProject, SceneState, TimelineEvent } from "../shared";
import { applyRecording, quantizeRecordedInterval } from "../shared/recording";
import { PreviewAudio } from "./audio";
import { time } from "./Timeline";

const keys = "1234567890qwertyuiopasdfghjklzxcvbn";

export function PerformanceRecorder({
  project,
  state,
  audio,
  onApply,
  onClose,
}: {
  project: SceneProject;
  state: SceneState;
  audio: PreviewAudio;
  onApply(events: TimelineEvent[]): void;
  onClose(): void;
}) {
  const [armed, setArmed] = useState(
    () => new Set(project.outputs.map((output) => output.id)),
  );
  const [values, setValues] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<"setup" | "recording" | "review">("setup");
  const [position, setPosition] = useState(0);
  const [captured, setCaptured] = useState<TimelineEvent[]>([]);
  const [held, setHeld] = useState(new Set<string>());
  const [mode, setMode] = useState<"overdub" | "replace">("overdub");
  const [error, setError] = useState("");
  const started = useRef(0);
  const running = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const intervals = useRef<TimelineEvent[]>([]);
  const down = useRef(
    new Map<string, { at: number; active: boolean; sources: Set<string> }>(),
  );
  const clock = () =>
    Math.min(
      state.durationMs,
      Math.max(0, performance.now() - started.current),
    );
  const release = (id: string, source: string, at = clock()) => {
    const press = down.current.get(id);
    if (!press) return;
    press.sources.delete(source);
    if (press.sources.size) return;
    down.current.delete(id);
    const event = quantizeRecordedInterval(
      id,
      press.active,
      press.at,
      at,
      state.durationMs,
      crypto.randomUUID(),
    );
    if (event) intervals.current.push(event);
    setHeld(new Set(down.current.keys()));
  };
  const press = (id: string, source: string) => {
    if (!running.current || !armed.has(id)) return;
    const current = down.current.get(id);
    if (current) current.sources.add(source);
    else
      down.current.set(id, {
        at: clock(),
        active: values[id] ?? true,
        sources: new Set([source]),
      });
    setHeld(new Set(down.current.keys()));
  };
  const finish = () => {
    if (!running.current) return;
    const at = clock();
    running.current = false;
    for (const [id, entry] of down.current) {
      entry.sources.clear();
      release(id, "finish", at);
    }
    audio.stopAll();
    setPosition(at);
    setCaptured([...intervals.current]);
    setPhase("review");
  };
  const start = async () => {
    if (pending.current || running.current) return;
    pending.current = true;
    setError("");
    try {
      audio.stopAll();
      await audio.resume();
      if (!mounted.current) return;
      intervals.current = [];
      down.current.clear();
      setCaptured([]);
      setHeld(new Set());
      setPosition(0);
      started.current = performance.now();
      running.current = true;
      setPhase("recording");
    } catch (cause) {
      setError(`Could not start recording: ${String(cause)}`);
    } finally {
      pending.current = false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      running.current = false;
      audio.stopAll();
    };
  }, [audio]);
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),select:not([disabled])",
    );
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...root.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),select:not([disabled])",
        ),
      ];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (
        !event.shiftKey &&
        (index < 0 || index === controls.length - 1)
      ) {
        event.preventDefault();
        controls[0]?.focus();
      }
    };
    root.addEventListener("keydown", trap);
    return () => root.removeEventListener("keydown", trap);
  }, [phase]);
  useEffect(() => {
    if (phase !== "recording") return;
    const tick = () => {
      const at = clock();
      setPosition(at);
      const foreground =
        state.id === project.initialStateId ? null : state.foregroundTrack;
      const voices = [];
      if (
        project.audio.ambientTrack !== null &&
        (foreground === null || project.audio.keepAmbient)
      )
        voices.push({
          playerIndex: 0,
          track: project.audio.ambientTrack,
          volume:
            foreground === null
              ? project.audio.ambientVolume
              : (project.audio.ambientMixVolume ?? 0),
          positionMs: at,
          loop: true,
        });
      if (foreground !== null)
        voices.push({
          playerIndex: voices.length,
          track: foreground,
          volume: state.volume,
          positionMs: at,
          loop: state.loopAudio,
        });
      audio.sync(voices, project.audio.tracks);
      if (at >= state.durationMs) finish();
    };
    tick();
    const interval = window.setInterval(tick, 25);
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat)
        return;
      const index = keys.indexOf(event.key.toLowerCase());
      if (index < 0 || !project.outputs[index]) return;
      event.preventDefault();
      press(project.outputs[index].id, `key:${event.code}`);
    };
    const keyup = (event: KeyboardEvent) => {
      for (const id of down.current.keys()) release(id, `key:${event.code}`);
    };
    const blur = () => finish();
    const hidden = () => {
      if (document.hidden) finish();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(interval);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [phase]);
  const result =
    phase === "review"
      ? applyRecording(state.events, captured, [...armed], mode, () =>
          crypto.randomUUID(),
        )
      : [];
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialog}
        className="modal recording-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-title"
      >
        <h2 id="record-title">Record performance · {state.name}</h2>
        <p>
          Hold a channel button or its keyboard key in time with the audio. This
          records one pass of the selected state in 50 ms steps. Physical
          outputs stay under their controller's existing configuration; these
          buttons only edit the desktop timeline.
        </p>
        <div className="record-progress" role="status">
          <strong>
            {phase === "recording"
              ? "Recording"
              : phase === "review"
                ? "Review your take"
                : "Ready to record"}
          </strong>
          <span className="mono">
            {time(position)} / {time(state.durationMs)}
          </span>
        </div>
        <progress
          max={state.durationMs}
          value={position}
          aria-label="Recording progress"
        />
        <div className="record-lanes">
          {project.outputs.map((output, index) => (
            <div className="record-lane" key={output.id}>
              <label className="check">
                <input
                  aria-label={`Record ${output.name}`}
                  type="checkbox"
                  checked={armed.has(output.id)}
                  disabled={phase !== "setup"}
                  onChange={(event) =>
                    setArmed((old) => {
                      const next = new Set(old);
                      if (event.target.checked) next.add(output.id);
                      else next.delete(output.id);
                      return next;
                    })
                  }
                />
                {output.name}
              </label>
              <select
                aria-label={`${output.name} recorded value`}
                value={(values[output.id] ?? true) ? "on" : "off"}
                disabled={phase !== "setup"}
                onChange={(event) =>
                  setValues((old) => ({
                    ...old,
                    [output.id]: event.target.value === "on",
                  }))
                }
              >
                <option value="on">ON while held</option>
                <option value="off">OFF while held</option>
              </select>
              <button
                aria-label={`Hold ${output.name}`}
                aria-pressed={held.has(output.id)}
                disabled={phase !== "recording" || !armed.has(output.id)}
                className={held.has(output.id) ? "selected" : ""}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  press(output.id, `pointer:${event.pointerId}`);
                }}
                onPointerUp={(event) =>
                  release(output.id, `pointer:${event.pointerId}`)
                }
                onPointerCancel={(event) =>
                  release(output.id, `pointer:${event.pointerId}`)
                }
                onLostPointerCapture={(event) =>
                  release(output.id, `pointer:${event.pointerId}`)
                }
              >
                <kbd>{keys[index].toUpperCase()}</kbd> Hold
              </button>
            </div>
          ))}
        </div>
        {phase === "review" && (
          <>
            <label>
              Apply this take
              <select
                aria-label="Recording apply mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="overdub">Overdub · keep other intervals</option>
                <option value="replace">Replace all armed channels</option>
              </select>
            </label>
            <p>
              {captured.length} captured interval
              {captured.length === 1 ? "" : "s"}; {result.length} total output
              events after applying.{" "}
              {mode === "overdub"
                ? "New intervals replace any overlapping portions of old intervals; the rest stays."
                : "All existing events on armed channels are replaced, including channels with no presses."}{" "}
              IR cues are preserved. Apply creates one undo step.
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="row">
          <button
            onClick={() => {
              running.current = false;
              audio.stopAll();
              onClose();
            }}
          >
            {phase === "setup" ? "Cancel" : "Discard take"}
          </button>
          {phase === "setup" && (
            <button
              className="primary"
              disabled={!armed.size}
              onClick={() => void start()}
            >
              Start recording
            </button>
          )}
          {phase === "recording" && (
            <button className="danger" onClick={finish}>
              Finish take
            </button>
          )}
          {phase === "review" && (
            <>
              <button
                onClick={() => {
                  setPhase("setup");
                  setPosition(0);
                }}
              >
                Record again
              </button>
              <button className="primary" onClick={() => onApply(result)}>
                Apply recording
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
