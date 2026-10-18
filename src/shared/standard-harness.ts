import type {
  OutputConfig,
  SceneProject,
  StandardOutputSlot,
  StandardTriggerSlot,
  TriggerConfig,
  ValidationIssue,
} from "./model";
import { requiredPlayerCount } from "./boards";
import { isChildState } from "./parallel-children";

export const STANDARD_OUTPUT_SLOTS = [
  { id: "relay-1", label: "Shield relay 1", pin: 7 },
  { id: "relay-2", label: "Shield relay 2", pin: 6 },
  { id: "relay-3", label: "Shield relay 3", pin: 5 },
  { id: "relay-4", label: "Shield relay 4", pin: 4 },
  { id: "dc-ssr", label: "12 V DC SSR", pin: 17 },
  { id: "ac-ssr", label: "AC strobe SSR", pin: 18 },
  { id: "spare", label: "Spare output / BUSY", pin: 19 },
] as const satisfies readonly {
  id: StandardOutputSlot;
  label: string;
  pin: number;
}[];

export const STANDARD_TRIGGER_SLOTS = [
  { id: "beam", label: "Beam contact", kind: "button", pin: 10, echoPin: null },
  {
    id: "primary-pir",
    label: "Primary PIR",
    kind: "pir",
    pin: 11,
    echoPin: null,
  },
  {
    id: "primary-ultrasonic",
    label: "Primary ultrasonic",
    kind: "ultrasonic",
    pin: 12,
    echoPin: 13,
  },
  {
    id: "backup-pir",
    label: "Backup PIR",
    kind: "pir",
    pin: 14,
    echoPin: null,
  },
  {
    id: "backup-ultrasonic",
    label: "Backup ultrasonic",
    kind: "ultrasonic",
    pin: 15,
    echoPin: 16,
  },
] as const satisfies readonly {
  id: StandardTriggerSlot;
  label: string;
  kind: TriggerConfig["kind"];
  pin: number;
  echoPin: number | null;
}[];

export const STANDARD_AUDIO_PINS = { txPin: 3, rxPin: 8, busyPin: 19 } as const;
export const STANDARD_IR_PINS = { txPin: 9, rxPin: 2 } as const;

/** Only enabled devices exist on the controller. Editor records remain untouched. */
export function toRuntimeProject(project: SceneProject): SceneProject {
  const result = structuredClone(project);
  const disabledOutputs = new Set(
    result.outputs
      .filter((item) => item.enabled === false)
      .map((item) => item.id),
  );
  const disabledTriggers = new Set(
    result.triggers
      .filter((item) => item.enabled === false)
      .map((item) => item.id),
  );
  result.outputs = result.outputs.filter((item) => item.enabled !== false);
  result.triggers = result.triggers.filter((item) => item.enabled !== false);
  const removedChildren = new Set<string>();
  result.states.forEach((state) => {
    const hadEvents = state.events.length > 0;
    state.events = state.events.filter(
      (event) => !disabledOutputs.has(event.outputId),
    );
    if (isChildState(state) && hadEvents && state.events.length === 0)
      removedChildren.add(state.id);
  });
  result.states = result.states.filter(
    (state) => !removedChildren.has(state.id),
  );
  result.states.forEach((state) => {
    state.transitions = state.transitions.filter(
      (transition) =>
        !disabledTriggers.has(transition.triggerId) &&
        !removedChildren.has(transition.targetStateId),
    );
    state.transitions.forEach((transition) => {
      if (transition.alternateStateIds)
        transition.alternateStateIds = transition.alternateStateIds.filter(
          (id) => !removedChildren.has(id),
        );
    });
    if (
      (result.wiring === "standard-uno" || result.wiring === "fixed") &&
      !result.ir?.enabled
    )
      state.irEvents = [];
  });
  result.triggers.forEach((trigger) =>
    trigger.zones?.forEach((zone) => {
      for (const edge of ["onEnter", "onExit"] as const)
        zone[edge] = zone[edge].filter(
          (action) =>
            (action.kind !== "state" || !removedChildren.has(action.stateId)) &&
            !(
              action.kind === "ir" &&
              (result.wiring === "standard-uno" || result.wiring === "fixed") &&
              !result.ir?.enabled
            ),
        );
    }),
  );
  return result;
}

/** Validate slot identity as well as the pins; disabled slots still reserve wiring. */
export function validateStandardHarness(
  project: SceneProject,
): ValidationIssue[] {
  if (project.wiring !== "standard-uno") return [];
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string) =>
    issues.push({ path, message, severity: "error" as const });
  if (project.board === "mega")
    fail(
      "wiring",
      "The standard Uno harness supports Uno, classic Nano and 5 V / 16 MHz Pro Mini. Choose another wiring preset for Mega.",
    );
  const outputSlots = new Set<string>();
  project.outputs.forEach((output, index) => {
    const path = `outputs.${index}`;
    const slot = STANDARD_OUTPUT_SLOTS.find(
      (candidate) => candidate.id === output.standardSlot,
    );
    if (!slot) {
      fail(
        `${path}.standardSlot`,
        "Assign this output to a standard harness slot.",
      );
      return;
    }
    if (outputSlots.has(slot.id))
      fail(
        `${path}.standardSlot`,
        `The ${slot.label} slot is already assigned.`,
      );
    outputSlots.add(slot.id);
    if (output.pin !== slot.pin)
      fail(`${path}.pin`, `${slot.label} must retain D${slot.pin}.`);
  });
  const triggerSlots = new Set<string>();
  project.triggers.forEach((trigger, index) => {
    const path = `triggers.${index}`;
    if (trigger.kind === "manual" || trigger.kind === "timer") {
      if (trigger.standardSlot !== undefined)
        fail(
          `${path}.standardSlot`,
          "Manual and timer triggers do not occupy standard sensor slots.",
        );
      return;
    }
    const slot = STANDARD_TRIGGER_SLOTS.find(
      (candidate) => candidate.id === trigger.standardSlot,
    );
    if (!slot) {
      fail(
        `${path}.standardSlot`,
        "Assign this trigger to a standard harness sensor slot.",
      );
      return;
    }
    if (triggerSlots.has(slot.id))
      fail(
        `${path}.standardSlot`,
        `The ${slot.label} slot is already assigned.`,
      );
    triggerSlots.add(slot.id);
    if (trigger.kind !== slot.kind)
      fail(`${path}.kind`, `${slot.label} requires a ${slot.kind} trigger.`);
    if (trigger.pin !== slot.pin || trigger.echoPin !== slot.echoPin)
      fail(
        `${path}.pin`,
        `${slot.label} must retain its standard pin assignment.`,
      );
  });
  if (project.ir && (project.ir.txPin !== 9 || project.ir.rxPin !== 2))
    fail(
      "ir",
      "The standard harness reserves IR transmit D9 and receive D2 even when IR is disabled.",
    );
  if (project.audio.players.length > 1 || requiredPlayerCount(project) > 1)
    fail(
      "audio.players",
      "The standard harness supports one DFPlayer. Use cut or fade-out/fade-in transitions without continuous ambient playback, or choose another wiring preset.",
    );
  project.audio.players.forEach((player, index) => {
    const path = `audio.players.${index}`;
    if (player.kind !== "dfplayer")
      fail(`${path}.kind`, "The standard harness uses one DFPlayer.");
    if (player.txPin !== 3 || player.rxPin !== 8)
      fail(
        path,
        "The standard harness reserves controller TX D3 and RX D8 for the DFPlayer.",
      );
    if (player.feedback) {
      if (player.feedback.pin !== 19)
        fail(
          `${path}.feedback.pin`,
          "Standard harness BUSY feedback must use A5 / D19.",
        );
      if (
        project.outputs.some(
          (output) =>
            output.standardSlot === "spare" && output.enabled !== false,
        )
      )
        fail(
          `${path}.feedback.pin`,
          "A5 can be either the spare output or DFPlayer BUSY feedback. Disable the spare output to use BUSY.",
        );
    }
  });
  return issues;
}

/** Does not infer missing identities: only explicit migration assigns slots. */
export function allocateStandardHarness(project: SceneProject) {
  const result = structuredClone(project);
  result.outputs.forEach((output) => {
    output.pin =
      STANDARD_OUTPUT_SLOTS.find((slot) => slot.id === output.standardSlot)
        ?.pin ?? null;
  });
  result.triggers.forEach((trigger) => {
    const slot = STANDARD_TRIGGER_SLOTS.find(
      (candidate) => candidate.id === trigger.standardSlot,
    );
    trigger.pin = slot?.pin ?? null;
    trigger.echoPin = slot?.echoPin ?? null;
  });
  if (result.ir) Object.assign(result.ir, STANDARD_IR_PINS);
  result.audio.players.forEach((player, index) => {
    player.txPin = index === 0 ? 3 : null;
    player.rxPin = index === 0 ? 8 : null;
    if (player.feedback) player.feedback.pin = index === 0 ? 19 : null;
  });
  const hasBusy = result.audio.players.some((player) => player.feedback);
  const hasSpare = result.outputs.some(
    (output) => output.standardSlot === "spare" && output.enabled !== false,
  );
  return {
    project: result,
    issues: validateStandardHarness(result),
    maxOutputs: hasBusy ? 6 : 7,
    availableOutputPins: hasBusy || hasSpare ? [] : [19],
  };
}

/**
 * Explicit conversion: existing output order maps to relays 1–4, DC SSR, AC SSR,
 * then spare. Sensor kind/order maps to primary then backup. Existing IDs,
 * events, names, options and audio are preserved; excess/invalid devices fail.
 */
export function applyStandardHarness(project: SceneProject): SceneProject {
  const result = structuredClone(project);
  if (result.board === "mega")
    throw new Error(
      "Choose an Uno, classic Nano or 5 V / 16 MHz Pro Mini before applying the standard harness.",
    );
  if (
    result.audio.players.length > 1 ||
    requiredPlayerCount(result) > 1 ||
    result.audio.players.some((player) => player.kind !== "dfplayer")
  )
    throw new Error(
      "The standard harness requires at most one DFPlayer. Choose cut or fade-out/fade-in audio and disable continuous ambient playback first.",
    );
  const usedOutputs = new Set<StandardOutputSlot>();
  result.outputs.forEach((output) => {
    if (!output.standardSlot) return;
    if (
      !STANDARD_OUTPUT_SLOTS.some((slot) => slot.id === output.standardSlot) ||
      usedOutputs.has(output.standardSlot)
    )
      throw new Error(
        "Duplicate or unsupported standard output slot. Assign each physical output only once.",
      );
    usedOutputs.add(output.standardSlot);
  });
  result.outputs.forEach((output) => {
    if (output.standardSlot) return;
    const slot = STANDARD_OUTPUT_SLOTS.find(
      (candidate) => !usedOutputs.has(candidate.id),
    );
    if (!slot)
      throw new Error(
        "The standard harness has four relay, two SSR and one spare output slots. Remove extra outputs before converting.",
      );
    output.standardSlot = slot.id;
    usedOutputs.add(slot.id);
  });
  const usedTriggers = new Set<StandardTriggerSlot>();
  result.triggers.forEach((trigger) => {
    if (!trigger.standardSlot) return;
    const slot = STANDARD_TRIGGER_SLOTS.find(
      (candidate) => candidate.id === trigger.standardSlot,
    );
    if (!slot || slot.kind !== trigger.kind || usedTriggers.has(slot.id))
      throw new Error(
        "Duplicate or incompatible standard sensor slot. Keep beam, PIR and ultrasonic slot types consistent.",
      );
    usedTriggers.add(slot.id);
  });
  result.triggers.forEach((trigger) => {
    if (
      trigger.standardSlot ||
      trigger.kind === "manual" ||
      trigger.kind === "timer"
    )
      return;
    const slot = STANDARD_TRIGGER_SLOTS.find(
      (candidate) =>
        candidate.kind === trigger.kind && !usedTriggers.has(candidate.id),
    );
    if (!slot)
      throw new Error(
        "The standard harness supports one beam contact, two PIRs and two ultrasonic sensors. Remove extra physical triggers before converting.",
      );
    trigger.standardSlot = slot.id;
    usedTriggers.add(slot.id);
  });
  const unusedId = (base: string, items: { id: string }[]) => {
    let id = base;
    for (let suffix = 2; items.some((item) => item.id === id); suffix++)
      id = `${base}-${suffix}`;
    return id;
  };
  STANDARD_OUTPUT_SLOTS.forEach((slot) => {
    if (usedOutputs.has(slot.id)) return;
    const output: OutputConfig = {
      id: unusedId(`standard-${slot.id}`, result.outputs),
      name: slot.label,
      standardSlot: slot.id,
      pin: slot.pin,
      enabled: false,
      activeLow: false,
      idleActive: false,
      color: "#60a5fa",
    };
    result.outputs.push(output);
  });
  STANDARD_TRIGGER_SLOTS.forEach((slot) => {
    if (usedTriggers.has(slot.id)) return;
    const trigger: TriggerConfig = {
      id: unusedId(`standard-${slot.id}`, result.triggers),
      name: slot.label,
      standardSlot: slot.id,
      kind: slot.kind,
      pin: slot.pin,
      echoPin: slot.echoPin,
      enabled: false,
      activeLow: slot.kind === "button",
      pullup: slot.kind === "button",
      debounceMs: slot.kind === "button" ? 0 : 100,
      thresholdCm: 100,
      hysteresisCm: 20,
    };
    result.triggers.push(trigger);
  });
  result.wiring = "standard-uno";
  if (result.audio.players.length === 0 && requiredPlayerCount(result) > 0)
    result.audio.players.push({
      id: "player-1",
      kind: "dfplayer",
      txPin: 3,
      rxPin: 8,
    });
  const allocation = allocateStandardHarness(result);
  if (allocation.issues.length)
    throw new Error(allocation.issues.map((issue) => issue.message).join("\n"));
  return allocation.project;
}
