import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { isZonedTrigger, LIMITS } from "../shared/model";
import { isChildState } from "../shared";
import type { DistanceZone, SceneProject, ZoneAction } from "../shared/model";
import type { EditorProps } from "./Hardware";

/** Keep edits inside App.change so pin allocation, undo and saving stay shared. */
export function DistanceZonesEditor({
  project,
  change,
  triggerIndex,
}: EditorProps & { triggerIndex: number }) {
  const trigger = project.triggers[triggerIndex];
  const zones = trigger.zones ?? [];
  const activeZones = project.triggers
    .filter(isZonedTrigger)
    .flatMap((item) => item.zones ?? []);
  const actionCount = activeZones.reduce(
    (count, zone) => count + zone.onEnter.length + zone.onExit.length,
    0,
  );
  const editZone = (id: string, recipe: (zone: DistanceZone) => void) =>
    change((next) => {
      const zone = next.triggers[triggerIndex].zones?.find(
        (item) => item.id === id,
      );
      if (zone) recipe(zone);
    });
  const addZone = () =>
    change((next) => {
      const sensor = next.triggers[triggerIndex];
      const existing = sensor.zones ?? [];
      // Prefer an unused interval; if all distances are assigned, leave bounds
      // repairable and let the normal validation explain the overlap.
      let start = 2;
      for (const zone of [...existing].sort((a, b) => a.minCm - b.minCm)) {
        if (zone.minCm > start) break;
        start = Math.max(start, zone.maxCm + 1);
      }
      start = Math.min(start, 400);
      const following = existing
        .filter((zone) => zone.minCm > start)
        .sort((a, b) => a.minCm - b.minCm)[0];
      sensor.zones = [
        ...existing,
        {
          id: crypto.randomUUID(),
          name: `Zone ${existing.length + 1}`,
          minCm: start,
          maxCm: Math.min(
            400,
            start + 99,
            following ? following.minCm - 1 : 400,
          ),
          hysteresisCm: 10,
          onEnter: [],
          onExit: [],
        },
      ];
    });
  return (
    <div className="distance-zones">
      <p className="hint">
        All zones share this sensor's TRIG and ECHO pins. Bounds include both
        endpoints and must not overlap; gaps are allowed. A new zone must remain
        stable for the dwell time above. The release margin keeps the current
        zone active near a boundary. Missing echoes are ignored.
      </p>
      {zones.map((zone, index) => (
        <section
          className="distance-zone"
          key={zone.id}
          aria-label={`${trigger.name} zone ${index + 1}`}
        >
          <div className="row">
            <label className="grow">
              Zone name
              <input
                aria-label={`Zone ${index + 1} name`}
                value={zone.name}
                onChange={(event) =>
                  editZone(zone.id, (next) => {
                    next.name = event.target.value;
                  })
                }
              />
            </label>
            <button
              className="icon ghost"
              aria-label={`Delete zone ${zone.name}`}
              onClick={() =>
                change((next) => {
                  next.triggers[triggerIndex].zones = zones.filter(
                    (item) => item.id !== zone.id,
                  );
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="zone-bounds">
            <label>
              From (cm)
              <input
                aria-label={`Zone ${index + 1} minimum distance`}
                type="number"
                min="2"
                max="400"
                step="1"
                value={zone.minCm}
                onChange={(event) =>
                  editZone(zone.id, (next) => {
                    next.minCm = Number(event.target.value);
                  })
                }
              />
            </label>
            <label>
              Through (cm)
              <input
                aria-label={`Zone ${index + 1} maximum distance`}
                type="number"
                min="2"
                max="400"
                step="1"
                value={zone.maxCm}
                onChange={(event) =>
                  editZone(zone.id, (next) => {
                    next.maxCm = Number(event.target.value);
                  })
                }
              />
            </label>
            <label>
              Release margin (cm)
              <input
                aria-label={`Zone ${index + 1} release margin`}
                type="number"
                min="1"
                max="255"
                step="1"
                value={zone.hysteresisCm}
                onChange={(event) =>
                  editZone(zone.id, (next) => {
                    next.hysteresisCm = Number(event.target.value);
                  })
                }
              />
            </label>
          </div>
          <div className="zone-action-columns">
            {(["onEnter", "onExit"] as const).map((edge) => (
              <ZoneActions
                key={edge}
                project={project}
                actions={zone[edge]}
                label={edge === "onEnter" ? "On enter" : "On exit"}
                canAdd={actionCount < LIMITS.zoneActions}
                onChange={(actions) =>
                  editZone(zone.id, (next) => {
                    next[edge] = actions;
                  })
                }
              />
            ))}
          </div>
        </section>
      ))}
      <button disabled={activeZones.length >= LIMITS.zones} onClick={addZone}>
        <Plus size={14} />
        Add distance zone
      </button>
      <p className="hint">
        The first valid reading establishes a starting zone without firing
        actions. Crossing zones runs the old zone's exit actions, then the new
        zone's enter actions, in order. Volume changes affect currently playing
        audio without restarting it; changing state restores that state's audio
        settings.
      </p>
    </div>
  );
}

function ZoneActions({
  project,
  actions,
  label,
  onChange,
  canAdd,
}: {
  project: SceneProject;
  actions: ZoneAction[];
  label: string;
  onChange(actions: ZoneAction[]): void;
  canAdd: boolean;
}) {
  const edit = (index: number, action: ZoneAction) =>
    onChange(
      actions.map((current, position) =>
        position === index ? action : current,
      ),
    );
  const move = (index: number, offset: number) => {
    const next = [...actions];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };
  return (
    <div className="zone-actions" role="group" aria-label={`${label} actions`}>
      <strong className="small">{label}</strong>
      {actions.map((action, index) => (
        <div className="zone-action" key={action.id}>
          <div className="row">
            <span className="muted small">{index + 1}.</span>
            <select
              aria-label={`${label} action ${index + 1} type`}
              value={action.kind}
              onChange={(event) =>
                edit(
                  index,
                  event.target.value === "state"
                    ? {
                        id: action.id,
                        kind: "state",
                        stateId: project.initialStateId,
                      }
                    : event.target.value === "ir"
                      ? {
                          id: action.id,
                          kind: "ir",
                          commandId: project.ir?.commands[0]?.id ?? "",
                        }
                      : {
                          id: action.id,
                          kind: "volume",
                          target: "ambient",
                          volume: 15,
                          fadeMs: 250,
                        },
                )
              }
            >
              <option value="state">Change state</option>
              <option value="volume">Set volume</option>
              <option
                value="ir"
                disabled={!project.ir?.enabled || !project.ir.commands.length}
              >
                Send IR command
              </option>
            </select>
            <button
              className="icon ghost"
              disabled={index === 0}
              aria-label={`Move ${label.toLowerCase()} action ${index + 1} up`}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={13} />
            </button>
            <button
              className="icon ghost"
              disabled={index === actions.length - 1}
              aria-label={`Move ${label.toLowerCase()} action ${index + 1} down`}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={13} />
            </button>
            <button
              className="icon ghost"
              aria-label={`Delete ${label.toLowerCase()} action ${index + 1}`}
              onClick={() =>
                onChange(actions.filter((_, position) => position !== index))
              }
            >
              <Trash2 size={13} />
            </button>
          </div>
          {action.kind === "state" ? (
            <label>
              Go to state
              <select
                aria-label={`${label} action ${index + 1} state`}
                value={action.stateId}
                onChange={(event) =>
                  edit(index, { ...action, stateId: event.target.value })
                }
              >
                {project.states
                  .filter((state) => !isChildState(state))
                  .map((state) => (
                    <option key={state.id} value={state.id}>
                      {state.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : action.kind === "ir" ? (
            <label>
              IR command
              <select
                aria-label={`${label} action ${index + 1} IR command`}
                value={action.commandId}
                onChange={(event) =>
                  edit(index, { ...action, commandId: event.target.value })
                }
              >
                {!project.ir?.commands.some(
                  (command) => command.id === action.commandId,
                ) && <option value={action.commandId}>Missing command</option>}
                {(project.ir?.commands ?? []).map((command) => (
                  <option key={command.id} value={command.id}>
                    {command.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                Audio target
                <select
                  aria-label={`${label} action ${index + 1} audio target`}
                  value={action.target}
                  onChange={(event) =>
                    edit(index, {
                      ...action,
                      target: event.target.value as "ambient" | "foreground",
                    })
                  }
                >
                  <option value="ambient">Ambient</option>
                  <option value="foreground">Foreground</option>
                </select>
              </label>
              <div className="field-grid">
                <label>
                  Volume (0–30)
                  <input
                    aria-label={`${label} action ${index + 1} volume`}
                    type="number"
                    min="0"
                    max="30"
                    step="1"
                    value={action.volume}
                    onChange={(event) =>
                      edit(index, {
                        ...action,
                        volume: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Fade (ms)
                  <input
                    aria-label={`${label} action ${index + 1} fade`}
                    type="number"
                    min="0"
                    max="12750"
                    step="50"
                    value={action.fadeMs}
                    onChange={(event) =>
                      edit(index, {
                        ...action,
                        fadeMs: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </>
          )}
        </div>
      ))}
      {!actions.length && <span className="hint">No action</span>}
      {(!project.ir?.enabled || !project.ir.commands.length) && (
        <span className="hint">
          Enable IR and learn a command in Hardware to add an IR action.
        </span>
      )}
      <button
        className="ghost small"
        disabled={!canAdd}
        onClick={() =>
          onChange([
            ...actions,
            {
              id: crypto.randomUUID(),
              kind: "state",
              stateId: project.initialStateId,
            },
          ])
        }
      >
        <Plus size={13} />
        Add {label.toLowerCase()} action
      </button>
    </div>
  );
}
