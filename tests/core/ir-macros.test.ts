import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  allocatePins,
  compileProject,
  createDefaultProject,
  createSimulator,
  estimateSceneBytes,
  expandIrEvents,
  irCommandDurationMs,
  irEventName,
  irMacroDurationMs,
  parseProject,
  validateProject,
  type IrMacro,
  type IrTimelineEvent,
  type SceneProject,
} from "../../src/shared";

function macro(): IrMacro {
  return {
    id: "candles",
    name: "On, brighten, off",
    steps: [
      { id: "on", atMs: 0, commandId: "on" },
      { id: "brighten", atMs: 1000, commandId: "brighten" },
      { id: "off", atMs: 8000, commandId: "off" },
    ],
  };
}
function project(): SceneProject {
  const value = createDefaultProject();
  value.outputs = value.outputs.slice(0, 4);
  value.ir = {
    enabled: true,
    txPin: null,
    rxPin: null,
    commands: ["on", "brighten", "off"].map((id, index) => ({
      id,
      name: `Candles ${id}`,
      signal: { kind: "nec", code: 0xef10df20 + index },
      sendCount: id === "brighten" ? 8 : 1,
      gapMs: id === "brighten" ? 400 : 100,
    })),
    macros: [macro()],
  };
  value.states.forEach((state) => {
    state.events = [];
    state.irEvents = [];
    state.loopTimeline = false;
  });
  value.states[1].irEvents = [{ id: "pattern", atMs: 0, macroId: "candles" }];
  return allocatePins(value).project;
}
const errors = (value: unknown) =>
  validateProject(value).filter((issue) => issue.severity === "error");

describe("reusable IR macros", () => {
  it("preserves legacy JSON shape and bytes when no macros are used", () => {
    const legacy = createDefaultProject();
    expect(
      Buffer.from(compileProject(parseProject(JSON.stringify(legacy))).bytes),
    ).toEqual(readFileSync("tests/core/default-scene.bin"));
    expect(parseProject(legacy).ir).toBeUndefined();
    const value = project();
    value.states[1].irEvents = [{ id: "direct", atMs: 500, commandId: "on" }];
    const withUnusedMacro = compileProject(value);
    delete value.ir!.macros;
    expect(compileProject(value).bytes).toEqual(withUnusedMacro.bytes);
    expect(parseProject(value).states[1].irEvents).toEqual([
      { id: "direct", atMs: 500, commandId: "on" },
    ]);
  });

  it("round-trips one named entry and compiles identically to explicit command entries", () => {
    const value = project();
    value.states[1].irEvents![0].atMs = 500;
    expect(parseProject(JSON.stringify(value))).toEqual(value);
    expect(errors(value)).toEqual([]);
    expect(
      expandIrEvents(value, value.states[1]).map(({ atMs, commandId }) => ({
        atMs,
        commandId,
      })),
    ).toEqual([
      { atMs: 500, commandId: "on" },
      { atMs: 1500, commandId: "brighten" },
      { atMs: 8500, commandId: "off" },
    ]);
    const explicit = structuredClone(value);
    explicit.states[1].irEvents = expandIrEvents(value, value.states[1]).map(
      ({ id, atMs, commandId }) => ({ id, atMs, commandId }),
    );
    delete explicit.ir!.macros;
    const compiled = compileProject(value);
    expect(compiled.bytes).toEqual(compileProject(explicit).bytes);
    expect(compiled.usedBytes).toBe(estimateSceneBytes(explicit));
    const noCues = structuredClone(value);
    noCues.states[1].irEvents = [];
    // Repeated brightness presses are one firmware command, not eight records.
    expect(compiled.usedBytes - estimateSceneBytes(noCues)).toBe(3 * 4);
    const view = new DataView(compiled.bytes.buffer);
    expect(view.getUint16(compiled.bytes.length - 12, true)).toBe(3);
  });

  it("orders coincident steps by authored entry then step order, with independent instances", () => {
    const value = project();
    value.ir!.macros![0].steps = [
      { id: "a", atMs: 1000, commandId: "off" },
      { id: "b", atMs: 0, commandId: "on" },
      { id: "c", atMs: 1000, commandId: "brighten" },
    ];
    value.states[1].irEvents = [
      { id: "first", atMs: 1000, commandId: "on" },
      { id: "macro", atMs: 0, macroId: "candles" },
      { id: "last", atMs: 1000, commandId: "off" },
      { id: "second-instance", atMs: 2000, macroId: "candles" },
    ];
    expect(
      expandIrEvents(value, value.states[1]).map((event) => [
        event.atMs,
        event.commandId,
        event.sourceEventIndex,
        event.sourceStepIndex,
      ]),
    ).toEqual([
      [0, "on", 1, 1],
      [1000, "on", 0, undefined],
      [1000, "off", 1, 0],
      [1000, "brighten", 1, 2],
      [1000, "off", 2, undefined],
      [2000, "on", 3, 1],
      [3000, "off", 3, 0],
      [3000, "brighten", 3, 2],
    ]);
  });

  it("uses command settings for serialized duration and resolves both kinds of names", () => {
    const value = project();
    const pattern = value.ir!.macros![0];
    pattern.steps[2].atMs = 1000;
    const [, brighten, off] = value.ir!.commands;
    expect(irMacroDurationMs(pattern, value.ir!.commands)).toBe(
      1000 + irCommandDurationMs(brighten) + irCommandDurationMs(off),
    );
    expect(irEventName(value, { id: "a", atMs: 0, macroId: "candles" })).toBe(
      pattern.name,
    );
    expect(irEventName(value, { id: "a", atMs: 0, commandId: "on" })).toBe(
      "Candles on",
    );
    expect(irEventName(value, { id: "a", atMs: 0, macroId: "missing" })).toBe(
      "Missing IR macro",
    );
    expect(irEventName(value, { id: "a", atMs: 0 })).toBe("Missing IR command");
    pattern.steps = [];
    expect(irMacroDurationMs(pattern, value.ir!.commands)).toBe(0);
  });

  it.each([
    { id: "bad", atMs: 0, commandId: "on", macroId: "candles" },
    { id: "bad", atMs: 0 },
    { id: "bad", atMs: 0, macroId: "missing" },
    { id: "bad", atMs: 0, commandId: "missing" },
  ] satisfies IrTimelineEvent[])(
    "rejects invalid entry targets without crashing editable projects: %j",
    (event) => {
      const value = project();
      value.states[1].irEvents = [event];
      expect(parseProject(value)).toEqual(value);
      expect(errors(value).length).toBeGreaterThan(0);
      expect(compileProject(value).bytes).toHaveLength(0);
      expect(() => expandIrEvents(value, value.states[1])).toThrow();
    },
  );

  it("rejects absent library commands, empty macros, duplicate IDs, and disabled hardware", () => {
    const value = project();
    value.ir!.macros![0].steps[0].commandId = "missing";
    expect(
      errors(value).some(
        (issue) => issue.path === "ir.macros.0.steps.0.commandId",
      ),
    ).toBe(true);
    expect(compileProject(value).bytes).toHaveLength(0);
    value.ir!.macros![0].steps = [];
    expect(parseProject(value)).toEqual(value);
    expect(
      errors(value).some((issue) => issue.path === "ir.macros.0.steps"),
    ).toBe(true);
    value.ir!.macros = [macro(), macro()];
    value.ir!.macros[0].steps[1].id = "on";
    value.states[1].irEvents!.push({ ...value.states[1].irEvents![0] });
    expect(
      errors(value).filter((issue) => issue.message.includes("Duplicate ID")),
    ).toHaveLength(3);
    value.ir!.enabled = false;
    expect(
      errors(value).some((issue) => issue.message.includes("Enable IR")),
    ).toBe(true);
  });

  it("checks every macro instance against the state boundary and enforces 50 ms offsets", () => {
    const value = project();
    value.states[1].irEvents![0].atMs = 2000;
    expect(
      errors(value).some((issue) =>
        issue.message.includes("Macro step 3 starts at 10000"),
      ),
    ).toBe(true);
    value.states[1].irEvents![0].atMs = 1950;
    expect(errors(value)).toEqual([]);
    for (const offset of [-50, 25, LIMITS.maxDurationMs]) {
      value.ir!.macros![0].steps[0].atMs = offset;
      expect(
        errors(value).some(
          (issue) => issue.path === "ir.macros.0.steps.0.atMs",
        ),
      ).toBe(true);
    }
  });

  it("rejects malformed imports, nesting, repetition overrides, and excessive import arrays", () => {
    for (const mutate of [
      (value: any) => {
        value.ir.macros = {};
      },
      (value: any) => {
        value.ir.macros[0].steps = null;
      },
      (value: any) => {
        value.ir.macros[0].steps[0].atMs = "100";
      },
      (value: any) => {
        value.ir.macros[0].steps[0].commandId = null;
      },
      (value: any) => {
        value.ir.macros[0].steps[0].macroId = "candles";
      },
      (value: any) => {
        value.ir.macros[0].steps[0].sendCount = 8;
      },
      (value: any) => {
        value.ir.macros = Array(257).fill(macro());
      },
      (value: any) => {
        value.ir.macros[0].steps = Array(257).fill(macro().steps[0]);
      },
    ]) {
      const value = project();
      mutate(value);
      expect(() => parseProject(value)).toThrow();
      expect(compileProject(value).bytes).toHaveLength(0);
    }
  });

  it("limits library macros and steps and counts expanded records across states", () => {
    const value = project();
    value.board = "mega";
    Object.assign(value.ir!, { txPin: 11, rxPin: 2 });
    const long = value.ir!.macros![0];
    long.steps = Array.from({ length: 32 }, (_, index) => ({
      id: `s${index}`,
      atMs: index * 1000,
      commandId: "on",
    }));
    value.states[1].durationMs = 40000;
    value.states[1].irEvents = Array.from({ length: 4 }, (_, index) => ({
      id: `m${index}`,
      atMs: 0,
      macroId: "candles",
    }));
    const allocated = allocatePins(value).project;
    expect(errors(allocated)).toEqual([]);
    expect(expandIrEvents(allocated, allocated.states[1])).toHaveLength(128);
    allocated.states[2].irEvents = [{ id: "extra", atMs: 0, commandId: "on" }];
    expect(errors(allocated).some((issue) => issue.path === "irEvents")).toBe(
      true,
    );
    allocated.states[2].irEvents = [];
    allocated.states[1].irEvents!.push({
      id: "extra",
      atMs: 0,
      commandId: "on",
    });
    expect(() => expandIrEvents(allocated, allocated.states[1])).toThrow("128");
    expect(compileProject(allocated).bytes).toHaveLength(0);
    allocated.ir!.macros![0].steps.push({
      id: "too-many",
      atMs: 16000,
      commandId: "on",
    });
    expect(
      errors(allocated).some((issue) => issue.path === "ir.macros.0.steps"),
    ).toBe(true);
    allocated.ir!.macros = Array.from({ length: 33 }, (_, index) => ({
      ...macro(),
      id: `macro${index}`,
    }));
    expect(errors(allocated).some((issue) => issue.path === "ir.macros")).toBe(
      true,
    );
  });

  it("applies queue capacity and overlap checks to expanded commands and disallows child macros", () => {
    const value = project();
    value.ir!.macros![0].steps = Array.from({ length: 9 }, (_, index) => ({
      id: `s${index}`,
      atMs: 0,
      commandId: "on",
    }));
    expect(
      errors(value).some((issue) => issue.message.includes("eight IR")),
    ).toBe(true);
    value.ir!.macros![0].steps.pop();
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" && issue.message.includes("send queue"),
      ),
    ).toBe(true);
    value.states[1].kind = "child";
    expect(
      errors(value).some((issue) =>
        issue.message.includes("child sequence cannot send IR"),
      ),
    ).toBe(true);
  });

  it("rejects a backlog of long repeat commands even when every step uses a different tick", () => {
    const value = project();
    value.ir!.macros![0].steps = Array.from({ length: 10 }, (_, index) => ({
      id: `step${index}`,
      atMs: index * 50,
      commandId: index === 9 ? "off" : "brighten",
    }));
    expect(
      errors(value).some((issue) =>
        issue.message.includes("eight IR commands"),
      ),
    ).toBe(true);
    expect(compileProject(value).bytes).toHaveLength(0);
    value.ir!.macros![0].steps.pop();
    // One active transmission plus eight queued is allowed.
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" &&
          issue.message.includes("timeline's end"),
      ),
    ).toBe(true);
    value.states[1].loopTimeline = true;
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "error" &&
          issue.message.includes("The send queue will overflow"),
      ),
    ).toBe(true);
    // The queue drains when steps allow sufficient time for all eight presses.
    value.ir!.macros![0].steps.push({ id: "last", atMs: 0, commandId: "off" });
    value.ir!.macros![0].steps.forEach((step, index) => {
      step.atMs = index * 5000;
    });
    value.states[1].durationMs = 50000;
    expect(errors(value)).toEqual([]);
  });

  it("allows loading the next command during the preceding command's final quiet gap", () => {
    const value = project();
    value.ir!.commands[0].signal = {
      kind: "raw",
      pulsesUs: [100, 100, 100, 100, 100],
    };
    value.ir!.commands[0].gapMs = 2000;
    value.ir!.macros![0].steps = Array.from({ length: 10 }, (_, index) => ({
      id: `step${index}`,
      atMs: index * 50,
      commandId: "on",
    }));
    // The first frame is finished before the second cue. The second job loads
    // immediately and waits out the gap; the remaining eight fit in the queue.
    expect(errors(value)).toEqual([]);
    value.ir!.macros![0].steps.push({
      id: "overflow",
      atMs: 500,
      commandId: "off",
    });
    expect(
      errors(value).some((issue) =>
        issue.message.includes("eight IR commands"),
      ),
    ).toBe(true);
  });

  it("rejects sustained loop overload even when the first cycle fits the queue", () => {
    const value = project();
    value.ir!.macros![0].steps = [
      { id: "brighten", atMs: 0, commandId: "brighten" },
      { id: "off", atMs: 1500, commandId: "off" },
    ];
    value.states[1].durationMs = 2000;
    expect(errors(value)).toEqual([]);
    value.states[1].loopTimeline = true;
    expect(
      errors(value).some((issue) =>
        issue.message.includes("Lengthen the looping timeline"),
      ),
    ).toBe(true);
    expect(compileProject(value).bytes).toHaveLength(0);
    value.ir!.commands[1].sendCount = 1;
    expect(errors(value)).toEqual([]);
  });

  it("warns about a late cross-boundary burst without rejecting sustainable loop throughput", () => {
    const value = project();
    value.ir!.macros![0].steps = [{ id: "on", atMs: 9950, commandId: "on" }];
    value.states[1].loopTimeline = true;
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" &&
          issue.message.includes("carries over between loops"),
      ),
    ).toBe(true);
  });
});

describe("IR macro preview", () => {
  it("plays a repeated-brightness macro as three logical commands and cancels future steps on transition", () => {
    const value = project();
    const simulator = createSimulator(value);
    simulator.trigger("approach");
    expect(
      simulator.advance(1000).irActivity.map((activity) => activity.commandId),
    ).toEqual(["on", "brighten"]);
    simulator.trigger("scare");
    expect(
      simulator.advance(10000).irActivity.map((activity) => activity.commandId),
    ).toEqual(["on", "brighten"]);
  });

  it("restarts all steps on each loop with no duplicate tick-zero cue", () => {
    const value = project();
    value.states[1].loopTimeline = true;
    const simulator = createSimulator(value);
    simulator.trigger("approach");
    expect(
      simulator
        .advance(11000)
        .irActivity.map((activity) => [activity.commandId, activity.atMs]),
    ).toEqual([
      ["on", 0],
      ["brighten", 1000],
      ["off", 8000],
      ["on", 10000],
      ["brighten", 11000],
    ]);
  });

  it("cancels deferred steps on STOP and reset, and starts a fresh instance after reentry", () => {
    const value = project();
    const simulator = createSimulator(value);
    simulator.trigger("approach");
    simulator.advance(500);
    simulator.stop();
    expect(
      simulator.advance(10000).irActivity.map((activity) => activity.commandId),
    ).toEqual(["on"]);
    simulator.reset();
    expect(simulator.advance(10000).irActivity).toEqual([]);
    simulator.trigger("approach");
    simulator.advance(500);
    simulator.reset();
    expect(simulator.advance(10000).irActivity).toEqual([]);
    simulator.trigger("approach");
    expect(
      simulator.advance(8000).irActivity.map((activity) => activity.commandId),
    ).toEqual(["on", "brighten", "off"]);
  });

  it("gives a same-tick physical transition priority over a pending macro step", () => {
    const value = project();
    value.triggers.find((trigger) => trigger.id === "scare")!.debounceMs = 0;
    const simulator = createSimulator(value);
    simulator.trigger("approach");
    simulator.advance(950);
    simulator.setTrigger("scare", true);
    expect(
      simulator.advance(50).irActivity.map((activity) => activity.commandId),
    ).toEqual(["on"]);
  });
});
