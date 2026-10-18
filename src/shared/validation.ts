import {
  BOARD_PROFILES,
  feedbackPins,
  irPins,
  requiredPlayerCount,
  SHIELD_PINS,
} from "./boards";
import { irCommandDurationMs, validateIrSignal } from "./ir";
import { expandIrEvents } from "./ir-macros";
import { timerInterval, transitionTargets } from "./scene-controls";
import { childOutputOwners, isChildState } from "./parallel-children";
import { validateFixedPins } from "./wiring-configurations";
import {
  STANDARD_OUTPUT_SLOTS,
  STANDARD_TRIGGER_SLOTS,
  toRuntimeProject,
  validateStandardHarness,
} from "./standard-harness";
import {
  isZonedTrigger,
  LIMITS,
  type SceneProject,
  type ValidationIssue,
} from "./model";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation is separate so an editable project can exceed board capacity. */
export function validateProjectStructure(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string) =>
    issues.push({ path, message, severity: "error" });
  const object = (
    candidate: unknown,
    path: string,
  ): Record<string, unknown> | null => {
    if (!record(candidate)) {
      fail(path, "Expected an object.");
      return null;
    }
    return candidate;
  };
  const text = (candidate: unknown, path: string, optional = false) => {
    if (optional && candidate === undefined) return;
    if (typeof candidate !== "string" || candidate.length > 32768)
      fail(path, "Expected a string of at most 32,768 characters.");
  };
  const number = (candidate: unknown, path: string, nullable = false) => {
    if (nullable && candidate === null) return;
    if (typeof candidate !== "number" || !Number.isFinite(candidate))
      fail(path, "Expected a finite number.");
  };
  const boolean = (candidate: unknown, path: string) => {
    if (typeof candidate !== "boolean") fail(path, "Expected true or false.");
  };
  const enumeration = (candidate: unknown, values: string[], path: string) => {
    if (typeof candidate !== "string" || !values.includes(candidate))
      fail(path, `Expected one of: ${values.join(", ")}.`);
  };
  const array = (
    candidate: unknown,
    path: string,
    maximum: number,
  ): unknown[] => {
    if (!Array.isArray(candidate)) {
      fail(path, "Expected an array.");
      return [];
    }
    if (candidate.length > maximum) {
      fail(path, `File exceeds the import limit of ${maximum} entries.`);
      return [];
    }
    return candidate;
  };
  const project = object(value, "project");
  if (!project) return issues;
  if (project.version !== 1)
    fail("version", "Unsupported project version. Expected version 1.");
  text(project.name, "name");
  enumeration(project.board, Object.keys(BOARD_PROFILES), "board");
  enumeration(
    project.wiring,
    ["custom", "relay-shield", "standard-uno", "fixed"],
    "wiring",
  );
  text(project.initialStateId, "initialStateId");
  if (project.wiringConfiguration !== undefined) {
    const configuration = object(
      project.wiringConfiguration,
      "wiringConfiguration",
    );
    if (configuration) {
      text(configuration.id, "wiringConfiguration.id");
      text(configuration.name, "wiringConfiguration.name");
    }
  }
  array(project.outputs, "outputs", 256).forEach((candidate, index) => {
    const path = `outputs.${index}`;
    const output = object(candidate, path);
    if (!output) return;
    text(output.id, `${path}.id`);
    text(output.name, `${path}.name`);
    text(output.color, `${path}.color`);
    number(output.pin, `${path}.pin`, true);
    boolean(output.activeLow, `${path}.activeLow`);
    boolean(output.idleActive, `${path}.idleActive`);
    if (output.enabled !== undefined)
      boolean(output.enabled, `${path}.enabled`);
    text(output.configurationSlot, `${path}.configurationSlot`, true);
    if (output.standardSlot !== undefined)
      enumeration(
        output.standardSlot,
        STANDARD_OUTPUT_SLOTS.map((slot) => slot.id),
        `${path}.standardSlot`,
      );
  });
  array(project.triggers, "triggers", 256).forEach((candidate, index) => {
    const path = `triggers.${index}`;
    const trigger = object(candidate, path);
    if (!trigger) return;
    text(trigger.id, `${path}.id`);
    text(trigger.name, `${path}.name`);
    enumeration(
      trigger.kind,
      ["button", "pir", "ultrasonic", "timer", "manual"],
      `${path}.kind`,
    );
    number(trigger.pin, `${path}.pin`, true);
    number(trigger.echoPin, `${path}.echoPin`, true);
    boolean(trigger.activeLow, `${path}.activeLow`);
    boolean(trigger.pullup, `${path}.pullup`);
    number(trigger.debounceMs, `${path}.debounceMs`);
    number(trigger.thresholdCm, `${path}.thresholdCm`);
    number(trigger.hysteresisCm, `${path}.hysteresisCm`);
    if (trigger.enabled !== undefined)
      boolean(trigger.enabled, `${path}.enabled`);
    text(trigger.configurationSlot, `${path}.configurationSlot`, true);
    if (trigger.standardSlot !== undefined)
      enumeration(
        trigger.standardSlot,
        STANDARD_TRIGGER_SLOTS.map((slot) => slot.id),
        `${path}.standardSlot`,
      );
    if (trigger.timerIntervalMs !== undefined)
      number(trigger.timerIntervalMs, `${path}.timerIntervalMs`);
    if (trigger.timerResetOnTrigger !== undefined)
      boolean(trigger.timerResetOnTrigger, `${path}.timerResetOnTrigger`);
    if (trigger.distanceMode !== undefined)
      enumeration(
        trigger.distanceMode,
        ["threshold", "zones"],
        `${path}.distanceMode`,
      );
    if (trigger.zones !== undefined)
      array(trigger.zones, `${path}.zones`, 256).forEach(
        (candidate, zoneIndex) => {
          const zonePath = `${path}.zones.${zoneIndex}`;
          const zone = object(candidate, zonePath);
          if (!zone) return;
          text(zone.id, `${zonePath}.id`);
          text(zone.name, `${zonePath}.name`);
          number(zone.minCm, `${zonePath}.minCm`);
          number(zone.maxCm, `${zonePath}.maxCm`);
          number(zone.hysteresisCm, `${zonePath}.hysteresisCm`);
          for (const edge of ["onEnter", "onExit"] as const)
            array(zone[edge], `${zonePath}.${edge}`, 256).forEach(
              (entry, actionIndex) => {
                const actionPath = `${zonePath}.${edge}.${actionIndex}`;
                const action = object(entry, actionPath);
                if (!action) return;
                text(action.id, `${actionPath}.id`);
                enumeration(
                  action.kind,
                  ["state", "volume", "ir"],
                  `${actionPath}.kind`,
                );
                if (action.kind === "state")
                  text(action.stateId, `${actionPath}.stateId`);
                if (action.kind === "ir")
                  text(action.commandId, `${actionPath}.commandId`);
                if (action.kind === "volume") {
                  enumeration(
                    action.target,
                    ["ambient", "foreground"],
                    `${actionPath}.target`,
                  );
                  number(action.volume, `${actionPath}.volume`);
                  number(action.fadeMs, `${actionPath}.fadeMs`);
                }
              },
            );
        },
      );
  });
  if (project.ir !== undefined) {
    const ir = object(project.ir, "ir");
    if (ir) {
      boolean(ir.enabled, "ir.enabled");
      number(ir.txPin, "ir.txPin", true);
      number(ir.rxPin, "ir.rxPin", true);
      array(ir.commands, "ir.commands", 256).forEach((candidate, index) => {
        const path = `ir.commands.${index}`;
        const command = object(candidate, path);
        if (!command) return;
        text(command.id, `${path}.id`);
        text(command.name, `${path}.name`);
        number(command.sendCount, `${path}.sendCount`);
        number(command.gapMs, `${path}.gapMs`);
        const signal = object(command.signal, `${path}.signal`);
        if (!signal) return;
        enumeration(signal.kind, ["nec", "raw"], `${path}.signal.kind`);
        if (signal.kind === "nec") number(signal.code, `${path}.signal.code`);
        if (signal.kind === "raw")
          array(signal.pulsesUs, `${path}.signal.pulsesUs`, 1024).forEach(
            (pulse, i) => number(pulse, `${path}.signal.pulsesUs.${i}`),
          );
      });
      if (ir.macros !== undefined)
        array(ir.macros, "ir.macros", 256).forEach((candidate, index) => {
          const path = `ir.macros.${index}`;
          const macro = object(candidate, path);
          if (!macro) return;
          text(macro.id, `${path}.id`);
          text(macro.name, `${path}.name`);
          array(macro.steps, `${path}.steps`, 256).forEach(
            (candidate, stepIndex) => {
              const stepPath = `${path}.steps.${stepIndex}`;
              const step = object(candidate, stepPath);
              if (!step) return;
              text(step.id, `${stepPath}.id`);
              text(step.commandId, `${stepPath}.commandId`);
              number(step.atMs, `${stepPath}.atMs`);
              if (step.macroId !== undefined)
                fail(stepPath, "IR macros cannot contain other macros.");
              if (step.sendCount !== undefined || step.gapMs !== undefined)
                fail(
                  stepPath,
                  "Set press counts and gaps on the named IR command.",
                );
            },
          );
        });
    }
  }
  const audio = object(project.audio, "audio");
  if (audio) {
    number(audio.ambientTrack, "audio.ambientTrack", true);
    number(audio.ambientVolume, "audio.ambientVolume");
    if (audio.ambientMixVolume !== undefined)
      number(audio.ambientMixVolume, "audio.ambientMixVolume");
    number(audio.fadeMs, "audio.fadeMs");
    if (audio.transitionMode !== undefined)
      enumeration(
        audio.transitionMode,
        ["cut", "crossfade", "fade-through"],
        "audio.transitionMode",
      );
    if (audio.fadeOutMs !== undefined)
      number(audio.fadeOutMs, "audio.fadeOutMs");
    if (audio.fadeInMs !== undefined) number(audio.fadeInMs, "audio.fadeInMs");
    boolean(audio.keepAmbient, "audio.keepAmbient");
    array(audio.players, "audio.players", 32).forEach((candidate, index) => {
      const path = `audio.players.${index}`;
      const player = object(candidate, path);
      if (!player) return;
      text(player.id, `${path}.id`);
      enumeration(player.kind, ["dfplayer", "yx5300"], `${path}.kind`);
      number(player.txPin, `${path}.txPin`, true);
      number(player.rxPin, `${path}.rxPin`, true);
      if (player.feedback !== undefined) {
        const feedback = object(player.feedback, `${path}.feedback`);
        if (feedback) {
          number(feedback.pin, `${path}.feedback.pin`, true);
          boolean(feedback.activeLow, `${path}.feedback.activeLow`);
        }
      }
    });
    array(audio.tracks, "audio.tracks", 10000).forEach((candidate, index) => {
      const path = `audio.tracks.${index}`;
      const track = object(candidate, path);
      if (!track) return;
      number(track.number, `${path}.number`);
      text(track.name, `${path}.name`);
      text(track.path, `${path}.path`, true);
      text(track.trimmedPath, `${path}.trimmedPath`, true);
      if (track.durationMs !== undefined)
        number(track.durationMs, `${path}.durationMs`);
      if (track.trimStartMs !== undefined)
        number(track.trimStartMs, `${path}.trimStartMs`);
      if (track.trimEndMs !== undefined)
        number(track.trimEndMs, `${path}.trimEndMs`, true);
    });
  }
  const stateEntries = array(project.states, "states", 64);
  if (Array.isArray(project.states) && project.states.length === 0)
    fail("states", "A project must contain at least one state.");
  stateEntries.forEach((candidate, index) => {
    const path = `states.${index}`;
    const state = object(candidate, path);
    if (!state) return;
    text(state.id, `${path}.id`);
    text(state.name, `${path}.name`);
    if (state.kind !== undefined)
      enumeration(state.kind, ["main", "child"], `${path}.kind`);
    if (state.cooldownMs !== undefined)
      number(state.cooldownMs, `${path}.cooldownMs`);
    number(state.durationMs, `${path}.durationMs`);
    number(state.foregroundTrack, `${path}.foregroundTrack`, true);
    number(state.volume, `${path}.volume`);
    boolean(state.loopTimeline, `${path}.loopTimeline`);
    boolean(state.loopAudio, `${path}.loopAudio`);
    if (state.audioEndStateId !== undefined && state.audioEndStateId !== null)
      text(state.audioEndStateId, `${path}.audioEndStateId`);
    if (state.irEvents !== undefined)
      array(state.irEvents, `${path}.irEvents`, 1024).forEach(
        (candidate, eventIndex) => {
          const eventPath = `${path}.irEvents.${eventIndex}`;
          const event = object(candidate, eventPath);
          if (!event) return;
          text(event.id, `${eventPath}.id`);
          text(event.commandId, `${eventPath}.commandId`, true);
          text(event.macroId, `${eventPath}.macroId`, true);
          number(event.atMs, `${eventPath}.atMs`);
        },
      );
    array(state.events, `${path}.events`, 10000).forEach(
      (entry, eventIndex) => {
        const eventPath = `${path}.events.${eventIndex}`;
        const event = object(entry, eventPath);
        if (!event) return;
        text(event.id, `${eventPath}.id`);
        text(event.outputId, `${eventPath}.outputId`);
        number(event.startMs, `${eventPath}.startMs`);
        number(event.endMs, `${eventPath}.endMs`);
        if (event.active !== undefined)
          boolean(event.active, `${eventPath}.active`);
      },
    );
    array(state.transitions, `${path}.transitions`, 256).forEach(
      (entry, transitionIndex) => {
        const transitionPath = `${path}.transitions.${transitionIndex}`;
        const transition = object(entry, transitionPath);
        if (!transition) return;
        text(transition.triggerId, `${transitionPath}.triggerId`);
        text(transition.targetStateId, `${transitionPath}.targetStateId`);
        if (transition.edge !== undefined)
          enumeration(
            transition.edge,
            ["activate", "release"],
            `${transitionPath}.edge`,
          );
        if (transition.alternateStateIds !== undefined)
          array(
            transition.alternateStateIds,
            `${transitionPath}.alternateStateIds`,
            64,
          ).forEach((id, i) =>
            text(id, `${transitionPath}.alternateStateIds.${i}`),
          );
      },
    );
  });
  return issues;
}

/** Throws only for an unsafe/incompatible shape. Semantic errors remain editable. */
export function parseProject(value: unknown): SceneProject {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const issues = validateProjectStructure(parsed);
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  return structuredClone(parsed) as SceneProject;
}

export function estimateSceneBytes(project: SceneProject): number {
  project = toRuntimeProject(project);
  const zones = project.triggers
    .filter(isZonedTrigger)
    .flatMap((trigger) => trigger.zones ?? []);
  const zoneBytes =
    zones.length || project.ir?.enabled
      ? (project.ir?.enabled ? 16 : 8) +
        zones.length * 10 +
        zones.reduce(
          (sum, zone) => sum + zone.onEnter.length + zone.onExit.length,
          0,
        ) *
          6
      : 0;
  const irBytes = project.ir?.enabled
    ? project.ir.commands.reduce(
        (sum, command) =>
          sum +
          12 +
          (command.signal.kind === "raw" ? command.signal.pulsesUs.length : 0),
        0,
      ) +
      project.states.reduce(
        (sum, state) =>
          sum + expandedIrEventCount(project, state.irEvents ?? []) * 4,
        0,
      )
    : 0;
  return (
    32 +
    zoneBytes +
    irBytes +
    project.outputs.length * 2 +
    project.triggers.length * 8 +
    project.audio.players.length * 4 +
    project.states.length * 16 +
    project.states.reduce(
      (sum, state) =>
        sum +
        state.events.length * 6 +
        state.transitions.reduce(
          (count, transition) =>
            count + transitionTargets(transition).length * 2,
          0,
        ),
      0,
    )
  );
}

/** Drafts can contain broken references; validation reports them separately. */
function expandedIrEventCount(
  project: SceneProject,
  events: NonNullable<SceneProject["states"][number]["irEvents"]>,
): number {
  const macros = new Map(project.ir?.macros?.map((macro) => [macro.id, macro]));
  return events.reduce(
    (count, event) =>
      count +
      (event.macroId !== undefined
        ? (macros.get(event.macroId)?.steps.length ?? 1)
        : 1),
    0,
  );
}

export function validateProject(value: unknown): ValidationIssue[] {
  const structural = validateProjectStructure(value);
  if (structural.length) return structural;
  const project = value as SceneProject;
  const runtime = toRuntimeProject(project);
  const issues: ValidationIssue[] = [
    ...validateStandardHarness(project),
    ...validateFixedPins(project),
  ];
  const fail = (
    path: string,
    message: string,
    severity: "error" | "warning" = "error",
  ) => issues.push({ path, message, severity });
  const integer = (n: number, min: number, max: number, path: string) => {
    if (!Number.isInteger(n) || n < min || n > max)
      fail(path, `Must be a whole number from ${min} to ${max}.`);
  };
  const ticks = (n: number, min: number, max: number, path: string) => {
    integer(n, min, max, path);
    if (n % LIMITS.tickMs !== 0)
      fail(path, `Must align to a ${LIMITS.tickMs} ms tick.`);
  };
  const nonempty = (s: string, path: string) => {
    if (!s.trim()) fail(path, "Cannot be empty.");
  };
  const uniqueIds = (items: Array<{ id: string }>, path: string) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      nonempty(item.id, `${path}.${index}.id`);
      if (item.id.length > 128)
        fail(`${path}.${index}.id`, "IDs are limited to 128 characters.");
      if (seen.has(item.id))
        fail(`${path}.${index}.id`, `Duplicate ID: ${item.id}.`);
      seen.add(item.id);
    });
  };
  nonempty(project.name, "name");
  integer(runtime.outputs.length, 0, LIMITS.outputs, "outputs");
  integer(runtime.triggers.length, 0, LIMITS.triggers, "triggers");
  integer(project.audio.players.length, 0, LIMITS.players, "audio.players");
  integer(runtime.states.length, 1, LIMITS.states, "states");
  uniqueIds(project.outputs, "outputs");
  uniqueIds(project.triggers, "triggers");
  uniqueIds(project.audio.players, "audio.players");
  uniqueIds(project.states, "states");
  const stateIds = new Set(project.states.map((state) => state.id));
  const childIds = new Set(
    project.states.filter(isChildState).map((state) => state.id),
  );
  const outputOwners = childOutputOwners(project);
  let totalZones = 0;
  let totalZoneActions = 0;
  const profile = BOARD_PROFILES[project.board];
  const used = new Map<number, string>();
  const claimPin = (
    pin: number | null,
    path: string,
    allowedPins = profile.digitalPins,
  ) => {
    if (pin === null) {
      fail(path, "Assign a GPIO pin.");
      return;
    }
    if (!Number.isInteger(pin) || !allowedPins.includes(pin)) {
      fail(path, "Pin is not a digital-capable GPIO on this board.");
      return;
    }
    if (profile.reservedPins.includes(pin))
      fail(path, "D0/D1 are reserved for the host serial connection.");
    if (used.has(pin))
      fail(path, `Pin D${pin} is already assigned to ${used.get(pin)}.`);
    used.set(pin, path);
  };
  const irCommands = new Map(
    project.ir?.commands.map((command) => [command.id, command]) ?? [],
  );
  const irMacros = new Map(
    project.ir?.macros?.map((macro) => [macro.id, macro]),
  );
  const irReference = (id: string, path: string) => {
    if (
      !project.ir?.enabled &&
      project.wiring !== "standard-uno" &&
      project.wiring !== "fixed"
    )
      fail(path, "Enable IR hardware before using an IR command.");
    if (!irCommands.has(id))
      fail(path, "IR command does not exist in the project library.");
  };
  if (project.ir) {
    integer(project.ir.commands.length, 0, LIMITS.irCommands, "ir.commands");
    uniqueIds(project.ir.commands, "ir.commands");
    project.ir.commands.forEach((command, index) => {
      const path = `ir.commands.${index}`;
      nonempty(command.name, `${path}.name`);
      if (command.name.length > 200)
        fail(`${path}.name`, "Command names are limited to 200 characters.");
      if (!validateIrSignal(command.signal))
        fail(
          `${path}.signal`,
          "Use a 32-bit NEC frame or 5–127 alternating 38 kHz raw pulses in 50 μs steps, 100–12,750 μs each and at most 200 ms total.",
        );
      integer(command.sendCount, 1, 10, `${path}.sendCount`);
      ticks(command.gapMs, 50, 2000, `${path}.gapMs`);
    });
    const macros = project.ir.macros ?? [];
    integer(macros.length, 0, LIMITS.irMacros, "ir.macros");
    uniqueIds(macros, "ir.macros");
    macros.forEach((macro, index) => {
      const path = `ir.macros.${index}`;
      nonempty(macro.name, `${path}.name`);
      if (macro.name.length > 200)
        fail(`${path}.name`, "Macro names are limited to 200 characters.");
      integer(macro.steps.length, 1, LIMITS.irMacroSteps, `${path}.steps`);
      uniqueIds(macro.steps, `${path}.steps`);
      macro.steps.forEach((step, stepIndex) => {
        const stepPath = `${path}.steps.${stepIndex}`;
        ticks(
          step.atMs,
          0,
          LIMITS.maxDurationMs - LIMITS.tickMs,
          `${stepPath}.atMs`,
        );
        if (!irCommands.has(step.commandId))
          fail(
            `${stepPath}.commandId`,
            "IR command does not exist in the project library.",
          );
      });
    });
    if (project.ir.enabled) {
      const fixed = irPins(project.board);
      claimPin(project.ir.txPin, "ir.txPin");
      claimPin(project.ir.rxPin, "ir.rxPin");
      if (project.ir.txPin !== fixed.txPin || project.ir.rxPin !== fixed.rxPin)
        fail(
          "ir",
          `IR on this board requires TX D${fixed.txPin} and RX D${fixed.rxPin}.`,
        );
    }
  }
  project.outputs.forEach((output, index) => {
    nonempty(output.name, `outputs.${index}.name`);
    if (!/^#[0-9a-f]{6}$/i.test(output.color))
      fail(
        `outputs.${index}.color`,
        "Use a six-digit hex color, such as #60a5fa.",
      );
    if (output.enabled !== false) claimPin(output.pin, `outputs.${index}.pin`);
    if (output.idleActive && outputOwners.has(output.id))
      fail(
        `outputs.${index}.idleActive`,
        "Outputs reserved by a child sequence must be off when idle.",
      );
    if (
      project.wiring === "relay-shield" &&
      index < 4 &&
      output.pin !== SHIELD_PINS[index]
    ) {
      fail(
        `outputs.${index}.pin`,
        `Relay shield channel ${index + 1} must use D${SHIELD_PINS[index]}.`,
      );
    }
  });
  if (project.wiring === "relay-shield" && project.outputs.length < 4)
    fail(
      "outputs",
      "The relay shield preset requires at least four output channels.",
    );
  project.triggers.forEach((trigger, index) => {
    const path = `triggers.${index}`;
    nonempty(trigger.name, `${path}.name`);
    if (trigger.kind === "manual") {
      if (trigger.pin !== null || trigger.echoPin !== null)
        fail(path, "Manual triggers do not use GPIO pins.");
      return;
    }
    if (trigger.kind === "timer") {
      if (trigger.pin !== null || trigger.echoPin !== null)
        fail(path, "Timer triggers do not use GPIO pins.");
      ticks(
        timerInterval(trigger),
        50,
        LIMITS.maxDurationMs,
        `${path}.timerIntervalMs`,
      );
      return;
    }
    if (trigger.enabled !== false) claimPin(trigger.pin, `${path}.pin`);
    ticks(trigger.debounceMs, 0, 12750, `${path}.debounceMs`);
    integer(trigger.thresholdCm, 2, 400, `${path}.thresholdCm`);
    integer(trigger.hysteresisCm, 1, 255, `${path}.hysteresisCm`);
    if (trigger.kind === "ultrasonic") {
      if (trigger.enabled !== false)
        claimPin(trigger.echoPin, `${path}.echoPin`);
      if (trigger.activeLow || trigger.pullup)
        fail(
          path,
          "HC-SR04 uses an active-high trigger pulse and an echo input without pullup.",
        );
      if (trigger.thresholdCm + trigger.hysteresisCm > 400)
        fail(
          `${path}.hysteresisCm`,
          "Release distance must be within the HC-SR04 400 cm range.",
        );
    } else if (trigger.echoPin !== null)
      fail(`${path}.echoPin`, "Only ultrasonic sensors use an echo pin.");
    // Inactive zone presets remain editable without changing their binary image.
    if (isZonedTrigger(trigger)) {
      const zones = trigger.zones ?? [];
      integer(zones.length, 1, LIMITS.zones, `${path}.zones`);
      uniqueIds(zones, `${path}.zones`);
      if (trigger.enabled !== false) totalZones += zones.length;
      zones.forEach((zone, zoneIndex) => {
        const zonePath = `${path}.zones.${zoneIndex}`;
        nonempty(zone.name, `${zonePath}.name`);
        integer(zone.minCm, 2, 400, `${zonePath}.minCm`);
        integer(zone.maxCm, 2, 400, `${zonePath}.maxCm`);
        integer(zone.hysteresisCm, 1, 255, `${zonePath}.hysteresisCm`);
        if (zone.maxCm < zone.minCm)
          fail(zonePath, "Zone end must be at or beyond its beginning.");
        if (
          zones
            .slice(0, zoneIndex)
            .some(
              (other) => zone.minCm <= other.maxCm && other.minCm <= zone.maxCm,
            )
        )
          fail(
            zonePath,
            "Distance ranges for the same sensor cannot overlap. Both endpoints are included.",
          );
        for (const edge of ["onEnter", "onExit"] as const) {
          uniqueIds(zone[edge], `${zonePath}.${edge}`);
          if (trigger.enabled !== false)
            totalZoneActions += zone[edge].filter(
              (action) =>
                !(
                  action.kind === "ir" &&
                  (project.wiring === "standard-uno" ||
                    project.wiring === "fixed") &&
                  !project.ir?.enabled
                ),
            ).length;
          zone[edge].forEach((action, actionIndex) => {
            const actionPath = `${zonePath}.${edge}.${actionIndex}`;
            if (action.kind === "state") {
              if (!stateIds.has(action.stateId))
                fail(`${actionPath}.stateId`, "Target state does not exist.");
              if (childIds.has(action.stateId))
                fail(
                  `${actionPath}.stateId`,
                  "Distance-zone state actions must target a main state, not a child sequence.",
                );
            } else if (action.kind === "ir") {
              irReference(action.commandId, `${actionPath}.commandId`);
            } else {
              integer(action.volume, 0, 30, `${actionPath}.volume`);
              ticks(action.fadeMs, 0, 12750, `${actionPath}.fadeMs`);
              if (
                action.target === "ambient" &&
                project.audio.ambientTrack === null
              )
                fail(
                  actionPath,
                  "No ambient track is configured; this volume action has no effect.",
                  "warning",
                );
              if (
                action.target === "foreground" &&
                !project.states.some(
                  (state) =>
                    state.id !== project.initialStateId &&
                    state.foregroundTrack !== null,
                )
              )
                fail(
                  actionPath,
                  "No foreground tracks are configured; this volume action has no effect.",
                  "warning",
                );
            }
          });
        }
      });
    }
  });
  integer(totalZones, 0, LIMITS.zones, "distanceZones");
  integer(totalZoneActions, 0, LIMITS.zoneActions, "zoneActions");
  project.audio.players.forEach((player, index) => {
    const path = `audio.players.${index}`;
    claimPin(player.txPin, `${path}.txPin`);
    claimPin(player.rxPin, `${path}.rxPin`);
    if (player.feedback)
      claimPin(
        player.feedback.pin,
        `${path}.feedback.pin`,
        feedbackPins(project.board),
      );
    if (profile.uartPairs.length) {
      const pair = profile.uartPairs[index];
      if (!pair || player.txPin !== pair.tx || player.rxPin !== pair.rx)
        fail(
          path,
          "Mega players must use the ordered hardware UART pairs: TX18/RX19, TX16/RX17, TX14/RX15.",
        );
    }
  });
  if (project.board !== "mega" && project.audio.players.length > 1)
    fail(
      "audio.players",
      "Multiple software-serial players need bench validation for command latency and output timing.",
      "warning",
    );
  const tracks = new Set<number>();
  project.audio.tracks.forEach((track, index) => {
    const path = `audio.tracks.${index}`;
    integer(track.number, 1, LIMITS.maxTrack, `audio.tracks.${index}.number`);
    nonempty(track.name, `audio.tracks.${index}.name`);
    if (tracks.has(track.number))
      fail(`audio.tracks.${index}.number`, "Track numbers must be unique.");
    tracks.add(track.number);
    const start = track.trimStartMs ?? 0;
    if (start < 0) fail(`${path}.trimStartMs`, "Start must be zero or later.");
    if (track.durationMs !== undefined) {
      if (track.durationMs <= 0)
        fail(
          `${path}.durationMs`,
          "Source duration must be greater than zero.",
        );
      if (start >= track.durationMs)
        fail(
          `${path}.trimStartMs`,
          "Start must be before the end of the audio.",
        );
    }
    if (track.trimEndMs !== undefined && track.trimEndMs !== null) {
      if (track.trimEndMs <= start)
        fail(`${path}.trimEndMs`, "End must be after start.");
      if (track.durationMs !== undefined && track.trimEndMs > track.durationMs)
        fail(`${path}.trimEndMs`, "End must be within the source audio.");
    }
  });
  const trackReference = (track: number | null, path: string) => {
    if (track === null) return;
    integer(track, 1, LIMITS.maxTrack, path);
    if (!tracks.has(track))
      fail(
        path,
        "Add this track number to the media list. A local preview file is optional.",
      );
  };
  trackReference(project.audio.ambientTrack, "audio.ambientTrack");
  integer(project.audio.ambientVolume, 0, 30, "audio.ambientVolume");
  if (project.audio.ambientMixVolume !== undefined)
    integer(project.audio.ambientMixVolume, 0, 30, "audio.ambientMixVolume");
  ticks(project.audio.fadeMs, 0, 12750, "audio.fadeMs");
  if (project.audio.fadeOutMs !== undefined)
    ticks(project.audio.fadeOutMs, 0, 12750, "audio.fadeOutMs");
  if (project.audio.fadeInMs !== undefined)
    ticks(project.audio.fadeInMs, 0, 12750, "audio.fadeInMs");
  const requiredPlayers = requiredPlayerCount(project);
  if (project.audio.players.length < requiredPlayers)
    fail(
      "audio.players",
      `These audio settings require ${requiredPlayers} MP3 player${requiredPlayers === 1 ? "" : "s"}.`,
    );
  const states = new Set(project.states.map((state) => state.id));
  const outputs = new Set(project.outputs.map((output) => output.id));
  const triggers = new Set(project.triggers.map((trigger) => trigger.id));
  if (!states.has(project.initialStateId))
    fail("initialStateId", "Initial state does not exist.");
  if (childIds.has(project.initialStateId))
    fail("initialStateId", "A child sequence cannot be the initial state.");
  project.states.forEach((state, stateIndex) => {
    const path = `states.${stateIndex}`;
    nonempty(state.name, `${path}.name`);
    ticks(state.durationMs, 50, LIMITS.maxDurationMs, `${path}.durationMs`);
    if (state.cooldownMs !== undefined)
      ticks(state.cooldownMs, 0, LIMITS.maxDurationMs, `${path}.cooldownMs`);
    if (isChildState(state)) {
      if (!state.events.length)
        fail(
          `${path}.events`,
          "A child sequence needs at least one output event.",
        );
      if (state.loopTimeline)
        fail(
          `${path}.loopTimeline`,
          "A child sequence runs its timeline once; it cannot loop.",
        );
      if (state.foregroundTrack !== null)
        fail(`${path}.foregroundTrack`, "A child sequence cannot play audio.");
      if (state.loopAudio)
        fail(`${path}.loopAudio`, "A child sequence cannot loop audio.");
      if (state.irEvents?.length)
        fail(`${path}.irEvents`, "A child sequence cannot send IR commands.");
      if (state.transitions.length)
        fail(
          `${path}.transitions`,
          "A child sequence cannot have transitions or start other children.",
        );
      if (state.audioEndStateId != null)
        fail(
          `${path}.audioEndStateId`,
          "A child sequence cannot have an audio-end transition.",
        );
    } else if (state.cooldownMs !== undefined && state.cooldownMs !== 0) {
      fail(`${path}.cooldownMs`, "Cooldown applies only to child sequences.");
    }
    trackReference(state.foregroundTrack, `${path}.foregroundTrack`);
    integer(state.volume, 0, 30, `${path}.volume`);
    if (state.id === project.initialStateId && state.foregroundTrack !== null)
      fail(
        `${path}.foregroundTrack`,
        "The initial state uses the global ambient track, not a foreground track.",
      );
    if (state.audioEndStateId !== undefined && state.audioEndStateId !== null) {
      if (!states.has(state.audioEndStateId))
        fail(
          `${path}.audioEndStateId`,
          "Audio-end target state does not exist.",
        );
      if (childIds.has(state.audioEndStateId))
        fail(
          `${path}.audioEndStateId`,
          "An audio-end transition must target a main state, not a child sequence.",
        );
      if (
        state.id === project.initialStateId ||
        state.foregroundTrack === null ||
        state.loopAudio
      )
        fail(
          `${path}.audioEndStateId`,
          "Audio-end transitions require a nonlooping foreground track outside the initial state.",
        );
      if (
        !project.audio.players.length ||
        project.audio.players.some((player) => !player.feedback)
      )
        fail(
          `${path}.audioEndStateId`,
          "Enable and wire BUSY feedback for every MP3 player before using audio-end transitions.",
        );
    }
    uniqueIds(state.events, `${path}.events`);
    const irEvents = state.irEvents ?? [];
    uniqueIds(irEvents, `${path}.irEvents`);
    let canExpandIr =
      expandedIrEventCount(project, irEvents) <= LIMITS.irEvents &&
      !(
        (project.wiring === "standard-uno" || project.wiring === "fixed") &&
        !project.ir?.enabled
      );
    irEvents.forEach((event, index) => {
      const eventPath = `${path}.irEvents.${index}`;
      ticks(
        event.atMs,
        0,
        Math.max(0, state.durationMs - LIMITS.tickMs),
        `${eventPath}.atMs`,
      );
      if ((event.commandId !== undefined) === (event.macroId !== undefined)) {
        fail(eventPath, "Select exactly one IR command or macro.");
        canExpandIr = false;
      } else if (event.commandId !== undefined) {
        irReference(event.commandId, `${eventPath}.commandId`);
        if (!irCommands.has(event.commandId)) canExpandIr = false;
      } else {
        if (
          !project.ir?.enabled &&
          project.wiring !== "standard-uno" &&
          project.wiring !== "fixed"
        )
          fail(
            `${eventPath}.macroId`,
            "Enable IR hardware before using an IR macro.",
          );
        const macro = irMacros.get(event.macroId!);
        if (!macro) {
          fail(
            `${eventPath}.macroId`,
            "IR macro does not exist in the project library.",
          );
          canExpandIr = false;
        } else {
          if (!macro.steps.length) canExpandIr = false;
          macro.steps.forEach((step, stepIndex) => {
            if (!irCommands.has(step.commandId)) canExpandIr = false;
            if (event.atMs + step.atMs >= state.durationMs)
              fail(
                `${eventPath}.macroId`,
                `Macro step ${stepIndex + 1} starts at ${event.atMs + step.atMs} ms; every step must start before the state ends (${state.durationMs} ms).`,
              );
          });
        }
      }
    });
    let irQueueLoads: number[] = [];
    let irAt: number | undefined;
    let irLastFrameUntil = 0;
    let irBusyUntil = 0;
    let irTransmissionMs = 0;
    (canExpandIr ? expandIrEvents(project, state) : []).forEach((event) => {
      const eventPath = `${path}.irEvents.${event.sourceEventIndex}`;
      const command = irCommands.get(event.commandId);
      if (command && validateIrSignal(command.signal)) {
        if (event.atMs !== irAt) {
          // All commands due on one tick enqueue before the next service.
          // Earlier jobs may have left the queue in the meantime. A job is
          // loaded as soon as the prior final frame finishes, even while its
          // final quiet gap is still running. This is the optimistic drain
          // rate; audio/sonar traffic can only delay it further.
          irQueueLoads = irQueueLoads.filter((at) => at > event.atMs);
          irAt = event.atMs;
        }
        if (irQueueLoads.length >= 8)
          fail(
            eventPath,
            "At most eight IR commands can be queued at one time. Space these commands farther apart or reduce repeated presses.",
          );
        irQueueLoads.push(Math.max(event.atMs, irLastFrameUntil));
        if (event.atMs < irBusyUntil)
          fail(
            eventPath,
            "This IR command overlaps a previous transmission and will wait in the send queue.",
            "warning",
          );
        const duration = irCommandDurationMs(command);
        irTransmissionMs += duration;
        irBusyUntil = Math.max(irBusyUntil, event.atMs) + duration;
        irLastFrameUntil = irBusyUntil - command.gapMs;
      }
    });
    if (state.loopTimeline && irTransmissionMs > state.durationMs)
      fail(
        `${path}.irEvents`,
        `IR commands require at least ${Math.ceil(irTransmissionMs)} ms to transmit in each ${state.durationMs} ms loop. The send queue will overflow. Lengthen the looping timeline or reduce repeated presses.`,
      );
    else if (irBusyUntil > state.durationMs)
      fail(
        `${path}.irEvents`,
        state.loopTimeline
          ? "IR transmissions extend past this looping timeline. The send queue carries over between loops and can overflow when commands take longer than each loop."
          : "IR transmissions extend past this timeline's end. They can finish while the state remains active, but a state transition cancels unsent commands.",
        "warning",
      );
    const byOutput = new Map<
      string,
      Array<{ start: number; end: number; index: number }>
    >();
    state.events.forEach((event, index) => {
      const eventPath = `${path}.events.${index}`;
      if (!outputs.has(event.outputId))
        fail(`${eventPath}.outputId`, "Output channel does not exist.");
      const owner = outputOwners.get(event.outputId);
      if (owner && owner !== state)
        fail(
          `${eventPath}.outputId`,
          `This output is exclusively reserved by child sequence "${owner.name}".`,
        );
      ticks(event.startMs, 0, state.durationMs, `${eventPath}.startMs`);
      ticks(event.endMs, 50, state.durationMs, `${eventPath}.endMs`);
      if (event.endMs <= event.startMs)
        fail(eventPath, "Event end must be after its start.");
      const list = byOutput.get(event.outputId) ?? [];
      list.push({ start: event.startMs, end: event.endMs, index });
      byOutput.set(event.outputId, list);
    });
    byOutput.forEach((entries) => {
      entries.sort((a, b) => a.start - b.start || a.end - b.end);
      let end = -1;
      entries.forEach((entry) => {
        if (entry.start < end)
          fail(
            `${path}.events.${entry.index}`,
            "Events on the same output cannot overlap.",
          );
        end = Math.max(end, entry.end);
      });
    });
    const transitionTriggers = new Set<string>();
    integer(
      state.transitions.length,
      0,
      LIMITS.triggers * 2,
      `${path}.transitions`,
    );
    state.transitions.forEach((transition, index) => {
      const transitionPath = `${path}.transitions.${index}`;
      if (!triggers.has(transition.triggerId))
        fail(`${transitionPath}.triggerId`, "Trigger does not exist.");
      if (
        project.triggers.some(
          (trigger) =>
            trigger.id === transition.triggerId && isZonedTrigger(trigger),
        )
      )
        fail(
          transitionPath,
          "This sensor uses distance-zone actions. Its single-threshold transition is inactive until threshold mode is restored.",
          "warning",
        );
      if (!states.has(transition.targetStateId))
        fail(`${transitionPath}.targetStateId`, "Target state does not exist.");
      const trigger = project.triggers.find(
        (item) => item.id === transition.triggerId,
      );
      if (
        transition.edge === "release" &&
        trigger &&
        (trigger.kind === "timer" ||
          trigger.kind === "manual" ||
          isZonedTrigger(trigger))
      )
        fail(
          `${transitionPath}.edge`,
          "Release transitions require a digital or single-threshold ultrasonic input.",
        );
      const targets = transitionTargets(transition);
      if (targets.length > 1 && targets.some((id) => childIds.has(id)))
        fail(
          `${transitionPath}.alternateStateIds`,
          "Round-robin transitions cannot include child sequences. Use one child destination per trigger and edge.",
        );
      integer(
        targets.length,
        1,
        LIMITS.states,
        `${transitionPath}.alternateStateIds`,
      );
      if (new Set(targets).size !== targets.length)
        fail(
          `${transitionPath}.alternateStateIds`,
          "Round-robin destinations must be distinct.",
        );
      targets.slice(1).forEach((id, i) => {
        if (!states.has(id))
          fail(
            `${transitionPath}.alternateStateIds.${i}`,
            "Target state does not exist.",
          );
      });
      const key = `${transition.triggerId}:${transition.edge ?? "activate"}`;
      if (transitionTriggers.has(key))
        fail(
          transitionPath,
          "Only one transition per trigger and edge is allowed within a state.",
        );
      transitionTriggers.add(key);
    });
  });
  integer(
    runtime.states.reduce(
      (sum, state) =>
        sum +
        state.transitions.reduce(
          (count, transition) => count + transitionTargets(transition).length,
          0,
        ),
      0,
    ),
    0,
    LIMITS.expandedTransitions,
    "transitions",
  );
  integer(
    runtime.states.reduce(
      (sum, state) => sum + expandedIrEventCount(runtime, state.irEvents ?? []),
      0,
    ),
    0,
    LIMITS.irEvents,
    "irEvents",
  );
  const usedBytes = estimateSceneBytes(project);
  if (usedBytes > profile.eepromBytes)
    fail(
      "capacity",
      `Scene needs ${usedBytes} bytes; ${profile.name} has ${profile.eepromBytes} bytes of onboard scene storage.`,
    );
  return issues;
}
