import type {
  BoardId,
  BoardProfile,
  SceneProject,
  ValidationIssue,
} from "./model";
import { LIMITS } from "./model";
import { resolveAudioTransition } from "./audio-settings";

const pins = (last: number) =>
  Array.from({ length: last + 1 }, (_, index) => index);
export const BOARD_PROFILES: Record<BoardId, BoardProfile> = {
  uno: {
    id: "uno",
    name: "Uno R3 / ATmega328P",
    eepromBytes: 1024,
    digitalPins: pins(19),
    reservedPins: [0, 1],
    uartPairs: [],
  },
  nano: {
    id: "nano",
    name: "Classic Nano / ATmega328P",
    eepromBytes: 1024,
    digitalPins: pins(19),
    reservedPins: [0, 1],
    uartPairs: [],
  },
  "pro-mini": {
    id: "pro-mini",
    name: "Pro Mini / ATmega328P (5V, 16 MHz)",
    eepromBytes: 1024,
    digitalPins: pins(19),
    reservedPins: [0, 1],
    uartPairs: [],
  },
  mega: {
    id: "mega",
    name: "Mega 2560",
    eepromBytes: 4096,
    digitalPins: pins(69),
    reservedPins: [0, 1],
    uartPairs: [
      { tx: 18, rx: 19 },
      { tx: 16, rx: 17 },
      { tx: 14, rx: 15 },
    ],
  },
};

export const SHIELD_PINS = [7, 6, 5, 4] as const;

export interface AllocationResult {
  project: SceneProject;
  issues: ValidationIssue[];
  /** Unallocated digital pins after the configured outputs have been assigned. */
  availableOutputPins: number[];
  /** Total possible prop output channels for this audio/trigger configuration. */
  maxOutputs: number;
}

/** Reallocate deterministically: fixed shield pins, audio, triggers, then outputs. */
export function allocatePins(project: SceneProject): AllocationResult {
  const result = structuredClone(project);
  const profile = BOARD_PROFILES[result.board];
  const used = new Set(profile.reservedPins);
  const issues: ValidationIssue[] = [];
  const take = (path: string): number | null => {
    const pin = profile.digitalPins.find((candidate) => !used.has(candidate));
    if (pin === undefined) {
      issues.push({
        path,
        severity: "error",
        message:
          "No compatible GPIO remains. Reduce audio players, triggers, or outputs.",
      });
      return null;
    }
    used.add(pin);
    return pin;
  };
  if (result.wiring === "relay-shield") {
    SHIELD_PINS.forEach((pin) => used.add(pin));
  }
  result.audio.players.forEach((player, index) => {
    if (profile.uartPairs.length) {
      const pair = profile.uartPairs[index];
      player.txPin = pair?.tx ?? null;
      player.rxPin = pair?.rx ?? null;
      if (pair) {
        used.add(pair.tx);
        used.add(pair.rx);
      } else {
        issues.push({
          path: `audio.players.${index}`,
          severity: "error",
          message: "This board has no additional audio UART.",
        });
      }
    } else {
      player.txPin = take(`audio.players.${index}.txPin`);
      player.rxPin = take(`audio.players.${index}.rxPin`);
    }
  });
  result.triggers.forEach((trigger, index) => {
    trigger.pin = take(`triggers.${index}.pin`);
    trigger.echoPin =
      trigger.kind === "ultrasonic" ? take(`triggers.${index}.echoPin`) : null;
  });
  const remaining = profile.digitalPins.filter((pin) => !used.has(pin));
  const fixedCount = result.wiring === "relay-shield" ? 4 : 0;
  const maxOutputs = Math.min(LIMITS.outputs, remaining.length + fixedCount);
  result.outputs.forEach((output, index) => {
    output.pin =
      result.wiring === "relay-shield" && index < 4
        ? SHIELD_PINS[index]
        : take(`outputs.${index}.pin`);
  });
  return {
    project: result,
    issues,
    maxOutputs,
    availableOutputPins: profile.digitalPins.filter((pin) => !used.has(pin)),
  };
}

/** Players are determined by overlap, never by the number of files on a card. */
export function requiredPlayerCount(project: SceneProject): number {
  const { crossfadeMs } = resolveAudioTransition(project.audio);
  const foreground = new Set(
    project.states
      .filter(
        (state) =>
          state.id !== project.initialStateId && state.foregroundTrack !== null,
      )
      .map((state) => state.foregroundTrack),
  );
  const ambient = project.audio.ambientTrack !== null;
  if (!ambient && foreground.size === 0) return 0;
  if (foreground.size === 0) return 1;
  if (project.audio.keepAmbient && ambient) {
    return crossfadeMs > 0 && foreground.size > 1 ? 3 : 2;
  }
  return crossfadeMs > 0 && (ambient || foreground.size > 1) ? 2 : 1;
}

export function synchronizeAudioPlayers(project: SceneProject): SceneProject {
  const result = structuredClone(project);
  const count = requiredPlayerCount(result);
  result.audio.players = Array.from(
    { length: count },
    (_, index) =>
      result.audio.players[index] ?? {
        id: `player-${index + 1}`,
        kind: "dfplayer",
        txPin: null,
        rxPin: null,
      },
  );
  return allocatePins(result).project;
}

export function pinLabel(board: BoardId, pin: number | null): string {
  if (pin === null) return "Unassigned";
  const firstAnalog = board === "mega" ? 54 : 14;
  return pin >= firstAnalog ? `A${pin - firstAnalog} / D${pin}` : `D${pin}`;
}
