import { useEffect, useRef, useState } from "react";
import { Radio, Square, Trash2 } from "lucide-react";
import {
  LIMITS,
  validateIrCommand,
  type IrCommand,
  type IrSignal,
} from "../shared";
import type { EditorProps } from "./Hardware";
import { useDevice } from "./DeviceContext";

export function signalDescription(signal: IrSignal): string {
  return signal.kind === "nec"
    ? `NEC · 0x${signal.code.toString(16).toUpperCase().padStart(8, "0")}`
    : `Raw · ${signal.pulsesUs.length} pulses · 38 kHz assumed`;
}

export function IrLibrary({
  project,
  change,
  notify,
  confirm,
}: EditorProps & {
  notify(message: string, error?: boolean): void;
  confirm(message: string, action: () => void): void;
}) {
  const { status, busy, run } = useDevice();
  const [draft, setDraft] = useState<IrCommand | null>(null);
  const [learning, setLearning] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const learningRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (learningRef.current) void window.cpc?.cancelIr().catch(() => {});
    };
  }, []);
  const commands = project.ir?.commands ?? [];
  const enabled = project.ir?.enabled ?? false;
  const learningSupported = status.hello?.irLearning === true;
  const replaySupported = status.hello?.irReplay === true;
  const boardMatches = status.hello?.board === project.board;
  const connectionHint = !window.cpc
    ? "Learning and physical tests require the desktop app and a connected controller."
    : !status.connected
      ? "Connect your controller below to learn or test commands."
      : !boardMatches
        ? `Connected board (${String(status.hello?.board ?? "unknown")}) does not match this project (${project.board}). Choose the matching board in Hardware or connect the intended controller.`
        : !learningSupported || !replaySupported
          ? "Install the current controller firmware to enable IR learning and replay."
          : "Upload an IR-enabled scene first, even with an empty library, so the receiver and transmitter pins are configured.";
  const learn = async () => {
    if (!window.cpc || !enabled || !boardMatches) return;
    const token = ++generation.current;
    learningRef.current = true;
    setLearning(true);
    setMessage(
      "Learning stops the physical scene. Point your remote at the receiver and press a button once (up to 10 seconds).",
    );
    try {
      const signal = await run("Learning IR", () => window.cpc!.learnIr());
      if (!mounted.current || token !== generation.current) return;
      setDraft({
        id: crypto.randomUUID(),
        name: "New command",
        signal,
        sendCount: 1,
        gapMs: 100,
      });
      setMessage(
        "Signal captured. Give it a name, test it on your device, then save the command. The scene remains stopped.",
      );
    } catch (error) {
      if (mounted.current && token === generation.current)
        setMessage(String(error).replace(/^Error: /, ""));
    } finally {
      learningRef.current = false;
      if (mounted.current && token === generation.current) setLearning(false);
    }
  };
  const cancel = async () => {
    generation.current++;
    learningRef.current = false;
    setLearning(false);
    setMessage("Learning cancelled. The physical scene remains stopped.");
    try {
      await run("Stopping", () => window.cpc!.cancelIr(), true);
    } catch (error) {
      notify(String(error), true);
    }
  };
  const test = async (command: IrCommand) => {
    if (!window.cpc || !boardMatches) return;
    try {
      const reply = await run("Testing IR", () => window.cpc!.testIr(command));
      if (reply.type === "error")
        throw new Error(
          String(reply.message ?? reply.error ?? "IR test rejected"),
        );
      setMessage(
        `Test queued for “${command.name}”. Check that your device responded; a captured signal alone does not verify it. The physical scene remains stopped.`,
      );
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    }
  };
  const remove = (command: IrCommand) => {
    const uses =
      project.states.reduce(
        (sum, state) =>
          sum +
          (state.irEvents ?? []).filter(
            (event) => event.commandId === command.id,
          ).length,
        0,
      ) +
      project.triggers.reduce(
        (sum, trigger) =>
          sum +
          (trigger.zones ?? []).reduce(
            (total, zone) =>
              total +
              [...zone.onEnter, ...zone.onExit].filter(
                (action) =>
                  action.kind === "ir" && action.commandId === command.id,
              ).length,
            0,
          ),
        0,
      );
    confirm(
      `Delete “${command.name}”${uses ? ` and its ${uses} timeline or distance-zone reference${uses === 1 ? "" : "s"}` : ""}?`,
      () =>
        change((next) => {
          next.ir!.commands = next.ir!.commands.filter(
            (item) => item.id !== command.id,
          );
          next.states.forEach((state) => {
            if (state.irEvents)
              state.irEvents = state.irEvents.filter(
                (event) => event.commandId !== command.id,
              );
          });
          next.triggers.forEach((trigger) =>
            trigger.zones?.forEach((zone) => {
              zone.onEnter = zone.onEnter.filter(
                (action) =>
                  action.kind !== "ir" || action.commandId !== command.id,
              );
              zone.onExit = zone.onExit.filter(
                (action) =>
                  action.kind !== "ir" || action.commandId !== command.id,
              );
            }),
          );
        }),
    );
  };
  return (
    <section className="card full ir-library" aria-label="IR command library">
      <div className="card-heading">
        <h3>
          <Radio size={17} /> IR remote commands
        </h3>
        <span className="badge">
          {commands.length} / {LIMITS.irCommands}
        </span>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          aria-label="Enable IR remote control"
          checked={enabled}
          disabled={!!busy}
          onChange={(event) =>
            change((next) => {
              next.ir ??= {
                enabled: false,
                txPin: null,
                rxPin: null,
                commands: [],
              };
              next.ir.enabled = event.target.checked;
            })
          }
        />
        Enable IR remote control
      </label>
      {enabled && (
        <>
          <div className="row">
            <span className="badge">Receiver: D{project.ir?.rxPin ?? "—"}</span>
            <span className="badge">
              Transmitter: D{project.ir?.txPin ?? "—"}
            </span>
          </div>
          <p className="hint">
            IR uses two GPIO pins and Timer1. Use the displayed pin assignments
            after uploading the scene. Commands are complete button presses;
            increase the send count for devices that need repeated presses. The
            minimum gap also separates different queued commands.
          </p>
          <p className="hint">{connectionHint}</p>
          <div className="row">
            <button
              className="primary"
              disabled={
                !!busy ||
                !status.connected ||
                !learningSupported ||
                !boardMatches ||
                commands.length >= LIMITS.irCommands
              }
              onClick={() => void learn()}
            >
              Learn IR command
            </button>
            {learning && (
              <button className="danger" onClick={() => void cancel()}>
                <Square size={13} />
                Cancel learning
              </button>
            )}
          </div>
          {message && (
            <p className="ir-learning-message" role="status">
              {message}
            </p>
          )}
          {draft && (
            <section
              className="ir-command ir-draft"
              aria-label="Captured IR command"
            >
              <h4>Captured command</h4>
              <p className="hint">
                {signalDescription(draft.signal)}.{" "}
                {draft.signal.kind === "raw"
                  ? "The receiver cannot measure carrier frequency; replay assumes 38 kHz."
                  : "Decoded NEC frame."}
              </p>
              <CommandFields
                command={draft}
                prefix="Captured"
                disabled={!!busy}
                onChange={setDraft}
              />
              <div className="row">
                <button
                  disabled={
                    !!busy ||
                    !status.connected ||
                    !replaySupported ||
                    !validateIrCommand(draft) ||
                    !boardMatches
                  }
                  onClick={() => void test(draft)}
                >
                  Test captured command
                </button>
                <button
                  className="primary"
                  disabled={
                    !!busy ||
                    !validateIrCommand(draft) ||
                    commands.length >= LIMITS.irCommands
                  }
                  onClick={() => {
                    change((next) => {
                      next.ir!.commands.push(draft);
                    });
                    setDraft(null);
                    setMessage(
                      "Command saved in this project. Save the project and upload the scene to use it on the controller.",
                    );
                  }}
                >
                  Save IR command
                </button>
                <button
                  className="ghost"
                  disabled={!!busy}
                  onClick={() => setDraft(null)}
                >
                  Discard capture
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {!commands.length && (
        <p className="hint">
          Your learned commands will appear here by name. No codes are supplied
          automatically.
        </p>
      )}
      <div className="ir-command-grid">
        {commands.map((command, index) => (
          <section
            className="ir-command"
            key={command.id}
            aria-label={`IR command ${index + 1}`}
          >
            <p className="hint">{signalDescription(command.signal)}</p>
            <CommandFields
              command={command}
              prefix={`IR command ${index + 1}`}
              disabled={!!busy}
              onChange={(value) =>
                change((next) => {
                  const position = next.ir!.commands.findIndex(
                    (item) => item.id === command.id,
                  );
                  next.ir!.commands[position] = value;
                })
              }
            />
            <div className="row">
              <button
                disabled={
                  !enabled ||
                  !!busy ||
                  !status.connected ||
                  !replaySupported ||
                  !validateIrCommand(command) ||
                  !boardMatches
                }
                onClick={() => void test(command)}
              >
                Test {command.name || "command"}
              </button>
              <button
                className="ghost danger-text"
                aria-label={`Delete IR command ${command.name}`}
                disabled={!!busy}
                onClick={() => remove(command)}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          </section>
        ))}
      </div>
      {!enabled && commands.length > 0 && (
        <p className="hint">
          The command library is retained while IR is disabled. Enable IR to
          deploy or test its actions.
        </p>
      )}
    </section>
  );
}

function CommandFields({
  command,
  prefix,
  disabled,
  onChange,
}: {
  command: IrCommand;
  prefix: string;
  disabled: boolean;
  onChange(command: IrCommand): void;
}) {
  return (
    <>
      <label>
        Name
        <input
          aria-label={`${prefix} name`}
          value={command.name}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...command, name: event.target.value })
          }
        />
      </label>
      <div className="field-grid">
        <label>
          Complete presses
          <input
            aria-label={`${prefix} send count`}
            type="number"
            min="1"
            max="10"
            step="1"
            disabled={disabled}
            value={command.sendCount}
            onChange={(event) =>
              onChange({ ...command, sendCount: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Minimum gap after each press (ms)
          <input
            aria-label={`${prefix} gap milliseconds`}
            type="number"
            min="50"
            max="2000"
            step="50"
            disabled={disabled}
            value={command.gapMs}
            onChange={(event) =>
              onChange({ ...command, gapMs: Number(event.target.value) })
            }
          />
        </label>
      </div>
    </>
  );
}
