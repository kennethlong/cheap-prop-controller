import { describe, expect, it } from "vitest";
import {
  allocatePins,
  createSimulator,
  type SceneProject,
} from "../../src/shared";
import { parallelChildrenProject } from "./parallel-children-fixture";

function approach(project = parallelChildrenProject()) {
  const simulator = createSimulator(project);
  expect(simulator.trigger("start")).toBe(true);
  return simulator;
}

describe("independent child timelines", () => {
  it("preserves parent outputs, elapsed time, foreground playback, and exact pulse/cooldown boundaries", () => {
    const simulator = approach();
    simulator.advance(1000);
    const before = simulator.snapshot();
    expect(before.outputs["output-1"]).toBe(true);
    expect(simulator.trigger("beam")).toBe(true);
    const launched = simulator.snapshot();
    expect(launched.stateId).toBe("approach");
    expect(launched.elapsedMs).toBe(1000);
    expect(launched.audio).toEqual(before.audio);
    expect(launched.outputs).toEqual({
      "output-1": true,
      "output-5": true,
      "output-6": false,
    });
    expect(launched.children).toEqual([
      {
        id: "child-a",
        name: "Air pulse",
        phase: "running",
        elapsedMs: 0,
        remainingMs: 250,
      },
    ]);
    expect(simulator.advance(200).outputs["output-5"]).toBe(true);
    expect(simulator.trigger("beam")).toBe(false); // ignored while running
    const ended = simulator.advance(50);
    expect(ended.outputs["output-5"]).toBe(false);
    expect(ended.outputs["output-1"]).toBe(true);
    expect(ended.elapsedMs).toBe(1250);
    expect(ended.audio[0].positionMs).toBe(1250);
    expect(ended.audio[0].track).toBe(2);
    expect(ended.children[0]).toMatchObject({
      phase: "cooldown",
      elapsedMs: 250,
      remainingMs: 2000,
    });
    simulator.advance(1950);
    expect(simulator.trigger("beam")).toBe(false); // does not extend cooldown
    expect(simulator.advance(50).children).toEqual([]);
    expect(simulator.trigger("beam")).toBe(true);
    expect(simulator.snapshot().audio[0].positionMs).toBe(3250);
    expect(simulator.snapshot().elapsedMs).toBe(250); // parent timeline naturally looped
  });

  it("handles independent children with delayed intervals and different cooldowns", () => {
    const simulator = approach();
    simulator.trigger("beam");
    simulator.trigger("second");
    expect(simulator.snapshot().children).toHaveLength(2);
    expect(simulator.snapshot().outputs["output-6"]).toBe(false);
    expect(simulator.advance(100).outputs["output-6"]).toBe(true);
    expect(simulator.advance(150).outputs).toEqual({
      "output-1": true,
      "output-5": false,
      "output-6": true,
    });
    expect(simulator.advance(150).outputs["output-6"]).toBe(false);
    expect(simulator.advance(100).children.map((child) => child.phase)).toEqual(
      ["cooldown", "cooldown"],
    );
    expect(simulator.advance(500).children.map((child) => child.id)).toEqual([
      "child-a",
    ]);
    expect(simulator.trigger("second")).toBe(true);
    expect(simulator.trigger("beam")).toBe(false);
  });

  it("preserves a child across a normal parent change and limits launches to the source state's mappings", () => {
    const simulator = createSimulator(parallelChildrenProject());
    expect(simulator.trigger("beam")).toBe(false); // idle has no child mapping
    simulator.trigger("start");
    simulator.trigger("second");
    simulator.advance(150);
    simulator.trigger("next");
    const changed = simulator.snapshot();
    expect(changed.stateId).toBe("outro");
    expect(changed.elapsedMs).toBe(0);
    expect(changed.audio[0].track).toBe(3);
    expect(changed.outputs["output-6"]).toBe(true);
    expect(changed.children[0].elapsedMs).toBe(150);
    expect(simulator.advance(250).outputs["output-6"]).toBe(false);
    simulator.advance(600);
    expect(simulator.trigger("second")).toBe(false); // no mapping in outro, even once ready
    expect(simulator.trigger("beam")).toBe(true);
  });

  it("dispatches simultaneous edges against the original parent and only the first main transition", () => {
    const project = parallelChildrenProject();
    const parent = project.states[1];
    parent.transitions = [
      parent.transitions[2],
      ...parent.transitions.slice(0, 2),
      { triggerId: "start", targetStateId: "idle" },
    ];
    const simulator = approach(project);
    for (const id of ["next", "beam", "second", "start"])
      simulator.setTrigger(id, true);
    const snapshot = simulator.advance(50);
    expect(snapshot.stateId).toBe("outro");
    expect(snapshot.children.map((child) => child.id)).toEqual([
      "child-a",
      "child-b",
    ]);
    expect(snapshot.outputs["output-5"]).toBe(true);
    expect(snapshot.audio[0].track).toBe(3);
  });

  it.each(["stop", "reset", "start"] as const)(
    "%s cancels both running children and cooldowns",
    (operation) => {
      const simulator = approach();
      simulator.trigger("beam");
      simulator.advance(250);
      simulator.trigger("second");
      simulator.advance(100);
      expect(simulator.snapshot().children.map((child) => child.phase)).toEqual(
        ["cooldown", "running"],
      );
      const cleared = simulator[operation]();
      expect(cleared.children).toEqual([]);
      expect(cleared.outputs["output-5"]).toBe(false);
      expect(cleared.outputs["output-6"]).toBe(false);
      if (operation === "stop") simulator.start();
      simulator.trigger("start");
      expect(simulator.trigger("beam")).toBe(true);
    },
  );

  it("rearms exactly at completion with a zero cooldown", () => {
    const project = parallelChildrenProject();
    delete project.states[3].cooldownMs;
    const simulator = approach(project);
    simulator.trigger("beam");
    simulator.advance(200);
    expect(simulator.trigger("beam")).toBe(false);
    expect(simulator.advance(50).children).toEqual([]);
    expect(simulator.trigger("beam")).toBe(true);
  });

  it("supports active-low output polarity without activating an unstarted child", () => {
    const project = parallelChildrenProject();
    project.outputs[1].activeLow = true;
    const simulator = approach(project);
    expect(simulator.snapshot().physicalOutputs["output-5"]).toBe(true);
    simulator.trigger("beam");
    expect(simulator.snapshot().physicalOutputs["output-5"]).toBe(false);
    expect(simulator.advance(250).physicalOutputs["output-5"]).toBe(true);
  });

  it("holds an input without retriggering after cooldown and requires release before another activation", () => {
    const simulator = approach();
    simulator.setTrigger("beam", true);
    expect(simulator.advance(50).children).toHaveLength(1);
    expect(simulator.advance(5000).children).toEqual([]);
    simulator.setTrigger("beam", false);
    simulator.advance(50);
    simulator.setTrigger("beam", true);
    expect(simulator.advance(50).children).toHaveLength(1);
  });

  it("uses release edges without restarting parent audio", () => {
    const project = parallelChildrenProject();
    project.states[1].transitions[0].edge = "release";
    const simulator = approach(project);
    simulator.setTrigger("beam", true);
    expect(simulator.advance(100).children).toEqual([]);
    simulator.setTrigger("beam", false);
    const released = simulator.advance(50);
    expect(released.children).toHaveLength(1);
    expect(released.elapsedMs).toBe(150);
    expect(released.audio[0].positionMs).toBe(150);
  });

  it("supports timer child launches while ignoring intermediate ticks during execution/cooldown", () => {
    const project = parallelChildrenProject();
    Object.assign(project.triggers[2], {
      kind: "timer",
      pin: null,
      timerIntervalMs: 400,
    });
    const simulator = approach(project);
    expect(simulator.advance(400).children[0]).toMatchObject({
      id: "child-b",
      elapsedMs: 0,
    });
    expect(simulator.advance(800).children[0]).toMatchObject({
      id: "child-b",
      elapsedMs: 800,
    });
    expect(simulator.advance(200).children).toEqual([]);
    expect(simulator.advance(200).children[0]).toMatchObject({
      id: "child-b",
      elapsedMs: 0,
    });
    expect(simulator.snapshot().audio[0].positionMs).toBe(1600);
  });

  it("supports threshold ultrasonic activation and release child mappings", () => {
    let project = parallelChildrenProject();
    Object.assign(project.triggers[1], {
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    });
    project.states[1].transitions.push({
      triggerId: "beam",
      edge: "release",
      targetStateId: "child-b",
    });
    project = allocatePins(project).project;
    const simulator = approach(project);
    simulator.setDistance("beam", 200);
    simulator.advance(50);
    simulator.setDistance("beam", 80);
    expect(simulator.advance(50).children.map((child) => child.id)).toEqual([
      "child-a",
    ]);
    simulator.setDistance("beam", 130);
    expect(simulator.advance(50).children.map((child) => child.id)).toEqual([
      "child-a",
      "child-b",
    ]);
  });

  it("keeps parent IR scheduling intact when a child launches", () => {
    let project: SceneProject = parallelChildrenProject();
    project.ir = {
      enabled: true,
      txPin: null,
      rxPin: null,
      commands: [
        {
          id: "lamp",
          name: "Lamp",
          signal: { kind: "nec", code: 0xef10df20 },
          sendCount: 1,
          gapMs: 100,
        },
      ],
    };
    project.states[1].irEvents = [
      { id: "entry", commandId: "lamp", atMs: 0 },
      { id: "later", commandId: "lamp", atMs: 200 },
    ];
    project = allocatePins(project).project;
    const simulator = approach(project);
    simulator.advance(100);
    simulator.trigger("beam");
    expect(simulator.snapshot().irActivity).toHaveLength(1);
    expect(
      simulator.advance(100).irActivity.map((entry) => entry.atMs),
    ).toEqual([0, 200]);
  });
});
