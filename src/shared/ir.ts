import { LIMITS, type IrCommand, type IrSignal } from "./model";

export const IR_CARRIER_HZ = 38000;
export const IR_TICK_US = 50;

export function validateIrSignal(value: unknown): value is IrSignal {
  if (typeof value !== "object" || value === null) return false;
  const signal = value as Partial<IrSignal> & {
    code?: unknown;
    pulsesUs?: unknown;
  };
  if (signal.kind === "nec")
    return (
      Number.isInteger(signal.code) &&
      Number(signal.code) >= 0 &&
      Number(signal.code) <= 0xffffffff
    );
  if (signal.kind !== "raw" || !Array.isArray(signal.pulsesUs)) return false;
  const pulses = signal.pulsesUs;
  return (
    pulses.length >= 5 &&
    pulses.length <= LIMITS.irPulses &&
    pulses.length % 2 === 1 &&
    pulses.every(
      (pulse) =>
        Number.isInteger(pulse) &&
        pulse >= 100 &&
        pulse <= 12750 &&
        pulse % IR_TICK_US === 0,
    ) &&
    pulses.reduce((sum, pulse) => sum + pulse, 0) <= 200000
  );
}

export function validateIrCommand(value: unknown): value is IrCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as IrCommand;
  return (
    typeof command.id === "string" &&
    !!command.id.trim() &&
    typeof command.name === "string" &&
    !!command.name.trim() &&
    command.name.length <= 200 &&
    validateIrSignal(command.signal) &&
    Number.isInteger(command.sendCount) &&
    command.sendCount >= 1 &&
    command.sendCount <= 10 &&
    Number.isInteger(command.gapMs) &&
    command.gapMs >= 50 &&
    command.gapMs <= 2000 &&
    command.gapMs % 50 === 0
  );
}

/** First complete frame only. The receiver demodulates a nominal 38 kHz carrier. */
export function learnIrSignal(pulsesUs: number[]): IrSignal {
  if (
    !Array.isArray(pulsesUs) ||
    pulsesUs.some((pulse) => !Number.isFinite(pulse))
  )
    throw new Error(
      "Invalid IR capture. Press and release the remote button again.",
    );
  const pulses = pulsesUs.map(
    (pulse) => Math.round(pulse / IR_TICK_US) * IR_TICK_US,
  );
  const raw: IrSignal = { kind: "raw", pulsesUs: pulses };
  if (!validateIrSignal(raw))
    throw new Error(
      "IR capture is incomplete, too long, or unsupported. Press and release the button once.",
    );
  const close = (actual: number, expected: number) =>
    Math.abs(actual - expected) <= expected * 0.25;
  if (
    pulses.length === 67 &&
    close(pulses[0], 9000) &&
    close(pulses[1], 4500) &&
    close(pulses[66], 560)
  ) {
    let code = 0;
    let recognized = true;
    for (let bit = 0; bit < 32; bit++) {
      const mark = pulses[2 + bit * 2],
        space = pulses[3 + bit * 2];
      if (!close(mark, 560)) {
        recognized = false;
        break;
      }
      if (close(space, 1690)) code = (code | (1 << bit)) >>> 0;
      else if (!close(space, 560)) {
        recognized = false;
        break;
      }
    }
    if (recognized) return { kind: "nec", code };
  }
  return raw;
}

/** Quantized to the same 50 us envelope used by capture and the firmware. */
export function encodeIrPulses(signal: IrSignal): number[] {
  if (!validateIrSignal(signal)) throw new Error("Invalid IR signal");
  if (signal.kind === "raw") return [...signal.pulsesUs];
  const pulses = [9000, 4500];
  for (let bit = 0; bit < 32; bit++)
    pulses.push(550, (signal.code >>> bit) & 1 ? 1700 : 550);
  pulses.push(550);
  return pulses;
}

export function irCommandDurationMs(command: IrCommand): number {
  return (
    (encodeIrPulses(command.signal).reduce((sum, pulse) => sum + pulse, 0) /
      1000) *
      command.sendCount +
    // The final quiet gap also separates this command from the next queued one.
    command.gapMs * command.sendCount
  );
}
