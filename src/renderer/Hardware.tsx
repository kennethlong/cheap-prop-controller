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
import { LIMITS } from "../shared/model";
import type { SceneProject, ValidationIssue } from "../shared/model";
import { resolveAudioTransition } from "../shared";
import { AudioTrimEditor } from "./AudioTrimEditor";

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
}: EditorProps & {
  issues: ValidationIssue[];
  usedBytes: number;
  capacityBytes: number;
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
              <div className="trigger-card" key={trigger.id}>
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
                        })
                      }
                    >
                      <option value="button">Button / foot pad</option>
                      <option value="pir">PIR motion sensor</option>
                      <option value="ultrasonic">HC-SR04 ultrasonic</option>
                    </select>
                  </label>
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
                </div>
                {trigger.kind === "ultrasonic" ? (
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
                  {trigger.kind === "ultrasonic"
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
            Triggers fire on a new activation and must release before firing
            again. Ultrasonic readings use separate enter and release distances.
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
            Events make a channel active. Outside events, it returns to its idle
            value. Active-low affects the electrical pin level; it does not
            reverse the timeline display.
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
  onPreviewTrim(number: number, startMs: number, endMs: number): void;
  onStopTrim(): void;
  onSaveTrim?(number: number, startMs: number, endMs: number): Promise<void>;
}) {
  const [editingTrack, setEditingTrack] = useState<number | null>(null);
  const transition = resolveAudioTransition(project.audio);
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
          <label className="check">
            <input
              type="checkbox"
              checked={project.audio.keepAmbient}
              onChange={(e) =>
                change((next) => {
                  next.audio.keepAmbient = e.target.checked;
                })
              }
            />
            Keep ambient running silently during foreground audio
          </label>
          <p className="hint">
            With this option, ambient keeps its place while muted, then returns
            at its current position using the selected transition. Otherwise, it
            restarts when the scene returns to idle. Keeping ambient requires a
            separate player from foreground audio, including with fade out /
            fade in.
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
