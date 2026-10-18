import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  applyWiringConfiguration,
  BUILT_IN_WIRING_CONFIGURATIONS,
  captureWiringConfiguration,
  compileProject,
  createDefaultProject,
  createTrigger,
  isBuiltinWiringConfigurationId,
  parseWiringConfiguration,
  synchronizeAudioPlayers,
  toRuntimeProject,
  validateProject,
  validateWiringConfiguration,
  type SceneProject,
  type WiringConfiguration,
} from "../../src/shared";
import { standardHarnessProject } from "./standard-harness-fixture";

const builtin = (id: string) =>
  structuredClone(
    BUILT_IN_WIRING_CONFIGURATIONS.find((config) => config.id === id)!,
  );
const errors = (project: SceneProject) =>
  validateProject(project).filter((issue) => issue.severity === "error");

describe("reusable wiring configuration library", () => {
  it.each(BUILT_IN_WIRING_CONFIGURATIONS.map((config) => config.id))(
    "validates builtin %s without scene data",
    (id) => {
      const config = builtin(id);
      expect(
        validateWiringConfiguration(config).filter(
          (issue) => issue.severity === "error",
        ),
      ).toEqual([]);
      expect(isBuiltinWiringConfigurationId(id)).toBe(true);
      expect(parseWiringConfiguration(JSON.stringify(config))).toEqual(config);
      expect(config).not.toHaveProperty("states");
      expect(config).not.toHaveProperty("audio");
    },
  );

  it("captures physical wiring, strips scene actions and retains electrical settings", () => {
    const project = standardHarnessProject();
    project.ir!.commands.push({
      id: "on",
      name: "Candles on",
      signal: { kind: "nec", code: 10 },
      sendCount: 1,
      gapMs: 100,
    });
    const config = captureWiringConfiguration(
      project,
      "My enclosure",
      "wiring-mine",
    );
    expect(config.id).toBe("wiring-mine");
    expect(config.outputs.map((output) => output.configurationSlot)).toEqual(
      project.outputs.map((output) => output.standardSlot),
    );
    expect(config.triggers).toHaveLength(5);
    expect(
      config.triggers.every(
        (trigger) => trigger.kind !== "manual" && trigger.kind !== "timer",
      ),
    ).toBe(true);
    const sonar = config.triggers.find(
      (trigger) => trigger.configurationSlot === "backup-ultrasonic",
    )!;
    expect(sonar).not.toHaveProperty("zones");
    expect(sonar).not.toHaveProperty("distanceMode");
    expect(config.ir).toEqual({ enabled: true, txPin: 9, rxPin: 2 });
    expect(config.players).toEqual(project.audio.players);
    expect(project.ir!.commands).toHaveLength(1);
    expect(
      project.triggers.find((trigger) => trigger.id === "backup-sonar")?.zones,
    ).toHaveLength(1);
    expect(captureWiringConfiguration(project, "New").id).toMatch(/^wiring-/);
  });

  it.each([
    (config: WiringConfiguration) => Object.assign(config, { version: 2 }),
    (config: WiringConfiguration) =>
      Object.assign(config, { id: "../outside" }),
    (config: WiringConfiguration) => Object.assign(config, { name: " " }),
    (config: WiringConfiguration) => Object.assign(config, { board: "esp32" }),
    (config: WiringConfiguration) => Object.assign(config, { states: [] }),
    (config: WiringConfiguration) => Object.assign(config, { ir: null }),
    (config: WiringConfiguration) =>
      Object.assign(config.ir!, { commands: [] }),
    (config: WiringConfiguration) =>
      Object.assign(config.triggers[0], { kind: "manual" }),
    (config: WiringConfiguration) =>
      Object.assign(config.triggers[0], { zones: [] }),
    (config: WiringConfiguration) =>
      Object.assign(config.outputs[0], { enabled: "false" }),
    (config: WiringConfiguration) =>
      Object.assign(config.outputs[0], { pin: 1 }),
    (config: WiringConfiguration) =>
      Object.assign(config.outputs[0], { pin: 20 }),
    (config: WiringConfiguration) =>
      Object.assign(config.outputs[0], { pin: config.outputs[1].pin }),
    (config: WiringConfiguration) =>
      Object.assign(config.outputs[0], {
        configurationSlot: config.outputs[1].configurationSlot,
      }),
  ])("rejects malformed or unsafe imported hardware %#", (mutate) => {
    const config = builtin("uno-standard");
    mutate(config);
    expect(() => parseWiringConfiguration(config)).toThrow();
  });

  it("validates software pin roles, ordered Mega UARTs and analog-only feedback", () => {
    const mega = builtin("mega-standard");
    mega.players.reverse();
    expect(() => parseWiringConfiguration(mega)).toThrow("UART");
    const wrongIr = builtin("mega-standard");
    wrongIr.ir!.txPin = 9;
    expect(() => parseWiringConfiguration(wrongIr)).toThrow("transmit D11");
    const busy = builtin("nano-standard");
    busy.players[0].feedback = { pin: 20, activeLow: true };
    expect(() => parseWiringConfiguration(busy)).not.toThrow();
    busy.board = "uno";
    expect(() => parseWiringConfiguration(busy)).toThrow("GPIO");
  });

  it("rejects duplicate effective slots from legacy metadata or ID fallbacks", () => {
    const config = builtin("uno-standard");
    delete config.outputs[0].configurationSlot;
    delete config.outputs[1].configurationSlot;
    config.outputs[0].standardSlot = "relay-1";
    config.outputs[1].standardSlot = "relay-1";
    expect(() => parseWiringConfiguration(config)).toThrow(
      "Duplicate configuration slot",
    );
    const fallback = builtin("uno-standard");
    delete fallback.outputs[0].configurationSlot;
    fallback.outputs[1].configurationSlot = fallback.outputs[0].id;
    expect(() => parseWiringConfiguration(fallback)).toThrow(
      "Duplicate configuration slot",
    );
  });
});

describe("fixed wiring allocation and reservation", () => {
  it("never reallocates pins or changes player count when scene requirements change", () => {
    const project = applyWiringConfiguration(
      standardHarnessProject(),
      builtin("uno-standard"),
    );
    const before = structuredClone(project);
    project.audio.keepAmbient = true;
    project.audio.transitionMode = "crossfade";
    project.audio.fadeMs = 1000;
    project.outputs.reverse();
    project.triggers.reverse();
    project.triggers[0].enabled = false;
    const synced = synchronizeAudioPlayers(project);
    expect(synced).toEqual(project);
    expect(synced.audio.players).toHaveLength(1);
    for (const device of synced.outputs)
      expect(device.pin).toBe(
        before.outputs.find((output) => output.id === device.id)!.pin,
      );
    expect(
      errors(synced).some((issue) => issue.message.includes("require 2 MP3")),
    ).toBe(true);
    expect(compileProject(synced).bytes).toHaveLength(0);
    project.audio.ambientTrack = null;
    project.states.forEach((state) => (state.foregroundTrack = null));
    expect(synchronizeAudioPlayers(project).audio.players).toHaveLength(1);
  });

  it("reserves disabled output/sensor pins and detects feedback sharing", () => {
    const project = applyWiringConfiguration(
      standardHarnessProject(),
      builtin("uno-standard"),
    );
    project.triggers.find(
      (trigger) => trigger.configurationSlot === "backup-pir",
    )!.enabled = false;
    expect(allocatePins(project).availableOutputPins).toEqual([]); // A5 remains reserved by disabled spare.
    project.outputs[0].pin = 14;
    expect(
      errors(project).some((issue) =>
        issue.message.includes("including when that device is disabled"),
      ),
    ).toBe(true);
    const busy = builtin("uno-standard");
    busy.players[0].feedback = { pin: 19, activeLow: true };
    expect(() => parseWiringConfiguration(busy)).toThrow("reserved");
    busy.outputs = busy.outputs.filter(
      (output) => output.configurationSlot !== "spare",
    );
    expect(() => parseWiringConfiguration(busy)).not.toThrow();
  });

  it("allows no-IR configurations to reclaim IR pins while preserving disabled IR cues", () => {
    const project = standardHarnessProject();
    project.ir!.commands = [
      {
        id: "on",
        name: "Candles on",
        signal: { kind: "nec", code: 1 },
        sendCount: 1,
        gapMs: 100,
      },
    ];
    project.states[1].irEvents = [{ id: "cue", atMs: 0, commandId: "on" }];
    const fixed = applyWiringConfiguration(project, builtin("uno-motion"));
    expect(fixed.ir!.enabled).toBe(false);
    expect(fixed.ir!.commands).toEqual(project.ir!.commands);
    expect(fixed.states).toEqual(project.states);
    expect(
      fixed.triggers.find(
        (trigger) => trigger.configurationSlot === "extra-pir-1",
      ),
    ).toMatchObject({ kind: "pir", pin: 2, enabled: true });
    expect(
      fixed.triggers.find(
        (trigger) => trigger.configurationSlot === "extra-pir-2",
      ),
    ).toMatchObject({ kind: "pir", pin: 9, enabled: true });
    expect(errors(fixed)).toEqual([]);
    expect(toRuntimeProject(fixed).states[1].irEvents).toEqual([]);
    expect(compileProject(fixed).bytes.length).toBeGreaterThan(0);
    fixed.ir!.enabled = true;
    expect(
      errors(fixed).some((issue) => issue.message.includes("reserved")),
    ).toBe(true);
  });
});

describe("applying reusable wiring without retargeting scene actions", () => {
  it("avoids new physical slot ID collisions with existing manual and timer triggers", () => {
    const source = standardHarnessProject("sparse");
    const manual = source.triggers.find(
      (trigger) => trigger.kind === "manual",
    )!;
    const originalId = manual.id;
    manual.id = "configuration-second-beam";
    for (const state of source.states)
      for (const transition of state.transitions)
        if (transition.triggerId === originalId)
          transition.triggerId = manual.id;
    const result = applyWiringConfiguration(source, builtin("uno-dual-beam"));
    expect(
      result.triggers.find(
        (trigger) => trigger.configurationSlot === "second-beam",
      )!.id,
    ).toBe("configuration-second-beam-2");
    expect(result.triggers.find((trigger) => trigger.id === manual.id)).toEqual(
      manual,
    );
    expect(result.states).toEqual(source.states);
    expect(errors(result)).toEqual([]);
  });
  it("preserves IDs, names, events, zones and enable states while template electrical settings apply", () => {
    const source = standardHarnessProject();
    source.outputs[0].name = "Dragon";
    source.outputs[0].enabled = false;
    source.triggers[1].thresholdCm = 75;
    source.triggers[1].debounceMs = 250;
    const config = builtin("mega-standard");
    config.outputs[0].activeLow = true;
    config.triggers.find(
      (trigger) => trigger.configurationSlot === "beam",
    )!.pullup = false;
    config.players[0].kind = "yx5300";
    const original = structuredClone(source);
    const result = applyWiringConfiguration(source, config);
    expect(result.board).toBe("mega");
    expect(result.wiring).toBe("fixed");
    expect(result.wiringConfiguration).toEqual({
      id: config.id,
      name: config.name,
    });
    expect(result.outputs[0]).toMatchObject({
      id: source.outputs[0].id,
      name: "Dragon",
      enabled: false,
      activeLow: true,
      configurationSlot: "relay-1",
      pin: 7,
    });
    expect(result.outputs[4]).toMatchObject({
      id: source.outputs[4].id,
      pin: 30,
    });
    expect(
      result.triggers.find((trigger) => trigger.id === "pir"),
    ).toMatchObject({ pin: 24, thresholdCm: 75, debounceMs: 250 });
    expect(
      result.triggers.find((trigger) => trigger.id === "beam")!.pullup,
    ).toBe(false);
    expect(
      result.triggers.find((trigger) => trigger.id === "backup-sonar")!.zones,
    ).toEqual(
      source.triggers.find((trigger) => trigger.id === "backup-sonar")!.zones,
    );
    expect(result.triggers.find((trigger) => trigger.id === "next")).toEqual(
      source.triggers.find((trigger) => trigger.id === "next"),
    );
    expect(result.audio.players).toHaveLength(3);
    expect(result.audio.players[0]).toMatchObject({
      id: source.audio.players[0].id,
      kind: "yx5300",
      txPin: 18,
      rxPin: 19,
    });
    expect({ ...result.audio, players: source.audio.players }).toEqual(
      source.audio,
    );
    expect(result.states).toEqual(source.states);
    expect(source).toEqual(original);
    expect(errors(result)).toEqual([]);
  });

  it("adds a second beam at A5, keeps the primary beam and compiles both", () => {
    const source = standardHarnessProject("sparse");
    const fixed = applyWiringConfiguration(source, builtin("uno-dual-beam"));
    expect(
      fixed.outputs.some((output) => output.configurationSlot === "spare"),
    ).toBe(false);
    const primary = fixed.triggers.find((trigger) => trigger.id === "beam")!;
    const second = fixed.triggers.find(
      (trigger) => trigger.configurationSlot === "second-beam",
    )!;
    expect(primary).toMatchObject({ pin: 10, kind: "button" });
    expect(second).toMatchObject({ pin: 19, kind: "button", enabled: true });
    expect(fixed.states).toEqual(source.states);
    const binary = compileProject(fixed);
    expect(binary.bytes[10]).toBe(5);
    const view = new DataView(binary.bytes.buffer);
    const offset = view.getUint16(22, true);
    expect(
      [...Array(binary.bytes[10]).keys()].map(
        (index) => binary.bytes[offset + index * 8 + 1],
      ),
    ).toContain(19);
  });

  it("matches stable slots across reorder, independent of names", () => {
    const fixed = applyWiringConfiguration(
      standardHarnessProject(),
      builtin("uno-standard"),
    );
    const config = captureWiringConfiguration(fixed, "Reordered", "reordered");
    config.outputs.reverse();
    config.triggers.reverse();
    config.outputs.forEach((output) => (output.name = "Renamed template"));
    const result = applyWiringConfiguration(fixed, config);
    expect(result.outputs).toEqual(fixed.outputs);
    expect(result.triggers).toEqual(fixed.triggers);
    expect(result.states).toEqual(fixed.states);
  });

  it("matches legacy unnamed slots by kind/order without changing existing references", () => {
    const source = standardHarnessProject();
    source.wiring = "custom";
    source.outputs.forEach((output) => delete output.standardSlot);
    source.triggers.forEach((trigger) => delete trigger.standardSlot);
    const result = applyWiringConfiguration(source, builtin("uno-standard"));
    expect(result.outputs.map((output) => output.id)).toEqual(
      source.outputs.map((output) => output.id),
    );
    expect(result.triggers.map((trigger) => trigger.id)).toEqual(
      source.triggers.map((trigger) => trigger.id),
    );
    expect(result.states).toEqual(source.states);
  });

  it("rejects loss of enabled devices or references, even when a device is disabled", () => {
    const source = standardHarnessProject();
    source.outputs.find((output) => output.standardSlot === "spare")!.enabled =
      true;
    expect(() =>
      applyWiringConfiguration(source, builtin("uno-dual-beam")),
    ).toThrow("no matching slot");
    source.outputs.find((output) => output.standardSlot === "spare")!.enabled =
      false;
    source.states[1].events.push({
      id: "spare-event",
      outputId: source.outputs.find(
        (output) => output.standardSlot === "spare",
      )!.id,
      startMs: 0,
      endMs: 100,
    });
    expect(() =>
      applyWiringConfiguration(source, builtin("uno-dual-beam")),
    ).toThrow("referenced");
    const moreMotion = applyWiringConfiguration(
      standardHarnessProject(),
      builtin("uno-motion"),
    );
    expect(() =>
      applyWiringConfiguration(moreMotion, builtin("uno-standard")),
    ).toThrow("Extra PIR 1");
  });

  it("rejects sensor type changes and ambiguous fallback names", () => {
    const source = standardHarnessProject();
    const changed = builtin("uno-standard");
    changed.triggers.find(
      (trigger) => trigger.configurationSlot === "beam",
    )!.kind = "pir";
    expect(() => applyWiringConfiguration(source, changed)).toThrow(
      "changes sensor type",
    );
    const unnamed = standardHarnessProject();
    unnamed.triggers.forEach((trigger) => delete trigger.standardSlot);
    unnamed.triggers.find((trigger) => trigger.id === "pir")!.name = "Motion";
    const ambiguous = builtin("uno-standard");
    ambiguous.triggers
      .filter((trigger) => trigger.kind === "pir")
      .forEach((trigger) => (trigger.name = "Motion"));
    expect(() => applyWiringConfiguration(unnamed, ambiguous)).toThrow(
      "Ambiguous trigger name",
    );
  });

  it("rejects insufficient audio hardware and preserves the scene on failure", () => {
    const source = standardHarnessProject();
    source.audio.keepAmbient = true;
    const before = structuredClone(source);
    expect(() =>
      applyWiringConfiguration(source, builtin("uno-standard")),
    ).toThrow("need 2 MP3");
    expect(source).toEqual(before);
    const three = applyWiringConfiguration(source, builtin("mega-standard"));
    expect(three.audio.players).toHaveLength(3);
    expect(three.audio.keepAmbient).toBe(true);
  });

  it("keeps manual/timer triggers and enforces the resulting runtime input limit", () => {
    const source = standardHarnessProject();
    source.triggers.push({
      ...createTrigger("timer"),
      kind: "timer",
      timerIntervalMs: 500,
      pin: null,
      echoPin: null,
    });
    expect(() =>
      applyWiringConfiguration(source, builtin("uno-motion")),
    ).toThrow("8 enabled triggers");
    source.triggers.find(
      (trigger) => trigger.standardSlot === "backup-pir",
    )!.enabled = false;
    const result = applyWiringConfiguration(source, builtin("uno-motion"));
    expect(result.triggers.find((trigger) => trigger.id === "timer")).toEqual(
      source.triggers.find((trigger) => trigger.id === "timer"),
    );
  });

  it("maintains legacy binary images and can freeze pins without template metadata", () => {
    const source = createDefaultProject();
    const expected = new Uint8Array(
      readFileSync(new URL("./default-scene.bin", import.meta.url)),
    );
    expect(compileProject(source).bytes).toEqual(expected);
    source.wiring = "fixed";
    expect(compileProject(source).bytes).toEqual(expected);
    expect(allocatePins(source).project).toEqual(source);
  });
});
