import type {
  OutputConfig,
  SceneProject,
  TriggerConfig,
  ValidationIssue,
  WiringConfiguration,
} from "./model";
import { LIMITS } from "./model";
import {
  BOARD_PROFILES,
  feedbackPins,
  irPins,
  requiredPlayerCount,
  type AllocationResult,
} from "./boards";
import {
  STANDARD_OUTPUT_SLOTS,
  STANDARD_TRIGGER_SLOTS,
} from "./standard-harness";
import { validateProject, validateProjectStructure } from "./validation";

export type { WiringConfiguration } from "./model";

type SlotDevice = OutputConfig | TriggerConfig;
const slotId = (item: SlotDevice): string =>
  item.configurationSlot ?? item.standardSlot ?? item.id;
const physical = (trigger: TriggerConfig): boolean =>
  trigger.kind !== "manual" && trigger.kind !== "timer";
const error = (path: string, message: string): ValidationIssue => ({
  path,
  message,
  severity: "error",
});

/** Fixed wiring keeps installed and disabled device connections reserved. */
export function validateFixedPins(project: SceneProject): ValidationIssue[] {
  if (project.wiring !== "fixed") return [];
  const issues: ValidationIssue[] = [];
  const profile = BOARD_PROFILES[project.board];
  const used = new Map<number, string>();
  const claim = (
    pin: number | null,
    path: string,
    allowed = profile.digitalPins,
  ) => {
    if (
      pin === null ||
      !Number.isInteger(pin) ||
      !allowed.includes(pin) ||
      profile.reservedPins.includes(pin)
    ) {
      issues.push(
        error(
          path,
          "Choose a compatible GPIO; D0/D1 are reserved for USB serial.",
        ),
      );
      return;
    }
    const previous = used.get(pin);
    if (previous)
      issues.push(
        error(
          path,
          `D${pin} is reserved by ${previous}, including when that device is disabled.`,
        ),
      );
    else used.set(pin, path);
  };
  const identities = (items: SlotDevice[], path: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      const slot = item.configurationSlot;
      if (slot === undefined) return;
      if (!slot.trim() || slot.length > 128)
        issues.push(
          error(
            `${path}.${index}.configurationSlot`,
            "Slot identifiers must contain 1–128 characters.",
          ),
        );
      if (seen.has(slot))
        issues.push(
          error(
            `${path}.${index}.configurationSlot`,
            `Duplicate configuration slot: ${slot}.`,
          ),
        );
      seen.add(slot);
    });
  };
  identities(project.outputs, "outputs");
  identities(project.triggers, "triggers");
  project.outputs.forEach((output, index) =>
    claim(output.pin, `outputs.${index}.pin`),
  );
  project.triggers.forEach((trigger, index) => {
    if (!physical(trigger)) return;
    claim(trigger.pin, `triggers.${index}.pin`);
    if (trigger.kind === "ultrasonic")
      claim(trigger.echoPin, `triggers.${index}.echoPin`);
  });
  project.audio.players.forEach((player, index) => {
    claim(player.txPin, `audio.players.${index}.txPin`);
    claim(player.rxPin, `audio.players.${index}.rxPin`);
    if (player.feedback)
      claim(
        player.feedback.pin,
        `audio.players.${index}.feedback.pin`,
        feedbackPins(project.board),
      );
    if (project.board === "mega") {
      const pair = profile.uartPairs[index];
      if (!pair || player.txPin !== pair.tx || player.rxPin !== pair.rx)
        issues.push(
          error(
            `audio.players.${index}`,
            "Mega players must use ordered UART pairs TX18/RX19, TX16/RX17 and TX14/RX15.",
          ),
        );
    }
  });
  if (project.ir) {
    const fixed = irPins(project.board);
    if (
      (project.ir.rxPin !== null && project.ir.rxPin !== fixed.rxPin) ||
      (project.ir.txPin !== null && project.ir.txPin !== fixed.txPin)
    )
      issues.push(
        error(
          "ir",
          `IR requires receive D${fixed.rxPin} and transmit D${fixed.txPin} on this board.`,
        ),
      );
    if (project.ir.enabled) {
      claim(project.ir.rxPin, "ir.rxPin");
      claim(project.ir.txPin, "ir.txPin");
    }
  }
  return issues;
}

/** Validation and capacity accounting only: this function never moves a pin. */
export function allocateFixedPins(project: SceneProject): AllocationResult {
  const result = structuredClone(project);
  const used = new Set<number>(BOARD_PROFILES[project.board].reservedPins);
  const add = (pin: number | null | undefined) => {
    if (pin !== null && pin !== undefined) used.add(pin);
  };
  result.outputs.forEach((output) => add(output.pin));
  result.triggers.filter(physical).forEach((trigger) => {
    add(trigger.pin);
    if (trigger.kind === "ultrasonic") add(trigger.echoPin);
  });
  result.audio.players.forEach((player) => {
    add(player.txPin);
    add(player.rxPin);
    add(player.feedback?.pin);
  });
  if (result.ir?.enabled) {
    add(result.ir.txPin);
    add(result.ir.rxPin);
  }
  const availableOutputPins = BOARD_PROFILES[project.board].digitalPins.filter(
    (pin) => !used.has(pin),
  );
  return {
    project: result,
    issues: validateFixedPins(result),
    availableOutputPins,
    maxOutputs: Math.min(
      LIMITS.outputs,
      result.outputs.length + availableOutputPins.length,
    ),
  };
}

function templateProject(config: WiringConfiguration): SceneProject {
  return {
    version: 1,
    name: config.name,
    board: config.board,
    wiring: "fixed",
    initialStateId: "wiring-idle",
    wiringConfiguration: { id: config.id, name: config.name },
    outputs: config.outputs,
    triggers: config.triggers,
    ir: config.ir ? { ...config.ir, commands: [] } : undefined,
    audio: {
      players: config.players,
      ambientTrack: null,
      ambientVolume: 30,
      keepAmbient: false,
      fadeMs: 0,
      transitionMode: "cut",
      tracks: [],
    },
    states: [
      {
        id: "wiring-idle",
        name: "Idle",
        durationMs: 1000,
        loopTimeline: false,
        foregroundTrack: null,
        volume: 30,
        loopAudio: false,
        events: [],
        transitions: [],
      },
    ],
  };
}

/** Saved wiring files are hardware-only and validated before entering the editor. */
export function validateWiringConfiguration(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  if (!record(value))
    return [error("configuration", "Expected a wiring configuration object.")];
  const keys = (
    item: Record<string, unknown>,
    allowed: string[],
    path: string,
  ) => {
    Object.keys(item).forEach((key) => {
      if (!allowed.includes(key))
        issues.push(
          error(
            `${path}.${key}`,
            "Wiring configurations contain hardware settings only; scene, media and command data are not allowed.",
          ),
        );
    });
  };
  keys(
    value,
    ["version", "id", "name", "board", "outputs", "triggers", "players", "ir"],
    "configuration",
  );
  if (value.version !== 1)
    issues.push(
      error(
        "version",
        "Unsupported wiring configuration version. Expected version 1.",
      ),
    );
  for (const key of ["id", "name"] as const)
    if (
      typeof value[key] !== "string" ||
      !value[key].trim() ||
      value[key].length > (key === "id" ? 128 : 200)
    )
      issues.push(
        error(
          key,
          `A ${key} of 1–${key === "id" ? 128 : 200} characters is required.`,
        ),
      );
  if (
    typeof value.id === "string" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.id)
  )
    issues.push(
      error(
        "id",
        "Use a 1–128 character identifier containing letters, digits, dots, underscores, colons or hyphens.",
      ),
    );
  if (
    typeof value.board !== "string" ||
    !Object.hasOwn(BOARD_PROFILES, value.board)
  )
    issues.push(error("board", "Choose an Uno, Nano, Pro Mini or Mega board."));
  for (const [key, limit] of [
    ["outputs", LIMITS.outputs],
    ["triggers", LIMITS.triggers],
    ["players", LIMITS.players],
  ] as const) {
    if (!Array.isArray(value[key]) || value[key].length > limit)
      issues.push(error(key, `Expected at most ${limit} ${key}.`));
  }
  if (issues.length) return issues;
  (value.outputs as unknown[]).forEach((item, index) => {
    if (record(item))
      keys(
        item,
        [
          "id",
          "name",
          "pin",
          "activeLow",
          "idleActive",
          "color",
          "enabled",
          "standardSlot",
          "configurationSlot",
        ],
        `outputs.${index}`,
      );
  });
  (value.triggers as unknown[]).forEach((item, index) => {
    if (!record(item)) return;
    keys(
      item,
      [
        "id",
        "name",
        "kind",
        "pin",
        "echoPin",
        "activeLow",
        "pullup",
        "debounceMs",
        "thresholdCm",
        "hysteresisCm",
        "enabled",
        "standardSlot",
        "configurationSlot",
      ],
      `triggers.${index}`,
    );
    if (!["button", "pir", "ultrasonic"].includes(String(item.kind)))
      issues.push(
        error(
          `triggers.${index}.kind`,
          "Wiring configurations contain physical triggers only; manual and timer triggers belong to the scene.",
        ),
      );
  });
  (value.players as unknown[]).forEach((item, index) => {
    if (!record(item)) return;
    keys(
      item,
      ["id", "kind", "txPin", "rxPin", "feedback"],
      `players.${index}`,
    );
    if (record(item.feedback))
      keys(item.feedback, ["pin", "activeLow"], `players.${index}.feedback`);
  });
  if (value.ir !== undefined && !record(value.ir))
    issues.push(error("ir", "Expected IR hardware settings."));
  if (record(value.ir)) keys(value.ir, ["enabled", "txPin", "rxPin"], "ir");
  const project = templateProject(value as unknown as WiringConfiguration);
  const structure = validateProjectStructure(project);
  if (structure.length) return [...issues, ...structure];
  for (const [path, devices] of [
    ["outputs", project.outputs],
    ["triggers", project.triggers],
  ] as const) {
    const seen = new Set<string>();
    devices.forEach((device, index) => {
      const identity = slotId(device);
      if (!identity.trim() || identity.length > 128)
        issues.push(
          error(
            `${path}.${index}.configurationSlot`,
            "Slot identifiers must contain 1–128 characters.",
          ),
        );
      if (seen.has(identity))
        issues.push(
          error(
            `${path}.${index}.configurationSlot`,
            `Duplicate configuration slot: ${identity}.`,
          ),
        );
      seen.add(identity);
    });
  }
  return [...issues, ...validateProject(project)];
}

export function parseWiringConfiguration(value: unknown): WiringConfiguration {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const issues = validateWiringConfiguration(parsed).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  return structuredClone(parsed) as WiringConfiguration;
}

function hardwareTrigger(trigger: TriggerConfig): TriggerConfig {
  const {
    zones: _zones,
    distanceMode: _mode,
    timerIntervalMs: _interval,
    timerResetOnTrigger: _reset,
    ...hardware
  } = trigger;
  return { ...hardware, configurationSlot: slotId(trigger) };
}

export function captureWiringConfiguration(
  project: SceneProject,
  name: string,
  id = `wiring-${crypto.randomUUID()}`,
): WiringConfiguration {
  const shape = validateProjectStructure(project);
  if (shape.length)
    throw new Error(shape.map((issue) => issue.message).join("\n"));
  return parseWiringConfiguration({
    version: 1,
    id,
    name,
    board: project.board,
    outputs: project.outputs.map((output) => ({
      ...output,
      configurationSlot: slotId(output),
    })),
    triggers: project.triggers.filter(physical).map(hardwareTrigger),
    players: structuredClone(project.audio.players),
    ...(project.ir
      ? {
          ir: {
            enabled: project.ir.enabled,
            txPin: project.ir.txPin,
            rxPin: project.ir.rxPin,
          },
        }
      : {}),
  });
}

const freeId = (base: string, used: Set<string>): string => {
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
  used.add(id);
  return id;
};

/**
 * Stable slots match first, then unique names and legacy device order. Explicit
 * identities never fall back to arbitrary order. Template electrical settings
 * replace wiring/polarity; existing names, IDs, enabled flags and scene/detection
 * settings stay attached to their original device.
 */
export function applyWiringConfiguration(
  project: SceneProject,
  value: WiringConfiguration,
): SceneProject {
  const config = parseWiringConfiguration(value);
  const structure = validateProjectStructure(project);
  if (structure.length)
    throw new Error(structure.map((issue) => issue.message).join("\n"));
  if (requiredPlayerCount(project) > config.players.length)
    throw new Error(
      `These audio settings need ${requiredPlayerCount(project)} MP3 players; this wiring configuration supplies ${config.players.length}. Change audio settings or choose another configuration.`,
    );
  const result = structuredClone(project);
  const referencedOutputs = new Set(
    project.states.flatMap((state) =>
      state.events.map((event) => event.outputId),
    ),
  );
  const referencedTriggers = new Set(
    project.states.flatMap((state) =>
      state.transitions.map((transition) => transition.triggerId),
    ),
  );
  const reconcile = <T extends SlotDevice>(
    old: T[],
    templates: T[],
    referenced: Set<string>,
    label: string,
    reservedIds: Iterable<string> = old.map((item) => item.id),
  ): T[] => {
    const matched = new Map<T, T>();
    const available = new Set(templates);
    const sameKind = (left: T, right: T) =>
      !("kind" in left) || ("kind" in right && left.kind === right.kind);
    const identity = (item: T) => item.configurationSlot ?? item.standardSlot;
    const attach = (item: T, candidate: T) => {
      matched.set(item, candidate);
      available.delete(candidate);
    };
    for (const item of old) {
      const key = identity(item);
      if (!key) continue;
      const candidates = [...available].filter(
        (candidate) => slotId(candidate) === key,
      );
      if (candidates.length > 1)
        throw new Error(`Ambiguous ${label} slot ${key}.`);
      if (candidates[0]) {
        if (!sameKind(item, candidates[0]))
          throw new Error(
            `The ${item.name} slot changes sensor type. Choose a matching configuration; existing scene references cannot be retargeted.`,
          );
        attach(item, candidates[0]);
      }
    }
    for (const item of old.filter((candidate) => !matched.has(candidate))) {
      const candidates = [...available].filter(
        (candidate) =>
          sameKind(item, candidate) &&
          candidate.name.trim().toLowerCase() ===
            item.name.trim().toLowerCase(),
      );
      if (candidates.length > 1)
        throw new Error(
          `Ambiguous ${label} name "${item.name}". Assign distinct names or stable configuration slots first.`,
        );
      if (candidates[0]) attach(item, candidates[0]);
    }
    for (const item of old.filter(
      (candidate) => !matched.has(candidate) && !identity(candidate),
    )) {
      const candidate = [...available].find((candidate) =>
        sameKind(item, candidate),
      );
      if (candidate) attach(item, candidate);
    }
    for (const item of old.filter((candidate) => !matched.has(candidate))) {
      const hasZones =
        "zones" in item &&
        item.zones?.some((zone) => zone.onEnter.length || zone.onExit.length);
      if (item.enabled !== false || referenced.has(item.id) || hasZones)
        throw new Error(
          `This configuration has no matching slot for ${label} "${item.name}". Enabled or referenced devices cannot be removed; use a compatible configuration.`,
        );
    }
    const used = new Set(reservedIds);
    const kept: T[] = old
      .filter((item) => matched.has(item))
      .map((item) => {
        const template = matched.get(item)!;
        const next = {
          ...item,
          configurationSlot: slotId(template),
          pin: template.pin,
          activeLow: template.activeLow,
        };
        // standardSlot is legacy metadata; leaving it would incorrectly reapply
        // old Uno pin semantics when changing configuration or board.
        delete next.standardSlot;
        if ("kind" in next && "kind" in template) {
          next.echoPin = template.echoPin;
          next.pullup = template.pullup;
        }
        return next;
      });
    for (const template of available) {
      const next = {
        ...structuredClone(template),
        id: freeId(`configuration-${slotId(template)}`, used),
        configurationSlot: slotId(template),
      };
      delete next.standardSlot;
      kept.push(next);
    }
    return kept;
  };
  result.outputs = reconcile(
    result.outputs,
    config.outputs,
    referencedOutputs,
    "output",
  );
  const manual = result.triggers.filter((trigger) => !physical(trigger));
  const configured = reconcile(
    result.triggers.filter(physical),
    config.triggers,
    referencedTriggers,
    "trigger",
    result.triggers.map((trigger) => trigger.id),
  );
  const existingOrder = new Map(
    project.triggers.map((trigger, index) => [trigger.id, index]),
  );
  result.triggers = [...configured, ...manual].sort(
    (left, right) =>
      (existingOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (existingOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const playerIds = new Set<string>();
  result.audio.players = config.players.map((player, index) => ({
    ...structuredClone(player),
    id: freeId(project.audio.players[index]?.id ?? player.id, playerIds),
  }));
  const fixedIr = irPins(config.board);
  result.ir = {
    ...(result.ir ?? { commands: [] }),
    enabled: config.ir?.enabled ?? false,
    txPin: config.ir?.txPin ?? fixedIr.txPin,
    rxPin: config.ir?.rxPin ?? fixedIr.rxPin,
  };
  result.board = config.board;
  result.wiring = "fixed";
  result.wiringConfiguration = { id: config.id, name: config.name };
  const wiringIssues = validateFixedPins(result);
  if (
    result.triggers.filter((trigger) => trigger.enabled !== false).length >
    LIMITS.triggers
  )
    wiringIssues.push(
      error(
        "triggers",
        `This scene plus the new hardware exceeds ${LIMITS.triggers} enabled triggers. Disable unused inputs or remove unused manual/timer triggers first.`,
      ),
    );
  if (
    result.states.some((state) => state.audioEndStateId != null) &&
    result.audio.players.some((player) => !player.feedback)
  )
    wiringIssues.push(
      error(
        "audio.players",
        "This scene uses audio-end transitions. Its wiring configuration needs BUSY feedback for every MP3 player.",
      ),
    );
  if (wiringIssues.length)
    throw new Error(wiringIssues.map((issue) => issue.message).join("\n"));
  return result;
}

function makeBuiltins(): WiringConfiguration[] {
  const output = (
    id: string,
    name: string,
    pin: number,
    enabled = true,
  ): OutputConfig => ({
    id,
    configurationSlot: id,
    name,
    pin,
    enabled,
    activeLow: false,
    idleActive: false,
    color: "#60a5fa",
  });
  const trigger = (
    id: string,
    name: string,
    kind: "button" | "pir" | "ultrasonic",
    pin: number,
    echoPin: number | null = null,
    enabled = true,
  ): TriggerConfig => ({
    id,
    configurationSlot: id,
    name,
    kind,
    pin,
    echoPin,
    enabled,
    activeLow: kind === "button",
    pullup: kind === "button",
    debounceMs: kind === "button" ? 0 : 100,
    thresholdCm: 100,
    hysteresisCm: 20,
  });
  const configurations: WiringConfiguration[] = [];
  for (const board of ["uno", "nano", "pro-mini"] as const) {
    const label = { uno: "Uno", nano: "Classic Nano", "pro-mini": "Pro Mini" }[
      board
    ];
    const standard: WiringConfiguration = {
      version: 1,
      id: `${board}-standard`,
      name: `${label} — standard`,
      board,
      outputs: STANDARD_OUTPUT_SLOTS.map((slot) =>
        output(slot.id, slot.label, slot.pin, slot.id !== "spare"),
      ),
      triggers: STANDARD_TRIGGER_SLOTS.map((slot) =>
        trigger(
          slot.id,
          slot.label,
          slot.kind,
          slot.pin,
          slot.echoPin,
          !slot.id.startsWith("backup-"),
        ),
      ),
      players: [{ id: "player-1", kind: "dfplayer", txPin: 3, rxPin: 8 }],
      ir: { enabled: true, txPin: 9, rxPin: 2 },
    };
    const dual = structuredClone(standard);
    dual.id = `${board}-dual-beam`;
    dual.name = `${label} — dual beam`;
    dual.outputs = dual.outputs.filter(
      (item) => item.configurationSlot !== "spare",
    );
    dual.triggers.push(
      trigger("second-beam", "Second beam contact", "button", 19),
    );
    const motion = structuredClone(standard);
    motion.id = `${board}-motion`;
    motion.name = `${label} — extra motion, no IR`;
    motion.ir!.enabled = false;
    motion.triggers.push(
      trigger("extra-pir-1", "Extra PIR 1", "pir", 2),
      trigger("extra-pir-2", "Extra PIR 2", "pir", 9),
    );
    configurations.push(standard, dual, motion);
  }
  configurations.push({
    version: 1,
    id: "mega-standard",
    name: "Mega — expanded standard",
    board: "mega",
    outputs: [
      ...[7, 6, 5, 4].map((pin, index) =>
        output(`relay-${index + 1}`, `Shield relay ${index + 1}`, pin),
      ),
      output("dc-ssr", "12 V DC SSR", 30),
      output("ac-ssr", "AC strobe SSR", 31),
      ...Array.from({ length: 10 }, (_, index) =>
        output(
          `extra-output-${index + 1}`,
          `Extra output ${index + 1}`,
          32 + index,
          false,
        ),
      ),
    ],
    triggers: [
      trigger("beam", "Beam contact", "button", 22),
      trigger("second-beam", "Second beam contact", "button", 23),
      trigger("primary-pir", "Primary PIR", "pir", 24),
      trigger("backup-pir", "Backup PIR", "pir", 25, null, false),
      trigger("primary-ultrasonic", "Primary ultrasonic", "ultrasonic", 26, 27),
      trigger(
        "backup-ultrasonic",
        "Backup ultrasonic",
        "ultrasonic",
        28,
        29,
        false,
      ),
    ],
    players: [
      { id: "player-1", kind: "dfplayer", txPin: 18, rxPin: 19 },
      { id: "player-2", kind: "dfplayer", txPin: 16, rxPin: 17 },
      { id: "player-3", kind: "dfplayer", txPin: 14, rxPin: 15 },
    ],
    ir: { enabled: true, txPin: 11, rxPin: 2 },
  });
  return configurations;
}

export const BUILT_IN_WIRING_CONFIGURATIONS: readonly WiringConfiguration[] =
  makeBuiltins();
export function isBuiltinWiringConfigurationId(id: string): boolean {
  return BUILT_IN_WIRING_CONFIGURATIONS.some(
    (configuration) => configuration.id === id,
  );
}
