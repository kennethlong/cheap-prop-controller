import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  Plug,
  RefreshCw,
  Square,
  Unplug,
  Upload,
} from "lucide-react";
import type { DeviceReply, PortInfo } from "../desktop-api";
import type { SceneProject } from "../shared/model";
import { BOARD_PROFILES, pinLabel } from "../shared/boards";
import { toRuntimeProject } from "../shared/standard-harness";
import { useDevice } from "./DeviceContext";
import { createDelayedArm, type ArmingProgress } from "./delayed-arm";

interface Props {
  project: SceneProject;
  bytes: number[];
  valid: boolean;
  workspaceKey: string;
  notify(message: string, error?: boolean): void;
}

export function DevicePanel({
  project,
  bytes,
  valid,
  workspaceKey,
  notify,
}: Props) {
  const runtime = toRuntimeProject(project);
  const sceneKey = bytes.join(",");
  const [verifiedScene, setVerifiedScene] = useState<{
    key: string;
    port?: string;
  } | null>(null);
  const needsSceneVerification =
    project.wiring === "standard-uno" ||
    project.wiring === "fixed" ||
    project.outputs.some((output) => output.enabled !== undefined) ||
    project.triggers.some((trigger) => trigger.enabled !== undefined);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState("");
  const { status, setStatus, busy, run } = useDevice();
  const connected = status.connected;
  const triggerSceneVerified =
    !needsSceneVerification ||
    (valid &&
      verifiedScene?.key === sceneKey &&
      verifiedScene?.port === status.port);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [showTests, setShowTests] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMask, setTestMask] = useState(0);
  const [feedback, setFeedback] = useState<DeviceReply | null>(null);
  const [arming, setArming] = useState<ArmingProgress | null>(null);
  const delayedArm = useRef<ReturnType<typeof createDelayedArm> | null>(null);
  const armingConnection = useRef<{ port?: string } | null>(null);
  const testActive = useRef(false);
  const testPending = useRef(false);
  const desiredMask = useRef(0);
  const releaseTest = useRef<(() => void) | null>(null);
  const testEpoch = useRef(0);
  const sendingMask = useRef(false);
  const latched = useRef(0);
  const heldMask = useRef(0);
  const heldSources = useRef(new Map<number, Set<string>>());
  const [variant, setVariant] = useState<"default" | "old-bootloader">(
    "default",
  );
  const [triggerId, setTrigger] = useState("");
  const selectedTrigger =
    runtime.triggers.find((item) => item.id === triggerId) ??
    runtime.triggers.find((item) => item.kind === "manual") ??
    runtime.triggers[0];
  const addLog = (line: string) =>
    setLogs((old) => [
      ...old.slice(-149),
      `${new Date().toLocaleTimeString()}  ${line}`,
    ]);
  const refresh = async () => {
    if (!window.cpc) return;
    try {
      const list = await window.cpc.listPorts();
      setPorts(list);
      setPort((old) =>
        list.some((item) => item.path === old) ? old : (list[0]?.path ?? ""),
      );
    } catch (error) {
      notify(`Unable to list serial ports: ${String(error)}`, true);
    }
  };
  useEffect(() => {
    void refresh();
    if (!window.cpc) return;
    const offLog = window.cpc.onDeviceLog(addLog);
    const offStatus = window.cpc.onDeviceStatus((status) => {
      if (!status.connected) setVerifiedScene(null);
      if (
        armingConnection.current &&
        (!status.connected || status.port !== armingConnection.current.port)
      )
        cancelArming();
      if (status.port) setPort(status.port);
    });
    return () => {
      offLog();
      offStatus();
    };
  }, []);
  const action = async (label: string, callback: () => Promise<unknown>) => {
    try {
      await run(label, callback, label === "STOP");
    } catch (error) {
      addLog(String(error));
      setShowLogs(true);
      notify(String(error).replace(/^Error: /, ""), true);
    }
  };
  const command = (value: string) => {
    if (value === "STOP") cancelArming(false);
    return action(value, async () => {
      if (value === "STOP") resetTest();
      const result =
        value === "STOP"
          ? await window.cpc!.cancelIr()
          : await window.cpc!.deviceCommand(value);
      if (value === "STATUS") setFeedback(result);
      addLog(`${value} → ${JSON.stringify(result)}`);
      if (result.type === "error")
        throw new Error(
          String(result.message ?? result.error ?? "Device rejected command"),
        );
    });
  };
  const cancelArming = (stopPendingReset = true) => {
    const pending = delayedArm.current;
    delayedArm.current = null;
    armingConnection.current = null;
    if (!pending) return;
    const resetting = pending.cancel();
    setArming(null);
    // RESET may already be on the wire. STOP has serial priority and leaves the
    // controller stopped even if cancellation races the final acknowledgement.
    if (resetting && stopPendingReset && window.cpc) void command("STOP");
  };
  const beginDelayedArm = () =>
    void action("Delayed arming", async () => {
      const pending = createDelayedArm({
        stop: async () => {
          const reply = await window.cpc!.cancelIr();
          addLog(`Delayed arm STOP: ${JSON.stringify(reply)}`);
          return reply;
        },
        reset: async () => {
          const reply = await window.cpc!.deviceCommand("RESET");
          addLog(`Delayed arm RESET: ${JSON.stringify(reply)}`);
          return reply;
        },
        progress: (value) => {
          if (delayedArm.current === pending) setArming(value);
        },
      });
      delayedArm.current = pending;
      armingConnection.current = { port: status.port };
      try {
        if (await pending.run())
          notify("Controller reset and armed after the 15-second exit delay.");
      } finally {
        if (delayedArm.current === pending) {
          delayedArm.current = null;
          armingConnection.current = null;
          setArming(null);
        }
      }
    });
  useLayoutEffect(() => {
    cancelArming();
  }, [workspaceKey, project, bytes.join(","), connected, status.port]);
  useEffect(() => {
    const leaving = () => cancelArming();
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", leaving);
      cancelArming();
    };
  }, []);
  const resetTest = () => {
    testEpoch.current++;
    testActive.current = false;
    testPending.current = false;
    desiredMask.current = 0;
    latched.current = 0;
    heldMask.current = 0;
    heldSources.current.clear();
    setTesting(false);
    setTestMask(0);
    releaseTest.current?.();
    releaseTest.current = null;
  };
  const stopTests = async () => {
    const wasTesting = testActive.current || testPending.current;
    resetTest();
    if (wasTesting && window.cpc)
      await action("STOP", () => window.cpc!.endOutputTest());
  };
  const sendMask = async () => {
    if (!testActive.current || sendingMask.current || !window.cpc) return;
    const epoch = testEpoch.current;
    const mask = desiredMask.current;
    sendingMask.current = true;
    try {
      await window.cpc.setTestOutputs(mask);
    } catch (error) {
      if (testEpoch.current === epoch) {
        notify(`Output test stopped: ${String(error)}`, true);
        await stopTests();
      }
    } finally {
      sendingMask.current = false;
      if (
        epoch === testEpoch.current &&
        testActive.current &&
        desiredMask.current !== mask
      )
        void sendMask();
    }
  };
  const setMask = () => {
    desiredMask.current = (latched.current | heldMask.current) >>> 0;
    setTestMask(desiredMask.current);
    void sendMask();
  };
  const holdOutput = (index: number, source: string, active: boolean) => {
    if (active && !testActive.current) return;
    const sources = heldSources.current.get(index) ?? new Set<string>();
    if (active) sources.add(source);
    else sources.delete(source);
    if (sources.size) heldSources.current.set(index, sources);
    else heldSources.current.delete(index);
    heldMask.current =
      [...heldSources.current.keys()].reduce(
        (mask, item) => mask | (1 << item),
        0,
      ) >>> 0;
    setMask();
  };
  const beginTests = () => {
    if (testPending.current || testActive.current) return;
    const epoch = ++testEpoch.current;
    testPending.current = true;
    void action("Testing outputs", async () => {
      try {
        await window.cpc!.beginOutputTest(bytes);
        if (epoch !== testEpoch.current) return;
        setVerifiedScene({ key: sceneKey, port: status.port });
        testPending.current = false;
        testActive.current = true;
        setTesting(true);
        setFeedback(null);
        await new Promise<void>((resolve) => {
          releaseTest.current = resolve;
        });
      } finally {
        if (epoch === testEpoch.current) resetTest();
      }
    });
  };
  useEffect(() => {
    const timer = window.setInterval(() => void sendMask(), 500);
    const blur = () => void stopTests();
    const hidden = () => {
      if (document.hidden) void stopTests();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    void stopTests();
  }, [workspaceKey, bytes.join(","), connected]);
  useEffect(() => {
    setVerifiedScene(null);
  }, [connected, status.port, sceneKey]);
  useEffect(() => {
    if (
      !showLogs ||
      !connected ||
      busy ||
      status.hello?.audioFeedback !== true ||
      !window.cpc
    )
      return;
    let current = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const reply = await window.cpc!.deviceCommand("STATUS");
        if (current) setFeedback(reply);
      } catch {
        /* Connection and command errors remain in the device console. */
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [showLogs, connected, busy, status.hello?.audioFeedback]);
  useEffect(
    () => () => {
      const active = testActive.current || testPending.current;
      testActive.current = false;
      testPending.current = false;
      testEpoch.current++;
      releaseTest.current?.();
      if (active && window.cpc) void window.cpc.endOutputTest().catch(() => {});
    },
    [],
  );
  return (
    <section className="device-panel" aria-label="Physical controller">
      <div className="device-toolbar">
        <div className="device-title">
          <Cpu size={16} />
          <span>Physical controller</span>
          <span className={`connection-dot ${connected ? "connected" : ""}`} />
        </div>
        {window.cpc ? (
          <>
            <select
              aria-label="Serial port"
              value={port}
              disabled={connected || !!busy}
              onChange={(e) => setPort(e.target.value)}
            >
              {!ports.length && <option value="">No ports found</option>}
              {ports.map((item) => (
                <option value={item.path} key={item.path}>
                  {item.path}
                  {item.manufacturer ? ` · ${item.manufacturer}` : ""}
                </option>
              ))}
            </select>
            <button
              className="icon ghost"
              aria-label="Refresh serial ports"
              onClick={() => void refresh()}
              disabled={connected || !!busy}
            >
              <RefreshCw size={15} />
            </button>
            <button
              disabled={!port || !!busy}
              onClick={() =>
                void action(
                  connected ? "Disconnecting" : "Connecting",
                  async () => {
                    if (connected) {
                      await window.cpc!.disconnect();
                      setStatus({ connected: false });
                    } else {
                      const reply = await window.cpc!.connect(port);
                      setStatus({ connected: true, port, hello: reply });
                      addLog(`Connected: ${JSON.stringify(reply)}`);
                      notify(`Connected to ${port}`);
                    }
                  },
                )
              }
            >
              {connected ? <Unplug size={14} /> : <Plug size={14} />}
              {connected ? "Disconnect" : "Connect"}
            </button>
            <div className="toolbar-separator" />
            <button
              className={connected && valid ? "primary" : ""}
              disabled={!connected || !valid || !!busy}
              title={
                !valid
                  ? "Fix scene validation errors before upload"
                  : "Write configuration and all states to onboard storage"
              }
              onClick={() =>
                void action("Uploading scene", async () => {
                  const reply = await window.cpc!.uploadScene(bytes);
                  if (reply.type === "error")
                    throw new Error(
                      String(reply.message ?? reply.error ?? "Upload rejected"),
                    );
                  setVerifiedScene({ key: sceneKey, port: status.port });
                  addLog(`Scene uploaded: ${JSON.stringify(reply)}`);
                  notify(
                    "Scene uploaded to onboard storage. The controller is now running its initial state.",
                  );
                })
              }
            >
              <Upload size={14} />
              Upload scene
            </button>
            <button
              disabled={!connected || !!busy}
              onClick={() => void command("RESET")}
              title="Return the physical controller to its initial state and arm its triggers"
            >
              Arm / reset
            </button>
            <button
              disabled={!connected || !!busy}
              onClick={beginDelayedArm}
              title="Stop the controller, wait 15 seconds for you to leave, then reset and arm its triggers"
            >
              Reset &amp; arm in 15 s
            </button>
            <button
              className="danger"
              disabled={!connected}
              onClick={() => void command("STOP")}
              title="Stop the physical controller and force all outputs inactive"
            >
              <Square size={13} fill="currentColor" />
              STOP
            </button>
            <button
              className="ghost"
              disabled={!port || !!busy}
              onClick={() => setShowFlash(true)}
            >
              <Download size={14} />
              Firmware
            </button>
            <button
              className={showTests ? "selected" : "ghost"}
              disabled={!connected || (!!busy && !testing)}
              onClick={() => {
                if (showTests) void stopTests();
                setShowTests((old) => !old);
              }}
            >
              {showTests ? "Exit Test Outputs" : "Test outputs"}
            </button>
          </>
        ) : (
          <span className="browser-note">
            Browser preview · install the desktop app to connect USB hardware
          </span>
        )}
        <div className="grow" />
        {busy && <span className="small success-text">{busy}…</span>}
        <button
          className="icon ghost"
          aria-label={showLogs ? "Hide device console" : "Show device console"}
          onClick={() => setShowLogs((old) => !old)}
        >
          {showLogs ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>
      {arming && (
        <div className="row" style={{ padding: "0 17px 12px" }}>
          <strong role="status" aria-label="Delayed arming">
            {arming.phase === "stopping"
              ? "Stopping controller…"
              : arming.phase === "countdown"
                ? `Arming in ${arming.seconds} s`
                : "Arming controller…"}
          </strong>
          <button onClick={() => cancelArming()}>Cancel arming</button>
          <span className="hint">
            Keep the app open and USB connected. Outputs and audio stay stopped
            during the countdown. Let the PIR clear before arming.
          </span>
        </div>
      )}
      {showTests && (
        <section className="hardware-testing" aria-label="Manual output test">
          <div className="row">
            <strong>
              {testing
                ? "Output test active · scene stopped"
                : "Test one channel at a time"}
            </strong>
            <div className="grow" />
            {testing ? (
              <>
                <button
                  onClick={() => {
                    latched.current = 0;
                    heldMask.current = 0;
                    heldSources.current.clear();
                    setMask();
                  }}
                >
                  All off
                </button>
                <button onClick={() => void stopTests()}>
                  Exit output test
                </button>
              </>
            ) : (
              <button
                className="primary"
                disabled={
                  !connected ||
                  !!busy ||
                  !valid ||
                  status.hello?.outputTest !== true ||
                  status.hello?.board !== project.board
                }
                onClick={beginTests}
              >
                Enter output test
              </button>
            )}
          </div>
          <p className="hint">
            Upload this scene first. Entering test mode stops audio and the
            sequence and turns every output off. Hold a button for momentary
            operation, or latch it ON. All off stays in test mode; Exit leaves
            the controller stopped. Switching workspace or leaving the app stops
            the test.
          </p>
          {status.hello?.outputTest !== true && (
            <p className="hint">
              Install firmware with output-test support to use these controls.
            </p>
          )}
          {status.hello?.board !== project.board && (
            <p className="hint">
              The connected board must match this project's board.
            </p>
          )}
          <div className="test-output-grid">
            {runtime.outputs.map((output, index) => (
              <div className="test-output" key={output.id}>
                <span>
                  {output.name}
                  <small className="hint">
                    {" "}
                    · {pinLabel(project.board, output.pin)}
                  </small>
                </span>
                <button
                  aria-label={`Hold physical ${output.name}`}
                  aria-pressed={!!(testMask & (1 << index))}
                  disabled={!testing}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    holdOutput(index, `pointer:${event.pointerId}`, true);
                  }}
                  onPointerUp={(event) => {
                    holdOutput(index, `pointer:${event.pointerId}`, false);
                  }}
                  onPointerCancel={(event) => {
                    holdOutput(index, `pointer:${event.pointerId}`, false);
                  }}
                  onLostPointerCapture={(event) => {
                    holdOutput(index, `pointer:${event.pointerId}`, false);
                  }}
                  onKeyDown={(event) => {
                    if (event.code !== "Space" && event.code !== "Enter")
                      return;
                    event.preventDefault();
                    if (event.repeat) return;
                    holdOutput(index, `key:${event.code}`, true);
                  }}
                  onKeyUp={(event) => {
                    if (event.code !== "Space" && event.code !== "Enter")
                      return;
                    event.preventDefault();
                    holdOutput(index, `key:${event.code}`, false);
                  }}
                  onBlur={() => {
                    holdOutput(index, "key:Space", false);
                    holdOutput(index, "key:Enter", false);
                  }}
                >
                  Hold
                </button>
                <button
                  aria-label={`Latch physical ${output.name}`}
                  aria-pressed={!!(latched.current & (1 << index))}
                  disabled={!testing}
                  onClick={() => {
                    latched.current ^= 1 << index;
                    setMask();
                  }}
                >
                  {latched.current & (1 << index) ? "ON" : "OFF"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {showLogs && (
        <>
          <div className="row" style={{ padding: "0 17px 8px" }}>
            <span className="section-label">Hardware test</span>
            <select
              aria-label="Controller trigger"
              style={{ width: 220 }}
              value={selectedTrigger?.id ?? ""}
              onChange={(e) => setTrigger(e.target.value)}
            >
              {runtime.triggers.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                  {item.kind === "manual" ? " (app)" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={
                !connected ||
                !!busy ||
                !selectedTrigger ||
                !triggerSceneVerified
              }
              title={
                !triggerSceneVerified
                  ? "Upload the current scene first so trigger numbers match the controller."
                  : selectedTrigger
                    ? `Send ${selectedTrigger.name} to the controller`
                    : undefined
              }
              onClick={() => {
                if (selectedTrigger && triggerSceneVerified)
                  void command(
                    `TRIGGER ${runtime.triggers.indexOf(selectedTrigger)}`,
                  );
              }}
            >
              Send trigger
            </button>
            {needsSceneVerification && !triggerSceneVerified && (
              <span className="hint">
                Upload this scene on this connection before sending triggers.
              </span>
            )}
            <button
              disabled={!connected || !!busy}
              onClick={() => void command("STATUS")}
            >
              Read status
            </button>
            <div className="grow" />
            <button className="ghost small" onClick={() => setLogs([])}>
              Clear log
            </button>
          </div>
          <pre className="device-log" aria-label="Device console">
            {logs.length
              ? logs.join("\n")
              : "No serial connection opened. Connect explicitly when the controller is ready."}
          </pre>
          {typeof feedback?.activeChildren === "number" && (
            <div
              className="preview-children"
              aria-label="Controller child activity"
            >
              {runtime.states.map((state, index) => {
                const active =
                  ((Number(feedback.activeChildren) >>> index) & 1) !== 0;
                const cooling =
                  ((Number(feedback.coolingChildren ?? 0) >>> index) & 1) !== 0;
                return active || cooling ? (
                  <span
                    className={`badge ${active ? "green" : "amber"}`}
                    key={state.id}
                  >
                    {state.name} · {active ? "Running" : "Cooldown"}
                  </span>
                ) : null;
              })}
              <span className="hint">
                Last reported child activity. Short pulses may finish between
                status updates.
              </span>
            </div>
          )}
          {Array.isArray(feedback?.players) && (
            <div
              className="preview-audio-levels"
              aria-label="Physical audio feedback"
            >
              {feedback.players.map(
                (player: {
                  index: number;
                  feedback: string;
                  busy: boolean | null;
                }) => (
                  <span className="badge" key={player.index}>
                    Player {player.index + 1} · {player.feedback}
                    {player.busy === null
                      ? ""
                      : ` · BUSY ${player.busy ? "active" : "inactive"}`}
                  </span>
                ),
              )}
            </div>
          )}
        </>
      )}
      {showFlash && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="flash-title"
          >
            <h2 id="flash-title">Install controller firmware</h2>
            <p>
              This replaces the sketch on <strong>{port}</strong> with the
              prebuilt firmware for{" "}
              <strong>{BOARD_PROFILES[project.board].name}</strong>. The board
              resets during installation. Upload your scene afterward.
            </p>
            {project.board === "nano" && (
              <label>
                Nano bootloader
                <select
                  value={variant}
                  onChange={(e) => setVariant(e.target.value as typeof variant)}
                >
                  <option value="default">New bootloader · 115200 baud</option>
                  <option value="old-bootloader">
                    Old bootloader · 57600 baud
                  </option>
                </select>
              </label>
            )}
            <p className="hint">
              Use Hardware to choose a different board. Pro Mini support targets
              the ATmega328P 5V / 16 MHz model with a USB serial adapter.
            </p>
            <div className="row">
              <button onClick={() => setShowFlash(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  setShowFlash(false);
                  void action("Installing firmware", async () => {
                    const result = await window.cpc!.flashFirmware(
                      project.board,
                      port,
                      variant,
                    );
                    setStatus({ connected: false });
                    addLog(result.log);
                    setShowLogs(true);
                    if (!result.success)
                      throw new Error(
                        "Firmware installation failed. See the device console for details.",
                      );
                    notify(
                      "Firmware installed. Connect and upload your scene.",
                    );
                  });
                }}
              >
                Install firmware
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
