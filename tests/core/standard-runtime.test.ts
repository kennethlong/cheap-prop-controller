import { describe, expect, it } from "vitest";
import {
  applyStandardHarness,
  compileProject,
  createDefaultProject,
  createSimulator,
  createState,
  createTrigger,
  toRuntimeProject,
  type SceneProject,
} from "../../src/shared";

function bench(): SceneProject {
  const project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 6);
  project.triggers = [
    createTrigger("beam", "Beam"),
    {
      ...createTrigger("pir", "PIR"),
      kind: "pir",
      activeLow: false,
      pullup: false,
    },
    {
      ...createTrigger("near", "Near"),
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    },
    { ...createTrigger("next", "Next"), kind: "manual" },
  ];
  project.states.forEach((state, index) => {
    state.transitions = [
      {
        triggerId: "next",
        targetStateId: ["approach", "scare", "idle"][index],
      },
      { triggerId: "beam", targetStateId: "blast" },
    ];
  });
  project.states[0].transitions.push({
    triggerId: "pir",
    targetStateId: "approach",
  });
  project.states[1].transitions.push({
    triggerId: "near",
    targetStateId: "scare",
  });
  project.states[1].events.push({
    id: "strobe",
    outputId: "output-6",
    startMs: 0,
    endMs: 500,
  });
  project.states.push({
    ...createState("blast", "Blast"),
    kind: "child",
    durationMs: 250,
    events: [{ id: "pulse", outputId: "output-5", startMs: 0, endMs: 250 }],
  });
  project.ir = { enabled: true, rxPin: null, txPin: null, commands: [] };
  return applyStandardHarness(project);
}

describe("standard harness desktop/runtime parity", () => {
  it("cannot inject a disabled PIR or sample absent backup sensors", () => {
    const project = bench();
    project.triggers.find((trigger) => trigger.id === "pir")!.enabled = false;
    const simulator = createSimulator(project);
    expect(simulator.trigger("pir")).toBe(false);
    expect(simulator.snapshot().stateId).toBe("idle");
    expect(Object.keys(simulator.snapshot().distances)).toEqual(["near"]);
    expect(simulator.trigger("next")).toBe(true);
    expect(simulator.snapshot().stateId).toBe("approach");
    expect(simulator.trigger("near")).toBe(true);
    expect(simulator.snapshot().stateId).toBe("scare");
  });

  it("retains disabled child edits while excluding its runtime effects", () => {
    const project = bench();
    project.outputs.find(
      (output) => output.standardSlot === "dc-ssr",
    )!.enabled = false;
    const original = structuredClone(project);
    const runtime = toRuntimeProject(project);
    expect(runtime.states.some((state) => state.id === "blast")).toBe(false);
    expect(
      compileProject(project).issues.filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    const simulator = createSimulator(project);
    expect(simulator.trigger("beam")).toBe(false);
    expect(simulator.snapshot().children).toEqual([]);
    expect(simulator.snapshot().outputs["output-5"]).toBeUndefined();
    expect(simulator.trigger("next")).toBe(true);
    expect(simulator.snapshot().outputs["output-6"]).toBe(true);
    expect(project).toEqual(original);

    project.outputs.find(
      (output) => output.standardSlot === "dc-ssr",
    )!.enabled = true;
    const enabled = createSimulator(project);
    enabled.trigger("beam");
    expect(enabled.snapshot().outputs["output-5"]).toBe(true);
    expect(enabled.advance(250).outputs["output-5"]).toBe(false);
    expect(
      project.outputs.find((output) => output.standardSlot === "dc-ssr")!.pin,
    ).toBe(17);
  });

  it("keeps learned IR cues dormant when the transceiver is disabled", () => {
    const project = bench();
    project.ir!.commands = [
      {
        id: "on",
        name: "Candles on",
        signal: { kind: "nec", code: 0x20df10ef },
        sendCount: 1,
        gapMs: 100,
      },
    ];
    project.states[0].irEvents = [
      { id: "on-at-start", atMs: 0, commandId: "on" },
    ];
    project.ir!.enabled = false;
    expect(
      compileProject(project).issues.filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
    expect(createSimulator(project).snapshot().irActivity).toEqual([]);
    expect(project.states[0].irEvents).toHaveLength(1);
    project.ir!.enabled = true;
    project.ir!.rxPin = 2;
    project.ir!.txPin = 9;
    expect(
      createSimulator(project)
        .snapshot()
        .irActivity.map((event) => event.commandId),
    ).toEqual(["on"]);
  });
});
