import { Plus, Trash2 } from "lucide-react";
import {
  LIMITS,
  irCommandDurationMs,
  irMacroDurationMs,
  validateIrCommand,
  type IrMacro,
} from "../shared";
import type { EditorProps } from "./Hardware";

export function IrMacrosEditor({
  project,
  change,
  confirm,
  disabled,
}: EditorProps & {
  confirm(message: string, action: () => void): void;
  disabled: boolean;
}) {
  const commands = project.ir?.commands ?? [];
  const macros = project.ir?.macros ?? [];
  const update = (id: string, recipe: (macro: IrMacro) => void) =>
    change((next) => {
      const macro = next.ir?.macros?.find((item) => item.id === id);
      if (macro) recipe(macro);
    });
  return (
    <section className="ir-macros" aria-label="IR macros">
      <div className="row between">
        <h3>Reusable IR macros</h3>
        <span className="badge">
          {macros.length} / {LIMITS.irMacros}
        </span>
      </div>
      <p className="hint">
        Learn and name remote buttons above, then combine them into one timeline
        entry. For example: On at 0 s, Brighten at 1 s, Off at 8 s. Each step
        uses its named command’s complete-press count and gap. Offsets are
        relative to the macro’s start; the transmitter finishes each command
        before starting the next. Steps run in offset order; matching offsets
        keep the order shown. Changing state or stopping cancels the remaining
        steps.
      </p>
      {!commands.length && (
        <p className="hint">
          Capture and save a remote command before creating a macro.
        </p>
      )}
      <button
        className="small"
        disabled={
          disabled || !commands.length || macros.length >= LIMITS.irMacros
        }
        onClick={() =>
          change((next) => {
            next.ir!.macros ??= [];
            next.ir!.macros.push({
              id: crypto.randomUUID(),
              name: `IR macro ${macros.length + 1}`,
              steps: [
                { id: crypto.randomUUID(), atMs: 0, commandId: commands[0].id },
              ],
            });
          })
        }
      >
        <Plus size={14} /> Add IR macro
      </button>
      {macros.map((macro, index) => {
        const prefix = `IR macro ${index + 1}`;
        const durationMs = irMacroDurationMs(macro, commands);
        return (
          <section
            className="ir-command ir-macro"
            key={macro.id}
            aria-label={prefix}
          >
            <label>
              Macro name
              <input
                aria-label={`${prefix} name`}
                value={macro.name}
                disabled={disabled}
                maxLength={200}
                onChange={(event) =>
                  update(macro.id, (next) => {
                    next.name = event.target.value;
                  })
                }
              />
            </label>
            <div className="row between">
              <span className="hint">
                {macro.steps.length} / {LIMITS.irMacroSteps} steps
                {Number.isFinite(durationMs) &&
                  ` · approximately ${(durationMs / 1000).toFixed(2)} s including presses and gaps`}
              </span>
              <button
                className="ghost danger-text small"
                aria-label={`Delete IR macro ${macro.name}`}
                disabled={disabled}
                onClick={() => {
                  const uses = project.states.reduce(
                    (total, state) =>
                      total +
                      (state.irEvents ?? []).filter(
                        (event) => event.macroId === macro.id,
                      ).length,
                    0,
                  );
                  confirm(
                    `Delete “${macro.name}”${uses ? ` and its ${uses} timeline reference${uses === 1 ? "" : "s"}` : ""}? Learned commands will be kept.`,
                    () =>
                      change((next) => {
                        next.ir!.macros = next.ir!.macros!.filter(
                          (item) => item.id !== macro.id,
                        );
                        next.states.forEach((state) => {
                          if (state.irEvents)
                            state.irEvents = state.irEvents.filter(
                              (event) => event.macroId !== macro.id,
                            );
                        });
                      }),
                  );
                }}
              >
                <Trash2 size={14} /> Delete macro
              </button>
            </div>
            {macro.steps.map((step, stepIndex) => {
              const stepPrefix = `${prefix} step ${stepIndex + 1}`;
              const command = commands.find(
                (item) => item.id === step.commandId,
              );
              const pressDuration =
                command && validateIrCommand(command)
                  ? irCommandDurationMs(command)
                  : undefined;
              return (
                <div
                  className="ir-macro-step"
                  key={step.id}
                  role="group"
                  aria-label={stepPrefix}
                >
                  <label>
                    Offset (seconds)
                    <input
                      aria-label={`${stepPrefix} offset seconds`}
                      type="number"
                      min="0"
                      max={(LIMITS.maxDurationMs - LIMITS.tickMs) / 1000}
                      step="0.05"
                      value={step.atMs / 1000}
                      disabled={disabled}
                      onChange={(event) =>
                        update(macro.id, (next) => {
                          next.steps.find((item) => item.id === step.id)!.atMs =
                            Math.round(Number(event.target.value) * 20) * 50;
                        })
                      }
                    />
                  </label>
                  <label>
                    Named command
                    <select
                      aria-label={`${stepPrefix} command`}
                      value={step.commandId}
                      disabled={disabled}
                      onChange={(event) =>
                        update(macro.id, (next) => {
                          next.steps.find(
                            (item) => item.id === step.id,
                          )!.commandId = event.target.value;
                        })
                      }
                    >
                      {!command && (
                        <option value={step.commandId}>
                          Missing command ({step.commandId || "not selected"})
                        </option>
                      )}
                      {commands.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="ghost danger-text icon"
                    aria-label={`Delete ${stepPrefix}`}
                    title="Remove step"
                    disabled={disabled}
                    onClick={() =>
                      update(macro.id, (next) => {
                        next.steps = next.steps.filter(
                          (item) => item.id !== step.id,
                        );
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                  <p className="hint ir-macro-step-details">
                    {command
                      ? `${command.sendCount} complete ${command.sendCount === 1 ? "press" : "presses"} · ${command.gapMs} ms minimum gap${pressDuration === undefined ? " · Fix the command settings above." : ` · approximately ${(pressDuration / 1000).toFixed(2)} s`}`
                      : "Choose a saved command to repair this step."}
                  </p>
                </div>
              );
            })}
            {!macro.steps.length && (
              <p className="hint">
                Add at least one step before using this macro.
              </p>
            )}
            <button
              className="small"
              aria-label={`Add step to ${macro.name}`}
              disabled={
                disabled ||
                !commands.length ||
                macro.steps.length >= LIMITS.irMacroSteps
              }
              onClick={() =>
                update(macro.id, (next) => {
                  const atMs = Math.min(
                    LIMITS.maxDurationMs - LIMITS.tickMs,
                    Math.ceil(Math.max(0, durationMs) / 50) * 50,
                  );
                  next.steps.push({
                    id: crypto.randomUUID(),
                    atMs: Number.isFinite(atMs) ? atMs : 0,
                    commandId: commands[0].id,
                  });
                })
              }
            >
              <Plus size={14} /> Add step
            </button>
          </section>
        );
      })}
    </section>
  );
}
