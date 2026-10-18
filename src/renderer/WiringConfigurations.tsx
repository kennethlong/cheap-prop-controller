import { useEffect, useMemo, useRef, useState } from "react";
import { Cable, Download, FolderOpen, Save, Trash2 } from "lucide-react";
import { BOARD_PROFILES, pinLabel } from "../shared/boards";
import type { SceneProject, WiringConfiguration } from "../shared/model";
import {
  applyWiringConfiguration,
  BUILT_IN_WIRING_CONFIGURATIONS,
  captureWiringConfiguration,
  parseWiringConfiguration,
} from "../shared/wiring-configurations";
import type { EditorProps } from "./Hardware";

const LIBRARY_KEY = "cpc.wiring-configurations.v1";
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_LIBRARY_BYTES = 2 * 1024 * 1024;
const MAX_CONFIGURATIONS = 100;
const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;
function checkedBrowserConfiguration(value: unknown): WiringConfiguration {
  const text = JSON.stringify(value);
  if (!text || byteLength(text) > MAX_CONFIGURATION_BYTES)
    throw new Error("Wiring configuration exceeds the 64 KB limit.");
  return parseWiringConfiguration(value);
}
function readBrowserLibrary(): WiringConfiguration[] {
  const raw = localStorage.getItem(LIBRARY_KEY);
  if (raw === null) return [];
  if (byteLength(raw) > MAX_LIBRARY_BYTES)
    throw new Error(
      "Wiring configuration library exceeds the 2 MB limit; stored data was not changed.",
    );
  const value = JSON.parse(raw);
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.configurations) ||
    value.configurations.length > MAX_CONFIGURATIONS
  )
    throw new Error(
      "Unsupported wiring configuration library. Export or back up this browser's stored data before replacing it.",
    );
  const configurations: WiringConfiguration[] = value.configurations.map(
    checkedBrowserConfiguration,
  );
  const ids = new Set<string>();
  for (const configuration of configurations) {
    if (
      ids.has(configuration.id) ||
      BUILT_IN_WIRING_CONFIGURATIONS.some(
        (item) => item.id === configuration.id,
      )
    )
      throw new Error(
        "Wiring configuration library contains duplicate or reserved IDs; stored data was not changed.",
      );
    ids.add(configuration.id);
  }
  return configurations;
}
function writeBrowserLibrary(configurations: WiringConfiguration[]) {
  if (configurations.length > MAX_CONFIGURATIONS)
    throw new Error(
      "The wiring configuration library is limited to 100 configurations.",
    );
  const checked = configurations.map(checkedBrowserConfiguration);
  const text = JSON.stringify({ version: 1, configurations: checked });
  if (byteLength(text) > MAX_LIBRARY_BYTES)
    throw new Error("Wiring configuration library exceeds the 2 MB limit.");
  localStorage.setItem(LIBRARY_KEY, text);
}
function connections(project: SceneProject) {
  const label = (pin: number | null) => pinLabel(project.board, pin);
  const rows = project.outputs.map((output) => ({
    id: `output:${output.id}`,
    name: output.name,
    pins: label(output.pin),
    settings: `${output.enabled === false ? "Disabled" : "Enabled"} · ${output.activeLow ? "active low" : "active high"} · idle ${output.idleActive ? "on" : "off"}`,
  }));
  for (const trigger of project.triggers.filter(
    (trigger) => trigger.kind !== "manual" && trigger.kind !== "timer",
  ))
    rows.push({
      id: `trigger:${trigger.id}`,
      name: trigger.name,
      pins:
        trigger.kind === "ultrasonic"
          ? `TRIG ${label(trigger.pin)} / ECHO ${label(trigger.echoPin)}`
          : label(trigger.pin),
      settings: `${trigger.enabled === false ? "Disabled" : "Enabled"} · ${trigger.kind} · ${trigger.activeLow ? "active low" : "active high"}${trigger.pullup ? " · pull-up" : ""}`,
    });
  project.audio.players.forEach((player, index) =>
    rows.push({
      id: `player:${player.id}`,
      name: `Player ${index + 1}`,
      pins: `TX ${label(player.txPin)} / RX ${label(player.rxPin)}${player.feedback ? ` / BUSY ${label(player.feedback.pin)}` : ""}`,
      settings: `${player.kind}${player.feedback ? ` · BUSY ${player.feedback.activeLow ? "active low" : "active high"}` : " · no BUSY feedback"}`,
    }),
  );
  rows.push({
    id: "ir",
    name: "IR remote transceiver",
    pins: project.ir
      ? `RX ${label(project.ir.rxPin)} / TX ${label(project.ir.txPin)}`
      : "No connections",
    settings: project.ir?.enabled ? "Enabled" : "Disabled",
  });
  return rows;
}

export function WiringConfigurations({
  project,
  change,
  notify,
  confirm,
}: EditorProps & {
  notify(message: string, error?: boolean): void;
  confirm(message: string, action: () => void): void;
}) {
  const [saved, setSaved] = useState<WiringConfiguration[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    try {
      const entries = window.cpc?.listWiringConfigurations
        ? await window.cpc.listWiringConfigurations()
        : readBrowserLibrary();
      setSaved(entries);
      setLibraryError("");
    } catch (error) {
      setLibraryError(String(error).replace(/^Error: /, ""));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const chosen = selected.startsWith("builtin:")
    ? BUILT_IN_WIRING_CONFIGURATIONS.find(
        (configuration) => `builtin:${configuration.id}` === selected,
      )
    : saved.find((configuration) => `saved:${configuration.id}` === selected);
  const preview = useMemo(() => {
    if (!chosen) return null;
    try {
      const next = applyWiringConfiguration(project, chosen);
      const before = connections(project);
      const after = connections(next);
      const ids = [
        ...new Set([
          ...after.map((row) => row.id),
          ...before.map((row) => row.id),
        ]),
      ];
      const rows = ids.map((id) => {
        const old = before.find((row) => row.id === id);
        const updated = after.find((row) => row.id === id);
        return {
          id,
          old,
          updated,
          changed:
            !old ||
            !updated ||
            old.pins !== updated.pins ||
            old.settings !== updated.settings ||
            project.board !== next.board,
        };
      });
      return { project: next, rows, error: "" };
    } catch (error) {
      return {
        project: null,
        rows: [],
        error: String(error).replace(/^Error: /, ""),
      };
    }
  }, [project, chosen]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    } finally {
      setBusy(false);
    }
  };
  const saveSnapshot = () =>
    run(async () => {
      const configuration = captureWiringConfiguration(
        project,
        name.trim() || `${project.name} wiring`,
      );
      const stored = window.cpc?.saveWiringConfiguration
        ? await window.cpc.saveWiringConfiguration(configuration)
        : configuration;
      if (!window.cpc?.saveWiringConfiguration) {
        const entries = readBrowserLibrary();
        writeBrowserLibrary([
          ...entries.filter((item) => item.id !== stored.id),
          stored,
        ]);
      }
      await refresh();
      setSelected(`saved:${stored.id}`);
      setName(stored.name);
      notify(
        `Saved wiring configuration “${stored.name}”. Your project has not changed.`,
      );
    });
  const importBrowser = async (file: File) =>
    run(async () => {
      if (file.size > MAX_CONFIGURATION_BYTES)
        throw new Error("Wiring configuration file is too large.");
      const configuration = checkedBrowserConfiguration(
        JSON.parse(await file.text()),
      );
      const entries = readBrowserLibrary();
      if (
        entries.some((item) => item.id === configuration.id) ||
        BUILT_IN_WIRING_CONFIGURATIONS.some(
          (item) => item.id === configuration.id,
        )
      )
        configuration.id = crypto.randomUUID();
      writeBrowserLibrary([...entries, configuration]);
      await refresh();
      setSelected(`saved:${configuration.id}`);
      notify(
        `Imported “${configuration.name}”. Review the preview before applying it.`,
      );
    });
  const importFile = () => {
    if (!window.cpc?.importWiringConfiguration) {
      fileInput.current?.click();
      return;
    }
    void run(async () => {
      const configuration = await window.cpc!.importWiringConfiguration!();
      if (!configuration) return;
      await refresh();
      setSelected(`saved:${configuration.id}`);
      notify(
        `Imported “${configuration.name}”. Review the preview before applying it.`,
      );
    });
  };
  const exportFile = () =>
    run(async () => {
      if (!chosen) return;
      if (window.cpc?.exportWiringConfiguration) {
        const path = await window.cpc.exportWiringConfiguration(chosen);
        if (path) notify(`Exported “${chosen.name}”.`);
      } else {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(chosen, null, 2) + "\n"], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = `${chosen.name.replace(/[^a-zA-Z0-9 _-]/g, "_")}.cpc-wiring.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  const remove = () => {
    if (!chosen || !selected.startsWith("saved:")) return;
    const deleting = chosen;
    confirm(
      `Delete saved wiring configuration “${deleting.name}”? Projects that use it keep their own wiring.`,
      () => {
        void run(async () => {
          if (window.cpc?.deleteWiringConfiguration)
            await window.cpc.deleteWiringConfiguration(deleting.id);
          else
            writeBrowserLibrary(
              readBrowserLibrary().filter((item) => item.id !== deleting.id),
            );
          await refresh();
          setSelected("");
          notify(
            "Saved wiring configuration deleted. Project wiring is unchanged.",
          );
        });
      },
    );
  };
  return (
    <section className="card full" aria-label="Wiring configurations">
      <div className="card-heading">
        <h3>
          <Cable size={17} /> Wiring configurations
        </h3>
        <span className="badge">
          {project.wiring === "fixed"
            ? (project.wiringConfiguration?.name ?? "Custom fixed wiring")
            : "Choose, review, then apply"}
        </span>
      </div>
      <p className="hint">
        Reuse a wiring plan across scenes. Selection only previews changes;
        Apply configuration updates this project. Upload the scene separately
        after checking the physical connections.
      </p>
      {libraryError && (
        <p className="validation-box" role="alert">
          Could not load saved configurations: {libraryError}
        </p>
      )}
      <div className="field-grid">
        <label>
          Configuration
          <select
            aria-label="Wiring configuration"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy}
          >
            <option value="">Select a configuration to preview</option>
            <optgroup label="Built in">
              {BUILT_IN_WIRING_CONFIGURATIONS.map((configuration) => (
                <option
                  key={configuration.id}
                  value={`builtin:${configuration.id}`}
                >
                  {configuration.name} —{" "}
                  {BOARD_PROFILES[configuration.board].name}
                </option>
              ))}
            </optgroup>
            {!!saved.length && (
              <optgroup label="Saved">
                {saved.map((configuration) => (
                  <option
                    key={configuration.id}
                    value={`saved:${configuration.id}`}
                  >
                    {configuration.name} —{" "}
                    {BOARD_PROFILES[configuration.board].name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label>
          New configuration name
          <input
            aria-label="New wiring configuration name"
            maxLength={200}
            value={name}
            placeholder={`${project.name} wiring`}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <div className="row wrap">
        <button
          onClick={() => void saveSnapshot()}
          disabled={busy || !!libraryError}
        >
          <Save size={14} /> Save as configuration
        </button>
        <button onClick={importFile} disabled={busy || !!libraryError}>
          <FolderOpen size={14} /> Import configuration
        </button>
        <button onClick={() => void exportFile()} disabled={busy || !chosen}>
          <Download size={14} /> Export configuration
        </button>
        <button
          onClick={remove}
          disabled={
            busy || !!libraryError || !chosen || !selected.startsWith("saved:")
          }
        >
          <Trash2 size={14} /> Delete saved configuration
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        aria-label="Import wiring configuration file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importBrowser(file);
        }}
      />
      <p className="hint">
        Saved configurations contain hardware connections and electrical
        settings. Scenes, event timelines, media files and learned IR commands
        stay in the project. Editing a project does not change its saved
        configuration.
      </p>
      {preview && (
        <section aria-label="Wiring configuration preview">
          <h4>{chosen?.name}</h4>
          {preview.error ? (
            <p className="validation-box" role="alert">
              Cannot apply this configuration: {preview.error}
            </p>
          ) : (
            <>
              <p>
                {project.board === preview.project!.board
                  ? BOARD_PROFILES[project.board].name
                  : `Board change: ${BOARD_PROFILES[project.board].name} → ${BOARD_PROFILES[preview.project!.board].name}`}
                . {preview.rows.filter((row) => row.changed).length} connection
                or setting changes.
              </p>
              <table className="config-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Current</th>
                    <th>Proposed</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.updated?.name ?? row.old?.name}</td>
                      <td>
                        {row.old ? (
                          <>
                            <div>{row.old.pins}</div>
                            <small className="hint">{row.old.settings}</small>
                          </>
                        ) : (
                          "Not installed"
                        )}
                      </td>
                      <td>
                        {row.updated ? (
                          <>
                            <div>{row.updated.pins}</div>
                            <small className="hint">
                              {row.updated.settings}
                            </small>
                          </>
                        ) : (
                          "Removed unused slot"
                        )}
                      </td>
                      <td>{row.changed ? "Changed" : "Unchanged"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <div className="row">
            <button
              className="primary"
              disabled={busy || !preview.project}
              onClick={() => {
                if (!preview.project) return;
                const next = preview.project;
                change((current) => Object.assign(current, next));
                setSelected("");
                notify(
                  `Applied “${chosen!.name}”. Pins stay fixed as you edit. Review and upload before using the revised wiring.`,
                );
              }}
            >
              Apply configuration
            </button>
            <button onClick={() => setSelected("")} disabled={busy}>
              Cancel configuration preview
            </button>
          </div>
        </section>
      )}
      {project.wiring === "fixed" && (
        <details>
          <summary>Current fixed wiring map</summary>
          <table className="config-table" aria-label="Current fixed wiring map">
            <thead>
              <tr>
                <th>Device</th>
                <th>Connection</th>
                <th>Settings</th>
              </tr>
            </thead>
            <tbody>
              {connections(project).map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.pins}</td>
                  <td>{row.settings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
