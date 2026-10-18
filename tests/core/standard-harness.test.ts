import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  applyStandardHarness,
  compileProject,
  createDefaultProject,
  createTrigger,
  estimateSceneBytes,
  parseProject,
  STANDARD_OUTPUT_SLOTS,
  STANDARD_TRIGGER_SLOTS,
  synchronizeAudioPlayers,
  toRuntimeProject,
  validateProject,
  type SceneProject,
} from "../../src/shared";
import { standardHarnessProject } from "./standard-harness-fixture";

const errors = (project: SceneProject) =>
  validateProject(project).filter((issue) => issue.severity === "error");
const pinMap = (project: SceneProject) =>
  Object.fromEntries([
    ...project.outputs.map((output) => [output.id, output.pin]),
    ...project.triggers.map((trigger) => [
      trigger.id,
      [trigger.pin, trigger.echoPin],
    ]),
  ]);

describe("fixed Uno standard harness", () => {
  it.each(["uno", "nano", "pro-mini"] as const)(
    "fixes all physical slots on %s and keeps legacy IDs",
    (board) => {
      const project = standardHarnessProject();
      project.board = board;
      const fixed = applyStandardHarness(project);
      expect(errors(fixed)).toEqual([]);
      expect(
        fixed.outputs.map((output) => [output.standardSlot, output.pin]),
      ).toEqual(STANDARD_OUTPUT_SLOTS.map((slot) => [slot.id, slot.pin]));
      for (const slot of STANDARD_TRIGGER_SLOTS) {
        const trigger = fixed.triggers.find(
          (item) => item.standardSlot === slot.id,
        )!;
        expect([trigger.kind, trigger.pin, trigger.echoPin]).toEqual([
          slot.kind,
          slot.pin,
          slot.echoPin,
        ]);
      }
      expect(fixed.outputs[0].id).toBe("output-1");
      expect(fixed.audio.players[0]).toMatchObject({
        kind: "dfplayer",
        txPin: 3,
        rxPin: 8,
      });
      expect(fixed.ir).toMatchObject({ rxPin: 2, txPin: 9 });
      expect(
        fixed.outputs.find((output) => output.standardSlot === "spare")
          ?.enabled,
      ).toBe(false);
    },
  );

  it("preserves every surviving physical pin through reorder, disable and removal", () => {
    const original = standardHarnessProject();
    const mapping = pinMap(original);
    const changed = structuredClone(original);
    changed.outputs.reverse();
    changed.triggers.reverse();
    changed.outputs[0].enabled = false;
    changed.triggers[1].enabled = false;
    changed.outputs = changed.outputs.filter(
      (output) => output.standardSlot !== "relay-2",
    );
    changed.triggers = changed.triggers.filter(
      (trigger) => trigger.standardSlot !== "primary-pir",
    );
    changed.ir!.enabled = false;
    changed.audio.players = [];
    const allocated = allocatePins(changed).project;
    for (const [id, value] of Object.entries(pinMap(allocated)))
      expect(value).toEqual(mapping[id]);
    expect(allocated.ir).toMatchObject({ txPin: 9, rxPin: 2 });
    expect(allocatePins(changed).maxOutputs).toBe(7);
    expect(allocatePins(changed).availableOutputPins).toEqual([19]);
    expect(original).toEqual(standardHarnessProject());
  });

  it("adds missing optional sensors disabled without losing transitions or settings", () => {
    const source = standardHarnessProject();
    source.triggers = source.triggers.filter(
      (trigger) => !trigger.standardSlot?.startsWith("backup-"),
    );
    source.states.forEach(
      (state) =>
        (state.transitions = state.transitions.filter(
          (transition) => transition.triggerId !== "backup-pir",
        )),
    );
    source.outputs = source.outputs.filter(
      (output) => output.standardSlot !== "spare",
    );
    const before = structuredClone(source);
    const fixed = applyStandardHarness(source);
    expect(fixed.states).toEqual(source.states);
    expect(fixed.audio).toEqual(source.audio);
    expect(
      fixed.triggers
        .filter((trigger) => trigger.standardSlot?.startsWith("backup-"))
        .map((trigger) => trigger.enabled),
    ).toEqual([false, false]);
    expect(source).toEqual(before);
    expect(applyStandardHarness(fixed)).toEqual(fixed);
  });

  it("reserves absent player/IR/sensor slots instead of offering their pins for reuse", () => {
    const project = standardHarnessProject();
    project.triggers = project.triggers.filter(
      (trigger) => trigger.kind === "manual",
    );
    project.ir = undefined;
    project.audio.players = [];
    project.audio.ambientTrack = null;
    project.states.forEach((state) => (state.foregroundTrack = null));
    const allocated = allocatePins(project);
    expect(allocated.availableOutputPins).toEqual([19]);
    expect(allocated.maxOutputs).toBe(7);
    expect(
      allocated.project.outputs.find(
        (output) => output.standardSlot === "dc-ssr",
      )?.pin,
    ).toBe(17);
  });

  it("supports BUSY on A5 only while its output slot is disabled", () => {
    const project = standardHarnessProject();
    project.audio.players[0].feedback = { pin: null, activeLow: true };
    const allocated = allocatePins(project);
    expect(allocated.maxOutputs).toBe(6);
    expect(allocated.availableOutputPins).toEqual([]);
    expect(allocated.project.audio.players[0].feedback?.pin).toBe(19);
    expect(errors(allocated.project)).toEqual([]);
    allocated.project.outputs.find(
      (output) => output.standardSlot === "spare",
    )!.enabled = true;
    expect(
      errors(allocated.project).some((issue) =>
        issue.message.includes("either the spare output"),
      ),
    ).toBe(true);
    expect(compileProject(allocated.project).bytes).toHaveLength(0);
  });

  it("refuses duplicate slots, wrong sensor kinds, forged pins and unknown slots", () => {
    const duplicate = standardHarnessProject();
    duplicate.outputs[1].standardSlot = "relay-1";
    expect(
      errors(duplicate).some((issue) =>
        issue.message.includes("already assigned"),
      ),
    ).toBe(true);
    expect(() => applyStandardHarness(duplicate)).toThrow("Duplicate");
    const kind = standardHarnessProject();
    kind.triggers[0].kind = "pir";
    expect(
      errors(kind).some((issue) => issue.message.includes("requires a button")),
    ).toBe(true);
    expect(() => applyStandardHarness(kind)).toThrow("incompatible");
    const forged = standardHarnessProject();
    forged.outputs[0].pin = 2;
    expect(
      errors(forged).some((issue) => issue.message.includes("must retain D7")),
    ).toBe(true);
    const unknown = standardHarnessProject();
    (unknown.outputs[0] as unknown as { standardSlot: string }).standardSlot =
      "arbitrary-pin";
    expect(() => parseProject(unknown)).toThrow("standardSlot");
  });

  it("does not infer a new identity during normal allocation", () => {
    const project = standardHarnessProject();
    delete project.outputs[0].standardSlot;
    const result = allocatePins(project);
    expect(result.project.outputs[0].pin).toBeNull();
    expect(
      result.issues.some((issue) => issue.path === "outputs.0.standardSlot"),
    ).toBe(true);
  });

  it("rejects excess channels and incompatible boards during explicit conversion", () => {
    const project = standardHarnessProject();
    project.outputs.push({
      ...project.outputs[0],
      id: "extra",
      standardSlot: undefined,
    });
    expect(() => applyStandardHarness(project)).toThrow("four relay, two SSR");
    const tooManySensors = standardHarnessProject();
    tooManySensors.triggers.push({ ...createTrigger("extra"), kind: "pir" });
    expect(() => applyStandardHarness(tooManySensors)).toThrow(
      "one beam contact",
    );
    const mega = standardHarnessProject();
    mega.board = "mega";
    expect(() => applyStandardHarness(mega)).toThrow("Uno");
    expect(errors(mega).some((issue) => issue.path === "wiring")).toBe(true);
  });

  it("rejects audio overlap without silently changing selected tracks or player records", () => {
    const project = standardHarnessProject();
    project.audio.keepAmbient = true;
    const audio = structuredClone(project.audio);
    expect(() => applyStandardHarness(project)).toThrow("one DFPlayer");
    const synced = synchronizeAudioPlayers(project);
    expect(synced.audio).toEqual(audio);
    expect(
      errors(synced).some((issue) =>
        issue.message.includes("standard harness supports one DFPlayer"),
      ),
    ).toBe(true);
    expect(compileProject(synced).bytes).toHaveLength(0);
    project.audio.keepAmbient = false;
    project.audio.players[0].kind = "yx5300";
    expect(() => applyStandardHarness(project)).toThrow("one DFPlayer");
    project.audio.players[0].kind = "dfplayer";
    project.audio.players.push({ ...project.audio.players[0], id: "player-2" });
    expect(synchronizeAudioPlayers(project).audio.players).toHaveLength(2);
    expect(
      errors(project).some((issue) => issue.path === "audio.players"),
    ).toBe(true);
  });
});

describe("disabled device runtime projection", () => {
  it.each(["full", "sparse", "inactive"] as const)(
    "matches the %s image exercised by production firmware host tests",
    (variant) => {
      expect(compileProject(standardHarnessProject(variant)).bytes).toEqual(
        new Uint8Array(
          readFileSync(
            new URL(`./standard-harness-${variant}.bin`, import.meta.url),
          ),
        ),
      );
    },
  );
  it("keeps editor records and compacts output/trigger indices in the compiled image", () => {
    const project = standardHarnessProject("sparse");
    const before = structuredClone(project);
    const runtime = toRuntimeProject(project);
    expect(runtime.outputs.map((output) => output.id)).toEqual([
      "output-1",
      "output-3",
      "output-4",
      "output-5",
      "output-6",
    ]);
    expect(runtime.triggers.map((trigger) => trigger.id)).toEqual([
      "beam",
      "pir",
      "sonar",
      "next",
    ]);
    expect(
      runtime.states[0].transitions.map((transition) => transition.triggerId),
    ).toEqual(["next", "pir", "beam"]);
    const compiled = compileProject(project);
    expect(
      compiled.issues.filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(compiled.bytes[9]).toBe(5);
    expect(compiled.bytes[10]).toBe(4);
    const view = new DataView(compiled.bytes.buffer);
    const transitionOffset = view.getUint16(30, true);
    expect(compiled.bytes[transitionOffset]).toBe(3); // Manual Next follows active sensors.
    const eventOffset = view.getUint16(28, true);
    expect(compiled.bytes[eventOffset + 6 + 4]).toBe(4); // Strobe moves from output index 5 to 4.
    expect(compiled.usedBytes).toBe(estimateSceneBytes(runtime));
    expect(compiled.bytes.length).toBe(compiled.usedBytes);
    expect(compiled.usedBytes).toBeLessThan(
      compileProject(standardHarnessProject()).usedBytes,
    );
    expect(project).toEqual(before);
  });

  it("omits empty child sequences and their activation transitions", () => {
    const project = standardHarnessProject("inactive");
    const runtime = toRuntimeProject(project);
    expect(runtime.states.map((state) => state.id)).toEqual([
      "idle",
      "approach",
    ]);
    expect(runtime.triggers.map((trigger) => trigger.id)).toEqual(["next"]);
    expect(
      runtime.states.every((state) =>
        state.transitions.every(
          (transition) => transition.targetStateId !== "child",
        ),
      ),
    ).toBe(true);
    expect(compileProject(project).bytes[12]).toBe(2);
    expect(
      project.states.find((state) => state.id === "child")?.events,
    ).toHaveLength(1);
  });

  it("stores optional IR commands and cues while excluding them when IR is disabled", () => {
    const project = standardHarnessProject();
    project.ir!.commands = [
      {
        id: "on",
        name: "On",
        signal: { kind: "nec", code: 0x12345678 },
        sendCount: 1,
        gapMs: 100,
      },
    ];
    project.ir!.macros = [
      {
        id: "macro",
        name: "On macro",
        steps: [{ id: "step", atMs: 0, commandId: "on" }],
      },
    ];
    project.states[1].irEvents = [{ id: "cue", atMs: 0, macroId: "macro" }];
    const backup = project.triggers.find(
      (trigger) => trigger.standardSlot === "backup-ultrasonic",
    )!;
    backup.zones![0].onEnter.push({ id: "ir", kind: "ir", commandId: "on" });
    project.ir!.enabled = false;
    expect(errors(project)).toEqual([]);
    const runtime = toRuntimeProject(project);
    expect(runtime.states[1].irEvents).toEqual([]);
    expect(
      runtime.triggers.find((trigger) => trigger.id === backup.id)?.zones![0]
        .onEnter,
    ).toHaveLength(1);
    expect(project.states[1].irEvents).toHaveLength(1);
    expect(compileProject(project).bytes.length).toBeGreaterThan(0);
  });

  it("never hides malformed references just because their owner is disabled", () => {
    const project = standardHarnessProject("sparse");
    project.states[1].events.push({
      id: "missing",
      outputId: "missing",
      startMs: 0,
      endMs: 50,
    });
    expect(
      toRuntimeProject(project).states[1].events.some(
        (event) => event.id === "missing",
      ),
    ).toBe(true);
    expect(
      compileProject(project).issues.some(
        (issue) => issue.message === "Output channel does not exist.",
      ),
    ).toBe(true);
    const badZone = standardHarnessProject("sparse");
    badZone.triggers.find(
      (trigger) => trigger.id === "backup-sonar",
    )!.zones![0].onEnter[0] = { id: "bad", kind: "state", stateId: "missing" };
    expect(
      errors(badZone).some(
        (issue) => issue.message === "Target state does not exist.",
      ),
    ).toBe(true);
  });

  it("counts enabled triggers for firmware capacity while retaining disabled slots", () => {
    const project = standardHarnessProject("inactive");
    for (let index = 0; index < 7; index++)
      project.triggers.push({
        ...createTrigger(`manual-${index}`),
        kind: "manual",
        pin: null,
        echoPin: null,
      });
    expect(project.triggers.length).toBe(13);
    expect(errors(project)).toEqual([]);
    expect(compileProject(project).bytes[10]).toBe(8);
    project.triggers.push({
      ...createTrigger("overflow"),
      kind: "manual",
      pin: null,
      echoPin: null,
    });
    expect(errors(project).some((issue) => issue.path === "triggers")).toBe(
      true,
    );
  });

  it("preserves older project bytes and treats omitted enabled flags as enabled", () => {
    const project = createDefaultProject();
    const compiled = compileProject(project);
    expect(compiled.bytes).toEqual(
      new Uint8Array(
        readFileSync(new URL("./default-scene.bin", import.meta.url)),
      ),
    );
    expect(toRuntimeProject(project).outputs).toEqual(project.outputs);
    expect(toRuntimeProject(project).triggers).toEqual(project.triggers);
    const malformed = standardHarnessProject();
    (malformed.outputs[0] as unknown as { enabled: string }).enabled = "false";
    expect(() => parseProject(malformed)).toThrow("enabled");
  });
});
