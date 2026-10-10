import { BOARD_PROFILES, requiredPlayerCount, SHIELD_PINS } from "./boards";
import { LIMITS, type SceneProject, type ValidationIssue } from "./model";

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
  enumeration(project.wiring, ["custom", "relay-shield"], "wiring");
  text(project.initialStateId, "initialStateId");
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
  });
  array(project.triggers, "triggers", 256).forEach((candidate, index) => {
    const path = `triggers.${index}`;
    const trigger = object(candidate, path);
    if (!trigger) return;
    text(trigger.id, `${path}.id`);
    text(trigger.name, `${path}.name`);
    enumeration(trigger.kind, ["button", "pir", "ultrasonic"], `${path}.kind`);
    number(trigger.pin, `${path}.pin`, true);
    number(trigger.echoPin, `${path}.echoPin`, true);
    boolean(trigger.activeLow, `${path}.activeLow`);
    boolean(trigger.pullup, `${path}.pullup`);
    number(trigger.debounceMs, `${path}.debounceMs`);
    number(trigger.thresholdCm, `${path}.thresholdCm`);
    number(trigger.hysteresisCm, `${path}.hysteresisCm`);
  });
  const audio = object(project.audio, "audio");
  if (audio) {
    number(audio.ambientTrack, "audio.ambientTrack", true);
    number(audio.ambientVolume, "audio.ambientVolume");
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
    });
    array(audio.tracks, "audio.tracks", 10000).forEach((candidate, index) => {
      const path = `audio.tracks.${index}`;
      const track = object(candidate, path);
      if (!track) return;
      number(track.number, `${path}.number`);
      text(track.name, `${path}.name`);
      text(track.path, `${path}.path`, true);
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
    number(state.durationMs, `${path}.durationMs`);
    number(state.foregroundTrack, `${path}.foregroundTrack`, true);
    number(state.volume, `${path}.volume`);
    boolean(state.loopTimeline, `${path}.loopTimeline`);
    boolean(state.loopAudio, `${path}.loopAudio`);
    array(state.events, `${path}.events`, 10000).forEach(
      (entry, eventIndex) => {
        const eventPath = `${path}.events.${eventIndex}`;
        const event = object(entry, eventPath);
        if (!event) return;
        text(event.id, `${eventPath}.id`);
        text(event.outputId, `${eventPath}.outputId`);
        number(event.startMs, `${eventPath}.startMs`);
        number(event.endMs, `${eventPath}.endMs`);
      },
    );
    array(state.transitions, `${path}.transitions`, 256).forEach(
      (entry, transitionIndex) => {
        const transitionPath = `${path}.transitions.${transitionIndex}`;
        const transition = object(entry, transitionPath);
        if (!transition) return;
        text(transition.triggerId, `${transitionPath}.triggerId`);
        text(transition.targetStateId, `${transitionPath}.targetStateId`);
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
  return (
    32 +
    project.outputs.length * 2 +
    project.triggers.length * 8 +
    project.audio.players.length * 4 +
    project.states.length * 16 +
    project.states.reduce(
      (sum, state) =>
        sum + state.events.length * 6 + state.transitions.length * 2,
      0,
    )
  );
}

export function validateProject(value: unknown): ValidationIssue[] {
  const structural = validateProjectStructure(value);
  if (structural.length) return structural;
  const project = value as SceneProject;
  const issues: ValidationIssue[] = [];
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
  integer(project.outputs.length, 0, LIMITS.outputs, "outputs");
  integer(project.triggers.length, 0, LIMITS.triggers, "triggers");
  integer(project.audio.players.length, 0, LIMITS.players, "audio.players");
  integer(project.states.length, 1, LIMITS.states, "states");
  uniqueIds(project.outputs, "outputs");
  uniqueIds(project.triggers, "triggers");
  uniqueIds(project.audio.players, "audio.players");
  uniqueIds(project.states, "states");
  const profile = BOARD_PROFILES[project.board];
  const used = new Map<number, string>();
  const claimPin = (pin: number | null, path: string) => {
    if (pin === null) {
      fail(path, "Assign a GPIO pin.");
      return;
    }
    if (!Number.isInteger(pin) || !profile.digitalPins.includes(pin)) {
      fail(path, "Pin is not a digital-capable GPIO on this board.");
      return;
    }
    if (profile.reservedPins.includes(pin))
      fail(path, "D0/D1 are reserved for the host serial connection.");
    if (used.has(pin))
      fail(path, `Pin D${pin} is already assigned to ${used.get(pin)}.`);
    used.set(pin, path);
  };
  project.outputs.forEach((output, index) => {
    nonempty(output.name, `outputs.${index}.name`);
    if (!/^#[0-9a-f]{6}$/i.test(output.color))
      fail(
        `outputs.${index}.color`,
        "Use a six-digit hex color, such as #60a5fa.",
      );
    claimPin(output.pin, `outputs.${index}.pin`);
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
    claimPin(trigger.pin, `${path}.pin`);
    ticks(trigger.debounceMs, 0, 12750, `${path}.debounceMs`);
    integer(trigger.thresholdCm, 2, 400, `${path}.thresholdCm`);
    integer(trigger.hysteresisCm, 1, 255, `${path}.hysteresisCm`);
    if (trigger.kind === "ultrasonic") {
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
  });
  project.audio.players.forEach((player, index) => {
    const path = `audio.players.${index}`;
    claimPin(player.txPin, `${path}.txPin`);
    claimPin(player.rxPin, `${path}.rxPin`);
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
  project.states.forEach((state, stateIndex) => {
    const path = `states.${stateIndex}`;
    nonempty(state.name, `${path}.name`);
    ticks(state.durationMs, 50, LIMITS.maxDurationMs, `${path}.durationMs`);
    trackReference(state.foregroundTrack, `${path}.foregroundTrack`);
    integer(state.volume, 0, 30, `${path}.volume`);
    if (state.id === project.initialStateId && state.foregroundTrack !== null)
      fail(
        `${path}.foregroundTrack`,
        "The initial state uses the global ambient track, not a foreground track.",
      );
    uniqueIds(state.events, `${path}.events`);
    const byOutput = new Map<
      string,
      Array<{ start: number; end: number; index: number }>
    >();
    state.events.forEach((event, index) => {
      const eventPath = `${path}.events.${index}`;
      if (!outputs.has(event.outputId))
        fail(`${eventPath}.outputId`, "Output channel does not exist.");
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
      LIMITS.triggers,
      `${path}.transitions`,
    );
    state.transitions.forEach((transition, index) => {
      const transitionPath = `${path}.transitions.${index}`;
      if (!triggers.has(transition.triggerId))
        fail(`${transitionPath}.triggerId`, "Trigger does not exist.");
      if (!states.has(transition.targetStateId))
        fail(`${transitionPath}.targetStateId`, "Target state does not exist.");
      if (transitionTriggers.has(transition.triggerId))
        fail(
          transitionPath,
          "Only one transition per trigger is allowed within a state.",
        );
      transitionTriggers.add(transition.triggerId);
    });
  });
  const usedBytes = estimateSceneBytes(project);
  if (usedBytes > profile.eepromBytes)
    fail(
      "capacity",
      `Scene needs ${usedBytes} bytes; ${profile.name} has ${profile.eepromBytes} bytes of onboard scene storage.`,
    );
  return issues;
}
