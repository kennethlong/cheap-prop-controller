import { useEffect, useState } from "react";
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
import type { PortInfo } from "../desktop-api";
import type { SceneProject } from "../shared/model";
import { BOARD_PROFILES } from "../shared/boards";
import { useDevice } from "./DeviceContext";

interface Props {
  project: SceneProject;
  bytes: number[];
  valid: boolean;
  notify(message: string, error?: boolean): void;
}

export function DevicePanel({ project, bytes, valid, notify }: Props) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [port, setPort] = useState("");
  const { status, setStatus, busy, run } = useDevice();
  const connected = status.connected;
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [variant, setVariant] = useState<"default" | "old-bootloader">(
    "default",
  );
  const [trigger, setTrigger] = useState("0");
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
  const command = (value: string) =>
    action(value, async () => {
      const result =
        value === "STOP"
          ? await window.cpc!.cancelIr()
          : await window.cpc!.deviceCommand(value);
      addLog(`${value} → ${JSON.stringify(result)}`);
      if (result.type === "error")
        throw new Error(
          String(result.message ?? result.error ?? "Device rejected command"),
        );
    });
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
      {showLogs && (
        <>
          <div className="row" style={{ padding: "0 17px 8px" }}>
            <span className="section-label">Hardware test</span>
            <select
              aria-label="Physical trigger"
              style={{ width: 170 }}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            >
              {project.triggers.map((item, index) => (
                <option value={index} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              disabled={!connected || !!busy || !project.triggers.length}
              onClick={() => void command(`TRIGGER ${trigger}`)}
            >
              Send trigger
            </button>
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
