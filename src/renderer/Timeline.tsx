import { useEffect, useRef, useState } from "react";
import {
  MousePointer2,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { SceneProject, SceneState, TimelineEvent } from "../shared/model";
import { isZonedTrigger } from "../shared/model";
import { irEventName, isChildState } from "../shared";
import type { SimulatorSnapshot } from "../shared/simulator";
import { outputUnavailableReason } from "./outputOwnership";

export const time = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${((ms % 60000) / 1000).toFixed(2).padStart(5, "0")}`;
const snap = (ms: number) => Math.round(ms / 50) * 50;

interface Props {
  project: SceneProject;
  state: SceneState;
  selectedEvent: string | null;
  selectedIrEvent: string | null;
  onSelectIr(id: string | null): void;
  onAddIr(atMs: number): void;
  onSelect(id: string | null): void;
  onEvents(events: TimelineEvent[]): void;
  position: number;
  onSeek(ms: number): void;
  running: boolean;
  canPreview: boolean;
  started: boolean;
  onPlay(): void;
  onStop(): void;
  onReset(): void;
  activeOutputs: Record<string, boolean>;
  waveform?: number[];
  waveformDuration?: number;
  waveformLoop?: boolean;
  previewState: string;
  previewElapsedMs: number;
  previewChildren: SimulatorSnapshot["children"];
  onTrigger(id: string): void;
  onRelease(id: string): void;
  onAudioFinished(): void;
  canFinishAudio: boolean;
  enabledTriggers: string[];
  onDistance(id: string, distanceCm: number | null): void;
  distances: SimulatorSnapshot["distances"];
  distanceResetKey: number;
  previewAudio: SimulatorSnapshot["audio"];
  irActivity: SimulatorSnapshot["irActivity"];
}

export function Timeline(props: Props) {
  const { project, state } = props;
  const activeTriggers = project.triggers.filter(
    (trigger) => trigger.enabled !== false,
  );
  const child = isChildState(state);
  const unavailableOutputs = new Map(
    project.outputs.map((output) => [
      output.id,
      outputUnavailableReason(project, state, output.id),
    ]),
  );
  const [distanceText, setDistanceText] = useState<Record<string, string>>({});
  useEffect(() => setDistanceText({}), [props.distanceResetKey]);
  const setDistance = (id: string, text: string) => {
    // Keep partial numbers editable (typing 100 begins with out-of-range 1).
    // The simulator treats incomplete/invalid readings as no echo.
    setDistanceText((current) => ({ ...current, [id]: text }));
    props.onDistance(id, text === "" ? null : Number(text));
  };
  const [zoom, setZoom] = useState(32);
  const [drawActive, setDrawActive] = useState(true);
  const [viewport, setViewport] = useState(600);
  const [labelWidth, setLabelWidth] = useState(
    window.innerWidth <= 980 ? 105 : 133,
  );
  const [draft, setDraft] = useState<{
    outputId: string;
    start: number;
    end: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport(element.clientWidth);
      setLabelWidth(window.innerWidth <= 980 ? 105 : 133);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const width = Math.max(
    viewport - labelWidth,
    (state.durationMs / 1000) * zoom,
  );
  const pixelsPerMs = width / state.durationMs;
  // Nearby point events share rows only when their fixed-width labels fit.
  const irPointWidth = 160;
  const irRowHeight = (state.irEvents ?? []).some(
    (event) => event.macroId !== undefined,
  )
    ? 48
    : 34;
  const canAddIr =
    !!project.ir?.commands.length || !!project.ir?.macros?.length;
  const irRowEnds: number[] = [];
  const irPoints = [...(state.irEvents ?? [])]
    .sort((a, b) => a.atMs - b.atMs)
    .map((event) => {
      const left = event.atMs * pixelsPerMs;
      let row = irRowEnds.findIndex((end) => left >= end);
      if (row < 0) row = irRowEnds.length;
      irRowEnds[row] = left + irPointWidth + 6;
      return { event, row, left };
    });
  const secondWidth = pixelsPerMs * 1000;
  const tickEvery =
    secondWidth > 70 ? 1 : secondWidth > 25 ? 2 : secondWidth > 12 ? 5 : 10;
  useEffect(() => {
    if (!props.running || !scrollRef.current) return;
    const left = props.position * pixelsPerMs;
    if (left > scrollRef.current.scrollLeft + viewport - labelWidth - 60)
      scrollRef.current.scrollLeft = left - 80;
    if (left < scrollRef.current.scrollLeft)
      scrollRef.current.scrollLeft = left;
  }, [props.position, props.running, pixelsPerMs, viewport, labelWidth]);
  const pointTime = (clientX: number, element: HTMLElement) =>
    Math.max(
      0,
      Math.min(
        state.durationMs,
        snap((clientX - element.getBoundingClientRect().left) / pixelsPerMs),
      ),
    );
  const finish = () => {
    const current = draftRef.current;
    if (!current) return;
    let startMs = Math.min(current.start, current.end);
    let endMs = Math.max(current.start, current.end);
    if (endMs === startMs) endMs = Math.min(state.durationMs, startMs + 500);
    if (startMs >= state.durationMs)
      startMs = Math.max(0, state.durationMs - 50);
    if (endMs <= startMs) endMs = startMs + 50;
    const event = {
      id: crypto.randomUUID(),
      outputId: current.outputId,
      startMs,
      endMs,
      active: drawActive,
    };
    props.onEvents([...state.events, event]);
    props.onSelect(event.id);
    setDraft(null);
    draftRef.current = null;
  };
  return (
    <>
      <div className="editor-toolbar">
        <button
          className={props.running ? "selected icon" : "primary icon"}
          disabled={!props.canPreview && !props.running}
          aria-label={props.running ? "Pause preview" : "Play preview"}
          title={
            props.canPreview
              ? "Play / pause desktop preview (Space)"
              : "Fix scene errors before previewing"
          }
          onClick={props.onPlay}
        >
          {props.running ? (
            <Pause size={15} />
          ) : (
            <Play size={15} fill="currentColor" />
          )}
        </button>
        <button
          className="icon"
          aria-label="Stop preview"
          title="Stop preview"
          onClick={props.onStop}
        >
          <Square size={13} />
        </button>
        <button
          className="icon ghost"
          disabled={!props.canPreview}
          aria-label="Reset preview"
          title="Return preview to initial state"
          onClick={props.onReset}
        >
          <RotateCcw size={14} />
        </button>
        <span className="time-display mono" data-testid="playhead-time">
          {time(props.position)}
        </span>
        <span className="muted small toolbar-caption">
          / {time(state.durationMs)}
        </span>
        <div className="grow" />
        <select
          className="draw-value"
          aria-label="Draw output value"
          value={drawActive ? "on" : "off"}
          onChange={(event) => setDrawActive(event.target.value === "on")}
        >
          <option value="on">Draw ON</option>
          <option value="off">Draw OFF</option>
        </select>
        <span className="snap-label">50 ms snap</span>
        <div className="toolbar-separator" />
        <button
          className="icon ghost"
          aria-label="Zoom out"
          disabled={zoom <= 8}
          onClick={() => setZoom((z) => Math.max(8, z / 1.4))}
        >
          <ZoomOut size={16} />
        </button>
        <button
          className="icon ghost"
          aria-label="Zoom in"
          disabled={zoom >= 250}
          onClick={() => setZoom((z) => Math.min(250, z * 1.4))}
        >
          <ZoomIn size={16} />
        </button>
      </div>
      <div className="timeline-scroll" ref={scrollRef} data-testid="timeline">
        <div className="timeline-inner" style={{ width: width + labelWidth }}>
          <div className="ruler-corner">CHANNELS</div>
          <div
            className="timeline-ruler"
            style={{ width }}
            onClick={(event) => {
              props.onSeek(pointTime(event.clientX, event.currentTarget));
              props.onSelect(null);
            }}
          >
            {Array.from(
              { length: Math.ceil(state.durationMs / 1000 / tickEvery) },
              (_, i) => (
                <span
                  key={i}
                  className="ruler-label"
                  style={{ left: i * tickEvery * secondWidth }}
                >
                  {time(i * tickEvery * 1000).slice(0, 5)}
                </span>
              ),
            )}
          </div>
          {!child && (
            <div className="audio-lane">
              <div className="lane-label">
                <Music2 size={13} />
                <span>
                  {state.foregroundTrack
                    ? (project.audio.tracks.find(
                        (t) => t.number === state.foregroundTrack,
                      )?.name ?? `Track ${state.foregroundTrack}`)
                    : "Audio preview"}
                </span>
              </div>
              <div className="waveform">
                {props.waveform?.length ? (
                  Array.from(
                    {
                      length:
                        props.waveformLoop && props.waveformDuration
                          ? Math.min(
                              200,
                              Math.ceil(
                                state.durationMs / props.waveformDuration,
                              ),
                            )
                          : 1,
                    },
                    (_, index) => (
                      <svg
                        key={index}
                        style={{
                          width:
                            (props.waveformDuration || state.durationMs) *
                            pixelsPerMs,
                          flexShrink: 0,
                        }}
                        viewBox={`0 0 ${props.waveform!.length} 100`}
                        preserveAspectRatio="none"
                        aria-label="Audio waveform"
                      >
                        <path
                          d={props
                            .waveform!.map(
                              (peak, i) =>
                                `M${i},${50 - peak * 45}v${Math.max(1, peak * 90)}`,
                            )
                            .join(" ")}
                          stroke="#92d3bb"
                          strokeWidth="1"
                        />
                      </svg>
                    ),
                  )
                ) : (
                  <span className="waveform-placeholder">
                    <Music2 size={15} />
                    {state.foregroundTrack
                      ? "Load the MP3 in Media to see its waveform"
                      : "Assign a track in state settings to preview audio"}
                  </span>
                )}
              </div>
            </div>
          )}
          {!child &&
            (project.ir?.enabled || (state.irEvents?.length ?? 0) > 0) && (
              <div
                className="output-lane ir-lane"
                data-testid="ir-timeline-lane"
                style={{
                  height: Math.max(1, irRowEnds.length) * irRowHeight + 12,
                }}
              >
                <div className="lane-label">
                  <span>IR events</span>
                </div>
                <div
                  className="lane-track"
                  style={{
                    backgroundSize: `${secondWidth * tickEvery}px 100%`,
                  }}
                  onDoubleClick={(event) => {
                    if (
                      event.target === event.currentTarget &&
                      !props.running &&
                      project.ir?.enabled &&
                      canAddIr
                    )
                      props.onAddIr(
                        Math.min(
                          state.durationMs - 50,
                          pointTime(event.clientX, event.currentTarget),
                        ),
                      );
                  }}
                >
                  {irPoints.map(({ event, row, left }) => (
                    <button
                      key={event.id}
                      className={`ir-point ${event.macroId !== undefined ? "ir-macro-point" : ""} ${props.selectedIrEvent === event.id ? "selected" : ""}`}
                      style={{
                        left,
                        top: 6 + row * irRowHeight,
                        width: irPointWidth,
                      }}
                      aria-label={`IR ${irEventName(project, event)} at ${event.atMs / 1000} seconds`}
                      title={`${irEventName(project, event)} · ${time(event.atMs)}${event.macroId !== undefined ? " · Reusable macro" : ""}`}
                      onClick={() => props.onSelectIr(event.id)}
                    >
                      <span aria-hidden="true">◆</span>
                      <span className="ir-point-label">
                        <span>{irEventName(project, event)}</span>
                        {event.macroId !== undefined && (
                          <small>
                            Macro ·{" "}
                            {project.ir?.macros?.find(
                              (macro) => macro.id === event.macroId,
                            )?.steps.length ?? 0}{" "}
                            steps
                          </small>
                        )}
                      </span>
                    </button>
                  ))}
                  {!canAddIr && (
                    <span
                      className="hint"
                      style={{ padding: "10px", display: "block" }}
                    >
                      Learn a named command in Hardware to add IR events.
                    </span>
                  )}
                </div>
              </div>
            )}
          {project.outputs.map((output) => (
            <div
              className={`output-lane ${props.activeOutputs[output.id] ? "active" : ""} ${unavailableOutputs.get(output.id) ? "reserved" : ""}`}
              key={output.id}
              data-testid={`output-lane-${output.id}`}
            >
              <div
                className="lane-label"
                title={`${output.name} · ${output.pin === null ? "No pin available" : `D${output.pin}`} · ${output.activeLow ? "Active low" : "Active high"}`}
              >
                <i
                  className="lane-dot"
                  style={{
                    background: output.color,
                    boxShadow: props.activeOutputs[output.id]
                      ? `0 0 10px ${output.color}`
                      : undefined,
                  }}
                />
                <span>
                  {output.name}
                  {unavailableOutputs.get(output.id) && (
                    <small className="lane-owner">
                      {unavailableOutputs.get(output.id)}
                    </small>
                  )}
                </span>
              </div>
              <div
                className="lane-track"
                aria-disabled={!!unavailableOutputs.get(output.id)}
                title={unavailableOutputs.get(output.id)}
                style={{ backgroundSize: `${secondWidth * tickEvery}px 100%` }}
                onPointerDown={(event) => {
                  if (
                    event.button !== 0 ||
                    props.running ||
                    unavailableOutputs.get(output.id)
                  )
                    return;
                  const ms = pointTime(event.clientX, event.currentTarget);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const next = { outputId: output.id, start: ms, end: ms };
                  draftRef.current = next;
                  setDraft(next);
                  props.onSelect(null);
                }}
                onPointerMove={(event) => {
                  const current = draftRef.current;
                  if (!current || current.outputId !== output.id) return;
                  const next = {
                    ...current,
                    end: pointTime(event.clientX, event.currentTarget),
                  };
                  draftRef.current = next;
                  setDraft(next);
                }}
                onPointerUp={finish}
                onPointerCancel={() => {
                  setDraft(null);
                  draftRef.current = null;
                }}
              >
                {state.events
                  .filter((event) => event.outputId === output.id)
                  .map((event) => (
                    <button
                      key={event.id}
                      className={`event ${event.active === false ? "event-off" : ""} ${props.selectedEvent === event.id ? "selected" : ""}`}
                      style={{
                        left: event.startMs * pixelsPerMs,
                        width: (event.endMs - event.startMs) * pixelsPerMs,
                        background: `${output.color}44`,
                        borderColor: `${output.color}bb`,
                        color: output.color,
                      }}
                      aria-label={`${output.name} event ${event.startMs / 1000} to ${event.endMs / 1000} seconds`}
                      title={`${output.name} ${event.active === false ? "OFF" : "ON"}: ${time(event.startMs)} → ${time(event.endMs)}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => props.onSelect(event.id)}
                    >
                      {(event.endMs - event.startMs) * pixelsPerMs > 55
                        ? `${event.active === false ? "OFF · " : ""}${((event.endMs - event.startMs) / 1000).toFixed((event.endMs - event.startMs) % 100 === 0 ? 1 : 2)} s`
                        : ""}
                    </button>
                  ))}
                {draft?.outputId === output.id && (
                  <div
                    className="event draft"
                    style={{
                      left: Math.min(draft.start, draft.end) * pixelsPerMs,
                      width: Math.max(
                        3,
                        Math.abs(draft.end - draft.start) * pixelsPerMs,
                      ),
                      background: `${output.color}66`,
                      borderColor: output.color,
                    }}
                  />
                )}
              </div>
            </div>
          ))}
          {!project.outputs.length && (
            <div className="empty" style={{ margin: 20 }}>
              Add an output in Hardware to start drawing events.
            </div>
          )}
          <div className="timeline-note">
            <MousePointer2 size={13} />
            Drag in a lane to create an event. Select an event to adjust its
            timing.
            {!child && project.ir?.enabled && (
              <button
                className="ghost small"
                disabled={props.running || !canAddIr}
                title={
                  !canAddIr
                    ? "Learn a named command in Hardware first"
                    : "Add a named command or macro at the playhead; double-click the IR lane to choose another time"
                }
                onClick={() =>
                  props.onAddIr(
                    Math.min(state.durationMs - 50, snap(props.position)),
                  )
                }
              >
                Add IR event
              </button>
            )}
          </div>
          <div
            className="playhead"
            style={{
              left:
                labelWidth +
                Math.min(state.durationMs, props.position) * pixelsPerMs,
            }}
          />
        </div>
      </div>
      <div className="preview-panel">
        <div>
          <div className="section-label">Desktop preview</div>
          <div
            className="preview-state"
            style={{ marginTop: 5 }}
            data-testid="preview-state"
            data-elapsed-ms={props.previewElapsedMs}
          >
            {props.started
              ? props.previewState
              : "Ready · starts in initial state"}
          </div>
          {props.started && (
            <span className="small mono" data-testid="preview-main-time">
              Main timeline · {time(props.previewElapsedMs)}
            </span>
          )}
        </div>
        <div className="toolbar-separator" />
        <div className="preview-buttons">
          {activeTriggers
            .filter((trigger) => !isZonedTrigger(trigger))
            .map((trigger) => (
              <button
                key={trigger.id}
                disabled={
                  !props.started || !props.enabledTriggers.includes(trigger.id)
                }
                title={`Simulate ${trigger.name}`}
                onClick={() => props.onTrigger(trigger.id)}
              >
                {trigger.name}
              </button>
            ))}
          {activeTriggers
            .filter(
              (trigger) =>
                trigger.kind !== "timer" &&
                trigger.kind !== "manual" &&
                !isZonedTrigger(trigger),
            )
            .map((trigger) => (
              <button
                key={`release-${trigger.id}`}
                className="ghost small"
                disabled={!props.started}
                aria-label={`Release ${trigger.name}`}
                onClick={() => props.onRelease(trigger.id)}
              >
                Release {trigger.name}
              </button>
            ))}
          <button
            className="ghost small"
            disabled={!props.started || !props.canFinishAudio}
            onClick={props.onAudioFinished}
          >
            Finish audio
          </button>
        </div>
        <span className="hint">Triggers here affect preview only.</span>
        {props.started && props.previewChildren.length > 0 && (
          <div
            className="preview-children"
            aria-label="Parallel child activity"
          >
            {props.previewChildren.map((child) => (
              <span
                key={child.id}
                className={`badge ${child.phase === "running" ? "green" : "amber"}`}
                data-testid={`preview-child-${child.id}`}
                data-phase={child.phase}
                data-elapsed-ms={child.elapsedMs}
                data-remaining-ms={child.remainingMs}
              >
                {child.name} ·{" "}
                {child.phase === "running" ? "Running" : "Cooldown"} ·{" "}
                {(child.remainingMs / 1000).toFixed(2)} s left
              </span>
            ))}
          </div>
        )}
        {activeTriggers.some((trigger) => trigger.kind === "ultrasonic") && (
          <div className="distance-previews">
            {activeTriggers
              .filter((trigger) => trigger.kind === "ultrasonic")
              .map((trigger) => {
                const reading = props.distances[trigger.id];
                return (
                  <div
                    key={trigger.id}
                    className="distance-preview"
                    role="group"
                    aria-label={`${trigger.name} distance preview`}
                  >
                    <div className="row between">
                      <strong className="small">{trigger.name}</strong>
                      <span
                        className="small"
                        data-testid={`distance-zone-${trigger.id}`}
                      >
                        {isZonedTrigger(trigger)
                          ? `Zone: ${reading?.zoneName ?? "None"}`
                          : "Single threshold"}
                      </span>
                    </div>
                    <div className="row">
                      <label>
                        Distance (cm)
                        <input
                          aria-label={`${trigger.name} preview distance`}
                          type="number"
                          min="2"
                          max="400"
                          step="1"
                          disabled={!props.started}
                          value={
                            distanceText[trigger.id] ??
                            reading?.distanceCm ??
                            ""
                          }
                          placeholder="No echo"
                          onChange={(event) =>
                            setDistance(trigger.id, event.target.value)
                          }
                        />
                      </label>
                      <input
                        aria-label={`${trigger.name} distance slider`}
                        type="range"
                        min="2"
                        max="400"
                        step="1"
                        disabled={!props.started}
                        value={reading?.distanceCm ?? 400}
                        onChange={(event) =>
                          setDistance(trigger.id, event.target.value)
                        }
                      />
                      <button
                        className="small"
                        disabled={!props.started}
                        aria-label={`${trigger.name} no echo`}
                        onClick={() => setDistance(trigger.id, "")}
                      >
                        No echo
                      </button>
                    </div>
                    <p className="hint">
                      {reading?.distanceCm == null
                        ? isZonedTrigger(trigger)
                          ? "No echo: the last zone stays active."
                          : "No echo: the last valid threshold state is held."
                        : `Hold the distance for ${trigger.debounceMs} ms to confirm a change.`}
                    </p>
                  </div>
                );
              })}
            {activeTriggers.some(isZonedTrigger) && (
              <p className="hint">
                Start preview, then choose a starting distance. The first
                reading establishes a zone without firing actions. Move beyond
                its release margin to cross into another zone.
              </p>
            )}
          </div>
        )}
        {props.started && props.previewAudio.length > 0 && (
          <div
            className="preview-audio-levels"
            aria-label="Preview audio levels"
          >
            {props.previewAudio.map((voice) => (
              <span
                key={voice.playerIndex}
                data-testid={`preview-audio-${voice.role}-${voice.playerIndex}`}
                data-volume={voice.volume}
                data-position-ms={voice.positionMs}
                className="badge"
              >
                {voice.role === "ambient" ? "Ambient" : "Foreground"} ·{" "}
                {project.audio.tracks.find(
                  (track) => track.number === voice.track,
                )?.name ?? `Track ${voice.track}`}{" "}
                · {Math.round(voice.volume)}/30
              </span>
            ))}
          </div>
        )}
        {props.started && props.irActivity.length > 0 && (
          <div
            className="preview-ir-log"
            role="log"
            aria-label="Preview IR activity"
          >
            <strong className="small">
              IR preview · no signals transmitted
            </strong>
            {props.irActivity.slice(-8).map((activity) => (
              <div key={activity.sequence} data-testid="preview-ir-activity">
                {time(activity.atMs)} · {activity.name} ·{" "}
                {activity.source === "zone" ? "Distance zone" : "Timeline"}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
