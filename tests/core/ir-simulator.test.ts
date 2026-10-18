import { describe, expect, it } from "vitest";
import {
  allocatePins,
  createDefaultProject,
  createSimulator,
  createTrigger,
  type IrTimelineEvent,
  type SceneProject,
} from "../../src/shared";

const cue = (
  atMs: number,
  commandId: string,
  id = `${commandId}-${atMs}`,
): IrTimelineEvent => ({
  id,
  atMs,
  commandId,
});
function irProject(): SceneProject {
  const project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 4);
  project.ir = {
    enabled: true,
    txPin: null,
    rxPin: null,
    commands: ["on", "off", "dim"].map((id, index) => ({
      id,
      name: `Candle ${id}`,
      signal: { kind: "nec", code: 0xff00aa50 + index },
      sendCount: 1,
      gapMs: 100,
    })),
  };
  for (const state of project.states) {
    state.durationMs = 1000;
    state.loopTimeline = false;
    state.events = [];
    state.irEvents = [];
  }
  return allocatePins(project).project;
}

describe("logical IR preview", () => {
  it("fires tick-zero cues once on initial entry, without replaying snapshots", () => {
    const project = irProject();
    project.states[0].irEvents = [cue(0, "off")];
    const simulator = createSimulator(project);
    expect(simulator.snapshot().irActivity).toEqual([
      {
        sequence: 1,
        commandId: "off",
        name: "Candle off",
        atMs: 0,
        stateId: "idle",
        source: "timeline",
      },
    ]);
    expect(simulator.snapshot().irActivity).toHaveLength(1);
    expect(simulator.advance(0).irActivity).toHaveLength(1);
    expect(simulator.advance(49).irActivity).toHaveLength(1);
  });

  it("dispatches crossings on 50ms ticks in timestamp and stable listed order", () => {
    const project = irProject();
    project.states[0].irEvents = [
      cue(200, "on"),
      cue(100, "off"),
      cue(100, "dim"),
    ];
    const simulator = createSimulator(project);
    expect(simulator.advance(99).irActivity).toEqual([]);
    expect(
      simulator.advance(1).irActivity.map((entry) => entry.commandId),
    ).toEqual(["off", "dim"]);
    const finished = simulator.advance(150).irActivity;
    expect(finished.map((entry) => [entry.commandId, entry.atMs])).toEqual([
      ["off", 100],
      ["dim", 100],
      ["on", 200],
    ]);
  });

  it("does not repeatedly send the final cue after a nonlooping state ends", () => {
    const project = irProject();
    project.states[0].irEvents = [cue(950, "off")];
    const simulator = createSimulator(project);
    const result = simulator.advance(3000);
    expect(result.elapsedMs).toBe(1000);
    expect(result.irActivity.map((entry) => entry.atMs)).toEqual([950]);
  });

  it("repeats cues including tick zero on every timeline loop", () => {
    const project = irProject();
    Object.assign(project.states[0], {
      durationMs: 500,
      loopTimeline: true,
      irEvents: [cue(0, "off"), cue(100, "on")],
    });
    const result = createSimulator(project).advance(1000);
    expect(
      result.irActivity.map((entry) => [entry.commandId, entry.atMs]),
    ).toEqual([
      ["off", 0],
      ["on", 100],
      ["off", 500],
      ["on", 600],
      ["off", 1000],
    ]);
  });

  it("rejects one-tick IR loops that cannot drain the transmitter queue", () => {
    const project = irProject();
    Object.assign(project.states[0], {
      durationMs: 50,
      loopTimeline: true,
      irEvents: [cue(0, "on")],
    });
    expect(() => createSimulator(project)).toThrow("send queue will overflow");
  });

  it("fires entry cues again on a same-state restart and cancels its previous timer", () => {
    const project = irProject();
    project.states[1].irEvents = [cue(0, "on"), cue(200, "off")];
    project.states[1].transitions.push({
      triggerId: "approach",
      targetStateId: "approach",
    });
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    simulator.advance(100);
    simulator.trigger("approach");
    expect(
      simulator
        .advance(100)
        .irActivity.map((entry) => [entry.commandId, entry.atMs]),
    ).toEqual([
      ["on", 0],
      ["on", 100],
    ]);
    expect(simulator.advance(100).irActivity.at(-1)).toMatchObject({
      commandId: "off",
      atMs: 300,
    });
  });

  it("prioritizes a physical state transition over a due cue from the old state", () => {
    const project = irProject();
    project.states[0].irEvents = [cue(100, "off")];
    project.states[1].irEvents = [cue(0, "on")];
    project.triggers[0].debounceMs = 0;
    const simulator = createSimulator(project);
    simulator.advance(50);
    simulator.setTrigger("approach", true);
    const result = simulator.advance(50);
    expect(
      result.irActivity.map((entry) => [entry.commandId, entry.atMs]),
    ).toEqual([["on", 100]]);
  });

  it("does not duplicate tick-zero or dispatch an old cue when a physical edge restarts the same state", () => {
    const project = irProject();
    project.states[0].irEvents = [cue(0, "off"), cue(100, "dim")];
    project.triggers[2].debounceMs = 0;
    const simulator = createSimulator(project);
    simulator.advance(50);
    simulator.setTrigger("reset", true);
    expect(
      simulator
        .advance(50)
        .irActivity.map((entry) => [entry.commandId, entry.atMs]),
    ).toEqual([
      ["off", 0],
      ["off", 100],
    ]);
  });

  it("preserves exit, state-entry, and following zone command order", () => {
    const project = irProject();
    project.states[1].irEvents = [cue(0, "on")];
    project.triggers.push({
      ...createTrigger("distance"),
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
      debounceMs: 0,
      distanceMode: "zones",
      zones: [
        {
          id: "far",
          name: "Far",
          minCm: 201,
          maxCm: 400,
          hysteresisCm: 5,
          onEnter: [],
          onExit: [{ id: "exit-off", kind: "ir", commandId: "off" }],
        },
        {
          id: "near",
          name: "Near",
          minCm: 2,
          maxCm: 100,
          hysteresisCm: 5,
          onEnter: [
            { id: "approach", kind: "state", stateId: "approach" },
            { id: "enter-dim", kind: "ir", commandId: "dim" },
          ],
          onExit: [],
        },
      ],
    });
    const simulator = createSimulator(allocatePins(project).project);
    simulator.setDistance("distance", 300);
    expect(simulator.advance(50).irActivity).toEqual([]);
    simulator.setDistance("distance", 50);
    const result = simulator.advance(50);
    expect(
      result.irActivity.map((entry) => [
        entry.commandId,
        entry.stateId,
        entry.source,
        entry.atMs,
      ]),
    ).toEqual([
      ["off", "idle", "zone", 100],
      ["on", "approach", "timeline", 100],
      ["dim", "approach", "zone", 100],
    ]);
    expect(simulator.advance(500).irActivity).toHaveLength(3);
    simulator.setDistance("distance", null);
    expect(simulator.advance(500).irActivity).toHaveLength(3);
  });

  it("keeps STOP silent and resets activity when explicitly restarted", () => {
    const project = irProject();
    project.states[0].irEvents = [cue(0, "off"), cue(200, "on")];
    const simulator = createSimulator(project);
    simulator.advance(100);
    simulator.stop();
    expect(simulator.trigger("approach")).toBe(false);
    expect(
      simulator.advance(1000).irActivity.map((entry) => entry.commandId),
    ).toEqual(["off"]);
    const restarted = simulator.start();
    expect(restarted.irActivity).toHaveLength(1);
    expect(restarted.irActivity[0]).toMatchObject({
      sequence: 2,
      commandId: "off",
      atMs: 100,
    });
    expect(simulator.advance(200).irActivity.at(-1)).toMatchObject({
      commandId: "on",
      atMs: 300,
    });
  });

  it("bounds activity history and does not expose mutable internal records", () => {
    const project = irProject();
    Object.assign(project.states[0], {
      durationMs: 200,
      loopTimeline: true,
      irEvents: [cue(0, "on")],
    });
    const simulator = createSimulator(project);
    const result = simulator.advance(8000);
    expect(result.irActivity).toHaveLength(32);
    expect(result.irActivity[0]).toMatchObject({ sequence: 10, atMs: 1800 });
    expect(result.irActivity.at(-1)).toMatchObject({
      sequence: 41,
      atMs: 8000,
    });
    result.irActivity[0].name = "tampered";
    result.irActivity.length = 0;
    expect(simulator.snapshot().irActivity[0].name).toBe("Candle on");
  });

  it("records one logical invocation for a configured sequence of repeated button presses", () => {
    const project = irProject();
    project.ir!.commands[0].sendCount = 3;
    project.states[0].irEvents = [cue(0, "on")];
    expect(createSimulator(project).advance(1000).irActivity).toHaveLength(1);
  });

  it("keeps projects without IR compatible and does not send saved inactive commands", () => {
    expect(
      createSimulator(createDefaultProject()).advance(1000).irActivity,
    ).toEqual([]);
    const project = irProject();
    project.ir!.enabled = false;
    expect(
      createSimulator(allocatePins(project).project).advance(1000).irActivity,
    ).toEqual([]);
  });
});
