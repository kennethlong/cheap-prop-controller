import { Fragment, useState } from "react";
import {
  Cable,
  Cpu,
  Layers,
  Music2,
  Plus,
  Radio,
  Scissors,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  BOARD_PROFILES,
  allocatePins,
  pinLabel,
  requiredPlayerCount,
} from "../shared/boards";
import { createTrigger, OUTPUT_COLORS } from "../shared/defaults";
import { isZonedTrigger, LIMITS } from "../shared/model";
import type { SceneProject, ValidationIssue } from "../shared/model";
import { resolveAudioTransition } from "../shared";
import { AudioTrimEditor } from "./AudioTrimEditor";
import { DistanceZonesEditor } from "./DistanceZonesEditor";
import { IrLibrary } from "./IrLibrary";

export interface EditorProps {
  project: SceneProject;
  change(recipe: (next: SceneProject) => void): void;
}

export function TrackSelect({
  project,
  value,
  onChange,
  label = "Track",
}: {
  project: SceneProject;
  value: number | null;
  onChange(value: number | null): void;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value ? Number(e.target.value) : null)
        }
      >
        <option value="">None</option>
        {project.audio.tracks.map((track) => (
          <option value={track.number} key={track.number}>
            {String(track.number).padStart(3, "0")} · {track.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Issues({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  const errors = issues.some((issue) => issue.severity === "error");
  return (
    <div className={`validation-box ${errors ? "" : "warning"}`} role="status">
      <strong>
        {errors ? "Resolve before deploying" : "Configuration notes"}
      </strong>
      {issues.slice(0, 8).map((issue, i) => (
        <div key={i}>{issue.message}</div>
      ))}
      {issues.length > 8 && <span>+ {issues.length - 8} more issues</span>}
    </div>
  );
}

export function Hardware({
  project,
  change,
  issues,
  usedBytes,
  capacityBytes,
  notify,
  confirm,
}: EditorProps & {
  issues: ValidationIssue[];
  usedBytes: number;
  capacityBytes: number;
  notify(message: string, error?: boolean): void;
  confirm(message: string, action: () => void): void;
}) {
  const allocation = allocatePins(project);
  const playerCount = requiredPlayerCount(project);
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <h2>Build your controller</h2>
          <p>
            Choose audio and inputs first. The remaining pins become available
            outputs.
          </p>
        </div>
        <span className="badge green">Runs without a computer</span>
      </div>
      <div className="cards-grid">
        <section className="card">
          <div className="card-heading">
            <h3>
              <Cpu size={17} />
              Controller & wiring
            </h3>
          </div>
          <label>
            Microcontroller
            <select
              aria-label="Microcontroller"
              value={project.board}
              onChange={(e) =>
                change((next) => {
                  next.board = e.target.value as SceneProject["board"];
                })
              }
            >
              {Object.values(BOARD_PROFILES).map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Wiring preset
            <select
              aria-label="Wiring preset"
              value={project.wiring}
              onChange={(e) =>
                change((next) => {
                  next.wiring = e.target.value as SceneProject["wiring"];
                })
              }
            >
              <option value="relay-shield">OctoBanger four-relay shield</option>
              <option value="custom">Individual outputs / custom wiring</option>
            </select>
          </label>
          <p className="hint">
            {project.wiring === "relay-shield"
              ? "The first four channels use D7, D6, D5, D4. Additional channels use available pins. Verify your shield uses this pinout."
              : "Pin assignments are generated from this configuration. Use the displayed wiring map when connecting components."}{" "}
            D0 and D1 remain reserved for USB communication.
          </p>
          <p className="hint">
            Changing hardware reallocates pins. Upload the new configuration
            before connecting the revised wiring.
          </p>
        </section>
        <section className="card">
          <div className="card-heading">
            <h3>
              <Layers size={17} />
              Resource budget
            </h3>
            <span className="badge">
              {project.board === "mega" ? "ATmega2560" : "ATmega328P"}
            </span>
          </div>
          <div className="resource-stat">
            <span>MP3 players required</span>
            <strong>{playerCount}</strong>
          </div>
          <div className="resource-stat">
            <span>Triggers configured</span>
            <strong>{project.triggers.length}</strong>
          </div>
          <div className="resource-stat">
            <span>Outputs available for this setup</span>
            <strong>{allocation.maxOutputs}</strong>
          </div>
          <div>
            <div className="row between">
              <span className="muted small">Scene storage</span>
              <span className="mono small">
                {usedBytes} / {capacityBytes} B
              </span>
            </div>
            <div
              className={`capacity-bar ${usedBytes > capacityBytes ? "over" : ""}`}
            >
              <div
                style={{
                  width: `${Math.min(100, (usedBytes / capacityBytes) * 100)}%`,
                }}
              />
            </div>
            <p className="hint" style={{ marginTop: 9 }}>
              Capacity includes all states, events, triggers, and audio
              settings. Longer gaps between events consume no extra space.
            </p>
          </div>
        </section>
        <IrLibrary
          project={project}
          change={change}
          notify={notify}
          confirm={confirm}
        />
        <section className="card full">
          <div className="card-heading">
            <h3>
              <Radio size={17} />
              Triggers{" "}
              <span className="muted">
                {project.triggers.length} / {LIMITS.triggers}
              </span>
            </h3>
            <button
              disabled={project.triggers.length >= LIMITS.triggers}
              onClick={() =>
                change((next) => {
                  next.triggers.push(
                    createTrigger(
                      crypto.randomUUID(),
                      `Trigger ${next.triggers.length + 1}`,
                    ),
                  );
                })
              }
            >
              <Plus size={14} />
              Add trigger
            </button>
          </div>
          <div className="trigger-grid">
            {project.triggers.map((trigger, index) => (
              <div
                className={`trigger-card ${isZonedTrigger(trigger) ? "zoned-trigger" : ""}`}
                key={trigger.id}
              >
                <div className="row">
                  <input
                    aria-label={`Trigger ${index + 1} name`}
                    value={trigger.name}
                    onChange={(e) =>
                      change((next) => {
                        next.triggers[index].name = e.target.value;
                      })
                    }
                  />
                  <button
                    className="icon ghost"
                    aria-label={`Delete trigger ${trigger.name}`}
                    onClick={() =>
                      change((next) => {
                        next.triggers.splice(index, 1);
                        next.states.forEach((state) => {
                          state.transitions = state.transitions.filter(
                            (t) => t.triggerId !== trigger.id,
                          );
                        });
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="field-grid">
                  <label>
                    Sensor type
                    <select
                      aria-label={`Trigger ${index + 1} type`}
                      value={trigger.kind}
                      onChange={(e) =>
                        change((next) => {
                          const t = next.triggers[index];
                          t.kind = e.target.value as typeof t.kind;
                          t.activeLow = t.kind === "button";
                          t.pullup = t.kind === "button";
                          if (t.kind === "timer") {
                            t.timerIntervalMs ??= 30000;
                            t.timerResetOnTrigger ??= false;
                            next.states.forEach((state) => {
                              state.transitions = state.transitions.filter(
                                (transition) =>
                                  transition.triggerId !== t.id ||
                                  transition.edge !== "release",
                              );
                            });
                          }
                        })
                      }
                    >
                      <option value="button">Button / foot pad</option>
                      <option value="pir">PIR motion sensor</option>
                      <option value="ultrasonic">HC-SR04 ultrasonic</option>
                      <option value="timer">Periodic timer · no pin</option>
                    </select>
                  </label>
                  {trigger.kind !== "timer" && (
                    <label>
                      Debounce / dwell (ms)
                      <input
                        aria-label={`Trigger ${index + 1} debounce`}
                        type="number"
                        min="0"
                        max="5000"
                        step="50"
                        value={trigger.debounceMs}
                        onChange={(e) =>
                          change((next) => {
                            next.triggers[index].debounceMs = Number(
                              e.target.value,
                            );
                          })
                        }
                      />
                    </label>
                  )}
                </div>
                {trigger.kind === "timer" ? (
                  <>
                    <label>
                      Interval (seconds)
                      <input
                        aria-label={`Trigger ${index + 1} timer seconds`}
                        type="number"
                        min="0.05"
                        max="3276.75"
                        step="0.05"
                        value={(trigger.timerIntervalMs ?? 30000) / 1000}
                        onChange={(e) =>
                          change((next) => {
                            next.triggers[index].timerIntervalMs =
                              Math.round(Number(e.target.value) * 20) * 50;
                          })
                        }
                      />
                    </label>
                    <label className="check">
                      <input
                        aria-label={`Trigger ${index + 1} restart timer`}
                        type="checkbox"
                        checked={trigger.timerResetOnTrigger ?? false}
                        onChange={(e) =>
                          change((next) => {
                            next.triggers[index].timerResetOnTrigger =
                              e.target.checked;
                          })
                        }
                      />
                      Restart countdown when another input activates
                    </label>
                    <p className="hint">
                      Repeats while the controller is armed. Arm / reset starts
                      a full interval; state changes keep the countdown running.
                    </p>
                  </>
                ) : trigger.kind === "ultrasonic" ? (
                  <>
                    <label>
                      Distance behavior
                      <select
                        aria-label={`Trigger ${index + 1} distance behavior`}
                        value={trigger.distanceMode ?? "threshold"}
                        onChange={(event) =>
                          change((next) => {
                            const sensor = next.triggers[index];
                            sensor.distanceMode = event.target.value as
                              "threshold" | "zones";
                            if (
                              sensor.distanceMode === "zones" &&
                              !sensor.zones?.length
                            ) {
                              const target =
                                next.states
                                  .flatMap((state) => state.transitions)
                                  .find(
                                    (transition) =>
                                      transition.triggerId === sensor.id,
                                  )?.targetStateId ?? next.initialStateId;
                              sensor.zones = [
                                {
                                  id: crypto.randomUUID(),
                                  name: "Near",
                                  minCm: 2,
                                  maxCm: 100,
                                  hysteresisCm: 10,
                                  onEnter: [
                                    {
                                      id: crypto.randomUUID(),
                                      kind: "state",
                                      stateId: target,
                                    },
                                  ],
                                  onExit: [],
                                },
                              ];
                            }
                          })
                        }
                      >
                        <option value="threshold">Single threshold</option>
                        <option value="zones">Distance zones</option>
                      </select>
                    </label>
                    {isZonedTrigger(trigger) ? (
                      <DistanceZonesEditor
                        project={project}
                        change={change}
                        triggerIndex={index}
                      />
                    ) : (
                      <div className="field-grid">
                        <label>
                          Enter distance (cm)
                          <input
                            type="number"
                            min="2"
                            max="400"
                            value={trigger.thresholdCm}
                            onChange={(e) =>
                              change((next) => {
                                next.triggers[index].thresholdCm = Number(
                                  e.target.value,
                                );
                              })
                            }
                          />
                        </label>
                        <label>
                          Release margin (cm)
                          <input
                            type="number"
                            min="1"
                            max="100"
                            value={trigger.hysteresisCm}
                            onChange={(e) =>
                              change((next) => {
                                next.triggers[index].hysteresisCm = Number(
                                  e.target.value,
                                );
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="row wrap">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={trigger.activeLow}
                        onChange={(e) =>
                          change((next) => {
                            next.triggers[index].activeLow = e.target.checked;
                          })
                        }
                      />
                      Active low
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={trigger.pullup}
                        onChange={(e) =>
                          change((next) => {
                            next.triggers[index].pullup = e.target.checked;
                          })
                        }
                      />
                      Internal pull-up
                    </label>
                  </div>
                )}
                <div className="pin-label">
                  {trigger.kind === "timer"
                    ? "SOFTWARE TIMER · No GPIO used"
                    : trigger.kind === "ultrasonic"
                      ? `TRIG ${pinLabel(project.board, trigger.pin)} · ECHO ${pinLabel(project.board, trigger.echoPin)}`
                      : `INPUT ${pinLabel(project.board, trigger.pin)}`}
                </div>
              </div>
            ))}
          </div>
          {!project.triggers.length && (
            <div className="empty">
              Add a sensor or manual trigger, then connect it to a state
              transition.
            </div>
          )}
          <p className="hint">
            Sensor transitions can respond to activation or release. Periodic
            timers fire without consuming a pin. Ultrasonic sensors can use a
            single threshold or multiple distance zones with their own actions.
          </p>
        </section>
        <section className="card full">
          <div className="card-heading">
            <h3>
              <SlidersHorizontal size={17} />
              Prop outputs{" "}
              <span className="muted">
                {project.outputs.length} / {allocation.maxOutputs}
              </span>
            </h3>
            <button
              disabled={
                project.outputs.length >= allocation.maxOutputs ||
                project.outputs.length >= LIMITS.outputs
              }
              onClick={() =>
                change((next) => {
                  next.outputs.push({
                    id: crypto.randomUUID(),
                    name: `Output ${next.outputs.length + 1}`,
                    pin: null,
                    activeLow: false,
                    idleActive: false,
                    color:
                      OUTPUT_COLORS[next.outputs.length % OUTPUT_COLORS.length],
                  });
                })
              }
            >
              <Plus size={14} />
              Add output
            </button>
          </div>
          <table className="config-table">
            <thead>
              <tr>
                <th>Color</th>
                <th>Channel name</th>
                <th>Pin</th>
                <th>Active low</th>
                <th>Active at idle</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.outputs.map((output, index) => (
                <tr key={output.id}>
                  <td>
                    <input
                      aria-label={`${output.name} color`}
                      type="color"
                      value={output.color}
                      onChange={(e) =>
                        change((next) => {
                          next.outputs[index].color = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Output ${index + 1} name`}
                      value={output.name}
                      onChange={(e) =>
                        change((next) => {
                          next.outputs[index].name = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td className="pin-label">
                    {pinLabel(project.board, output.pin)}
                  </td>
                  <td>
                    <input
                      aria-label={`${output.name} active low`}
                      type="checkbox"
                      checked={output.activeLow}
                      onChange={(e) =>
                        change((next) => {
                          next.outputs[index].activeLow = e.target.checked;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${output.name} active at idle`}
                      type="checkbox"
                      checked={output.idleActive}
                      onChange={(e) =>
                        change((next) => {
                          next.outputs[index].idleActive = e.target.checked;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="icon ghost"
                      aria-label={`Delete output ${output.name}`}
                      onClick={() =>
                        change((next) => {
                          next.outputs.splice(index, 1);
                          next.states.forEach((state) => {
                            state.events = state.events.filter(
                              (event) => event.outputId !== output.id,
                            );
                          });
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Events explicitly turn a channel ON or OFF. Outside events, it
            returns to its idle value. Active-low affects the electrical pin
            level; it does not reverse the timeline display.
          </p>
        </section>
        <section className="card full">
          <div className="card-heading">
            <h3>
              <Cable size={17} />
              Audio device wiring
            </h3>
            <span className="badge">
              {playerCount} module{playerCount === 1 ? "" : "s"}
            </span>
          </div>
          {project.audio.players.length ? (
            <table className="config-table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Type</th>
                  <th>Controller TX → module RX</th>
                  <th>Controller RX ← module TX</th>
                  <th>Playback feedback</th>
                </tr>
              </thead>
              <tbody>
                {project.audio.players.map((player, index) => (
                  <tr key={player.id}>
                    <td>Player {index + 1}</td>
                    <td>
                      <select
                        aria-label={`Player ${index + 1} type`}
                        value={player.kind}
                        onChange={(e) =>
                          change((next) => {
                            next.audio.players[index].kind = e.target
                              .value as typeof player.kind;
                          })
                        }
                      >
                        <option value="dfplayer">DFPlayer Mini</option>
                        <option value="yx5300">YX5300 / Catalex</option>
                      </select>
                    </td>
                    <td className="pin-label">
                      {pinLabel(project.board, player.txPin)}
                    </td>
                    <td className="pin-label">
                      {pinLabel(project.board, player.rxPin)}
                    </td>
                    <td>
                      <label className="check">
                        <input
                          type="checkbox"
                          aria-label={`Player ${index + 1} BUSY feedback`}
                          checked={!!player.feedback}
                          onChange={(e) =>
                            change((next) => {
                              if (e.target.checked)
                                next.audio.players[index].feedback = {
                                  pin: null,
                                  activeLow: true,
                                };
                              else delete next.audio.players[index].feedback;
                            })
                          }
                        />
                        Use BUSY pin
                      </label>
                      {player.feedback && (
                        <>
                          <span className="pin-label">
                            BUSY →{" "}
                            {pinLabel(project.board, player.feedback.pin)}
                          </span>
                          <label className="check">
                            <input
                              type="checkbox"
                              aria-label={`Player ${index + 1} BUSY active low`}
                              checked={player.feedback.activeLow}
                              onChange={(e) =>
                                change((next) => {
                                  next.audio.players[
                                    index
                                  ].feedback!.activeLow = e.target.checked;
                                })
                              }
                            />
                            Low while playing
                          </label>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">
              Add files in Media and assign tracks to states to configure MP3
              devices.
            </p>
          )}
          <p className="hint">
            Optional BUSY feedback uses one input per player and reports
            playback in the physical controller panel. Enable it only when your
            module exposes a documented playback-status pin. DFPlayer Mini
            normally uses active-low BUSY; many YX5300 boards do not expose one.
            A missing or incorrectly wired signal can prevent an audio-finished
            transition.
          </p>
          <p className="hint">
            Player count follows simultaneous playback needs. Fade out / fade in
            can switch tracks on one player. Crossfading uses two players;
            continuous ambient plus foreground crossfades uses three. Mix audio
            using suitable mixer inputs, never directly join speaker outputs.
          </p>
        </section>
        {issues.length > 0 && (
          <div className="full" style={{ gridColumn: "1 / -1" }}>
            <Issues issues={issues} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Media({
  project,
  change,
  onImport,
  onReplace,
  onRemove,
  onExport,
  onRetry,
  loaded,
  waveforms,
  durations,
  audioEditKeys,
  onPreviewTrim,
  onStopTrim,
  onSaveTrim,
}: EditorProps & {
  onImport(): void;
  onReplace(number: number): void;
  onRemove(number: number): void;
  onExport(): void;
  onRetry(): void;
  loaded: Set<number>;
  waveforms: Record<number, number[]>;
  durations: Record<number, number>;
  audioEditKeys: Record<number, number>;
  onPreviewTrim(number: number, startMs: number, endMs: number): void;
  onStopTrim(): void;
  onSaveTrim?(number: number, startMs: number, endMs: number): Promise<void>;
}) {
  const [editingTrack, setEditingTrack] = useState<number | null>(null);
  const transition = resolveAudioTransition(project.audio);
  const ambientBehavior = !project.audio.keepAmbient
    ? "stop"
    : (project.audio.ambientMixVolume ?? 0) > 0
      ? "mix"
      : "silent";
  return (
    <div className="content-page">
      <div className="page-heading">
        <div>
          <h2>Sound makes the scene</h2>
          <p>
            Keep a library of tracks, then assign foreground audio in each
            state.
          </p>
        </div>
        <button className="primary" onClick={onImport}>
          <Plus size={15} />
          Add MP3
        </button>
      </div>
      <div className="cards-grid">
        <section className="card">
          <div className="card-heading">
            <h3>
              <Music2 size={17} />
              Ambient & transitions
            </h3>
          </div>
          <TrackSelect
            project={project}
            value={project.audio.ambientTrack}
            label="Ambient track"
            onChange={(value) =>
              change((next) => {
                next.audio.ambientTrack = value;
              })
            }
          />
          <div className="field-grid">
            <label>
              Ambient volume (0–30)
              <input
                type="number"
                min="0"
                max="30"
                value={project.audio.ambientVolume}
                onChange={(e) =>
                  change((next) => {
                    next.audio.ambientVolume = Number(e.target.value);
                  })
                }
              />
            </label>
            <label>
              Audio transition
              <select
                aria-label="Audio transition"
                value={transition.mode}
                onChange={(e) =>
                  change((next) => {
                    next.audio.transitionMode = e.target
                      .value as typeof transition.mode;
                    if (next.audio.transitionMode === "fade-through") {
                      next.audio.fadeOutMs ??= 250;
                      next.audio.fadeInMs ??= 250;
                    } else if (
                      next.audio.transitionMode === "crossfade" &&
                      next.audio.fadeMs === 0
                    ) {
                      next.audio.fadeMs = 500;
                    }
                  })
                }
              >
                <option value="cut">Hard cut</option>
                <option value="crossfade">Crossfade</option>
                <option value="fade-through">Fade out / fade in</option>
              </select>
            </label>
          </div>
          {transition.mode === "crossfade" && (
            <label>
              Crossfade (ms)
              <input
                aria-label="Crossfade milliseconds"
                type="number"
                min="0"
                max="10000"
                step="50"
                value={project.audio.fadeMs}
                onChange={(e) =>
                  change((next) => {
                    next.audio.fadeMs = Number(e.target.value);
                  })
                }
              />
            </label>
          )}
          {transition.mode === "fade-through" && (
            <div className="field-grid">
              <label>
                Fade out (ms)
                <input
                  aria-label="Fade-out milliseconds"
                  type="number"
                  min="0"
                  max="12750"
                  step="50"
                  value={transition.fadeOutMs}
                  onChange={(e) =>
                    change((next) => {
                      next.audio.fadeOutMs = Number(e.target.value);
                    })
                  }
                />
              </label>
              <label>
                Fade in (ms)
                <input
                  aria-label="Fade-in milliseconds"
                  type="number"
                  min="0"
                  max="12750"
                  step="50"
                  value={transition.fadeInMs}
                  onChange={(e) =>
                    change((next) => {
                      next.audio.fadeInMs = Number(e.target.value);
                    })
                  }
                />
              </label>
            </div>
          )}
          <p className="hint">
            {transition.mode === "fade-through"
              ? "Fade out / fade in lowers the current track to silence, switches tracks on the same player, then raises the new track. The silent gap also includes the module's track-loading time."
              : transition.mode === "crossfade"
                ? "Crossfade overlaps the outgoing and incoming tracks on separate players. A zero-duration crossfade switches tracks immediately."
                : "Hard cut switches tracks immediately, with no volume ramp."}{" "}
            Output timelines start immediately when a state changes; they do not
            wait for audio fades.
          </p>
          <label>
            Ambient during foreground
            <select
              aria-label="Ambient during foreground"
              value={ambientBehavior}
              onChange={(e) =>
                change((next) => {
                  next.audio.keepAmbient = e.target.value !== "stop";
                  if (e.target.value === "silent")
                    next.audio.ambientMixVolume = 0;
                  else if (e.target.value === "mix")
                    next.audio.ambientMixVolume =
                      (next.audio.ambientMixVolume ?? 0) > 0
                        ? next.audio.ambientMixVolume
                        : 10;
                })
              }
            >
              <option value="stop">Stop ambient</option>
              <option value="silent">Keep running silently</option>
              <option value="mix">Mix with foreground</option>
            </select>
          </label>
          {ambientBehavior === "mix" && (
            <label>
              Ambient mixed volume (1–30)
              <input
                aria-label="Ambient mixed volume (1–30)"
                type="number"
                min="1"
                max="30"
                step="1"
                value={project.audio.ambientMixVolume}
                onChange={(e) =>
                  change((next) => {
                    next.audio.ambientMixVolume = Math.max(
                      1,
                      Number(e.target.value),
                    );
                  })
                }
              />
            </label>
          )}
          <p className="hint">
            Keeping ambient silently or mixed preserves its playback position.
            It returns to normal ambient volume in states with no foreground
            track, including idle. Stop ambient restarts it when it returns.
            Persistent ambient and foreground audio need two players; foreground
            crossfades with persistent ambient need three. With fade out / fade
            in, mixed ambient stays audible and changes volume independently
            while foreground tracks switch.
          </p>
          <div className="resource-stat">
            <span>Players required by these settings</span>
            <strong>{requiredPlayerCount(project)}</strong>
          </div>
          <p className="hint">
            Desktop preview uses your computer's audio. Cheap MP3 module startup
            and volume steps may differ; confirm transitions on the bench.
          </p>
        </section>
        <section className="card">
          <div className="card-heading">
            <h3>Preparing the SD cards</h3>
            <span className="badge">MP3 modules</span>
          </div>
          <p className="hint">
            Each player needs the same track library. Export media creates a
            folder named 01 containing numbered MP3 files: 001.mp3, 002.mp3, and
            so on. Copy that folder to each card. The project retains original
            filenames for editing. Applied trims are rendered into the exported
            files, so the players start at your chosen beginning and stop at
            your chosen end.
          </p>
          <button
            disabled={!project.audio.tracks.length || !window.cpc}
            onClick={onExport}
          >
            Export files for MP3 cards
          </button>
          <p className="hint">
            Audio lives on the player cards; the scene configuration lives in
            the Arduino's onboard storage. Track count does not determine player
            count.
          </p>
        </section>
        <section className="card full">
          <div className="card-heading">
            <h3>Track library</h3>
            <span className="muted small">
              {project.audio.tracks.length} files
            </span>
          </div>
          <p className="hint">
            Saving the project copies original MP3s and applied trims into a
            sounds folder beside the project file. Keep that folder with your
            project when moving it to another computer.
          </p>
          {project.audio.tracks.map((track) => (
            <Fragment key={track.number}>
              <div className="media-track">
                <div className="track-number">
                  {String(track.number).padStart(3, "0")}
                </div>
                <div className="grow">
                  <div className="media-track-name">{track.name}</div>
                  <div className="track-path" title={track.path}>
                    {track.path ?? "No file linked"}
                  </div>
                  {track.trimStartMs || track.trimEndMs != null ? (
                    <div className="track-trim-summary">
                      Trim: {((track.trimStartMs ?? 0) / 1000).toFixed(3)} s
                      {" → "}
                      {track.trimEndMs == null
                        ? "end of track"
                        : `${(track.trimEndMs / 1000).toFixed(3)} s`}
                    </div>
                  ) : null}
                </div>
                <span
                  className={`badge ${loaded.has(track.number) ? "green" : ""}`}
                >
                  {loaded.has(track.number) ? "Preview ready" : "Not loaded"}
                </span>
                {!loaded.has(track.number) && track.path && window.cpc && (
                  <button className="ghost small" onClick={onRetry}>
                    Retry
                  </button>
                )}
                <button
                  className="ghost small"
                  aria-label={`Trim audio for track ${track.number}`}
                  aria-expanded={editingTrack === track.number}
                  onClick={() => {
                    onStopTrim();
                    setEditingTrack(
                      editingTrack === track.number ? null : track.number,
                    );
                  }}
                >
                  <Scissors size={14} />
                  {editingTrack === track.number
                    ? "Close editor"
                    : "Trim audio"}
                </button>
                <button
                  className="ghost small"
                  aria-label={`Replace or link file for track ${track.number}`}
                  data-testid={`replace-track-${track.number}`}
                  onClick={() => onReplace(track.number)}
                >
                  {loaded.has(track.number) ? "Replace file" : "Link file"}
                </button>
                <button
                  className="icon ghost"
                  aria-label={`Remove track ${track.name}`}
                  onClick={() => onRemove(track.number)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {editingTrack === track.number && (
                <AudioTrimEditor
                  key={audioEditKeys[track.number] ?? 0}
                  track={track}
                  waveform={waveforms[track.number]}
                  durationMs={durations[track.number]}
                  loaded={loaded.has(track.number)}
                  onApply={(startMs, endMs) =>
                    change((next) => {
                      const selected = next.audio.tracks.find(
                        (item) => item.number === track.number,
                      );
                      if (!selected) return;
                      selected.trimStartMs = startMs;
                      selected.trimEndMs = endMs;
                      delete selected.trimmedPath;
                      if (durations[track.number])
                        selected.durationMs = Math.round(
                          durations[track.number],
                        );
                    })
                  }
                  onPreview={(startMs, endMs) =>
                    onPreviewTrim(track.number, startMs, endMs)
                  }
                  onStop={onStopTrim}
                  onSave={
                    onSaveTrim
                      ? (startMs, endMs) =>
                          onSaveTrim(track.number, startMs, endMs)
                      : undefined
                  }
                />
              )}
            </Fragment>
          ))}
          {!project.audio.tracks.length && (
            <div className="empty">
              <Music2 size={27} style={{ marginBottom: 10 }} />
              <p>No audio files yet.</p>
              <p className="small">
                Add an MP3, or build a scene with outputs only.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
