import { Cable } from "lucide-react";
import { pinLabel } from "../shared/boards";
import type { SceneProject } from "../shared/model";
import {
  STANDARD_OUTPUT_SLOTS,
  STANDARD_TRIGGER_SLOTS,
} from "../shared/standard-harness";

export function StandardHarnessMap({
  project,
  onRestore,
}: {
  project: SceneProject;
  onRestore(): void;
}) {
  const busy = !!project.audio.players[0]?.feedback;
  const spare = project.outputs.find(
    (output) => output.standardSlot === "spare",
  );
  const spareEnabled = !!spare && spare.enabled !== false;
  const missingSlots =
    STANDARD_OUTPUT_SLOTS.some(
      (slot) =>
        !project.outputs.some((output) => output.standardSlot === slot.id),
    ) ||
    STANDARD_TRIGGER_SLOTS.some(
      (slot) =>
        !project.triggers.some((trigger) => trigger.standardSlot === slot.id),
    );
  const rows = [
    {
      id: "host",
      label: "USB serial",
      pins: "D0 / D1",
      state: "Always reserved",
      count: 0,
    },
    {
      id: "ir",
      label: "Adafruit IR transceiver",
      pins: "IRin → D2 · IRout ← D9",
      state: project.ir?.enabled ? "Enabled" : "Disabled · reserved",
      count: project.ir?.enabled ? 2 : 0,
    },
    {
      id: "audio",
      label: "DFPlayer",
      pins: "Module RX ← D3 · module TX → D8",
      state: project.audio.players.length ? "Enabled" : "Not in use · reserved",
      count: project.audio.players.length ? 2 : 0,
    },
    ...STANDARD_OUTPUT_SLOTS.filter((slot) => slot.id !== "spare").map(
      (slot) => {
        const device = project.outputs.find(
          (output) => output.standardSlot === slot.id,
        );
        const enabled = !!device && device.enabled !== false;
        return {
          id: slot.id,
          label: slot.label,
          pins: pinLabel("uno", slot.pin),
          state: enabled ? "Enabled" : "Disabled · reserved",
          count: enabled ? 1 : 0,
        };
      },
    ),
    ...STANDARD_TRIGGER_SLOTS.map((slot) => {
      const device = project.triggers.find(
        (trigger) => trigger.standardSlot === slot.id,
      );
      const enabled = !!device && device.enabled !== false;
      return {
        id: slot.id,
        label: slot.label,
        pins:
          slot.kind === "ultrasonic"
            ? `TRIG ${pinLabel("uno", slot.pin)} · ECHO ${pinLabel("uno", slot.echoPin ?? null)}`
            : pinLabel("uno", slot.pin),
        state: enabled ? "Enabled" : "Disabled · reserved",
        count: enabled ? (slot.kind === "ultrasonic" ? 2 : 1) : 0,
      };
    }),
    {
      id: "spare",
      label: "Spare / optional DFPlayer BUSY",
      pins: "A5 / D19",
      state:
        busy && spareEnabled
          ? "Conflict: output and BUSY enabled"
          : busy
            ? "BUSY feedback"
            : spareEnabled
              ? "Spare output enabled"
              : "Available",
      count: busy || spareEnabled ? 1 : 0,
    },
  ];
  const activePins = rows.reduce((sum, row) => sum + row.count, 0);
  const reservedPins = 17 + (busy || spareEnabled ? 1 : 0);
  return (
    <section className="card full" aria-label="Standard harness wiring map">
      <div className="card-heading">
        <h3>
          <Cable size={17} /> Fixed standard wiring map
        </h3>
        <span className="badge">
          {activePins} GPIO enabled · {reservedPins} / 18 reserved
        </span>
      </div>
      <p className="hint">
        Use this same map on every Uno, classic Nano, or 5 V Pro Mini. Disabled
        slots keep their pins; installing a backup sensor does not move another
        connection. D0 / D1 are reserved separately for USB serial.
      </p>
      {missingSlots && (
        <button onClick={onRestore}>Restore missing hardware slots</button>
      )}
      <table className="config-table">
        <thead>
          <tr>
            <th>Hardware slot</th>
            <th>Controller connection</th>
            <th>Installation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-slot={row.id}>
              <td>{row.label}</td>
              <td className="mono">{row.pins}</td>
              <td>{row.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        The primary and backup HC-SR04 each use a four-pin GX12 connector: 5 V,
        ground, TRIG, and ECHO. Connector contact numbering is documented
        separately from these Arduino pin assignments.
      </p>
    </section>
  );
}
