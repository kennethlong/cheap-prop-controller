import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  compileProject,
  createDefaultProject,
  createState,
  createTrigger,
  parseProject,
  SceneSimulator,
  usesSceneControls,
  validateProject,
  verifySceneChecksum,
  type BoardId,
  type SceneProject,
  type TriggerConfig,
} from "../../src/shared";

function manual(id = "next"): TriggerConfig {
  return { ...createTrigger(id, "Next audio state"), kind: "manual" };
}

function manualProject(): SceneProject {
  const project = createDefaultProject();
  project.triggers[0] = { ...manual("approach"), timerIntervalMs: 50 };
  return allocatePins(project).project;
}

function beamBench(): SceneProject {
  const project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 5);
  project.triggers = [
    { ...createTrigger("beam", "IR beam"), debounceMs: 0 },
    manual(),
  ];
  project.audio = {
    ...project.audio,
    players: [{ id: "player-1", kind: "dfplayer", txPin: null, rxPin: null }],
    ambientTrack: 1,
    transitionMode: "cut",
    fadeMs: 0,
    tracks: [1, 2, 3].map((number) => ({ number, name: `Track ${number}` })),
  };
  project.states.forEach((state, index) => {
    state.transitions = [
      {
        triggerId: "next",
        targetStateId: ["approach", "scare", "idle"][index],
      },
      { triggerId: "beam", targetStateId: "blast" },
    ];
    state.foregroundTrack = index === 0 ? null : index + 1;
    state.loopAudio = true;
  });
  project.states.push({
    ...createState("blast", "Ankle blaster"),
    kind: "child",
    durationMs: 250,
    cooldownMs: 2000,
    events: [{ id: "pulse", outputId: "output-5", startMs: 0, endMs: 250 }],
  });
  return allocatePins(project).project;
}

const errorPaths = (project: SceneProject) =>
  validateProject(project)
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.path);

describe("software-only manual trigger allocation and image", () => {
  it.each<BoardId>(["uno", "nano", "pro-mini", "mega"])(
    "adding a manual input preserves every wired pin and output capacity on %s",
    (board) => {
      const project = beamBench();
      project.board = board;
      project.triggers = project.triggers.filter(
        (trigger) => trigger.kind !== "manual",
      );
      project.states.forEach((state) => {
        state.transitions = state.transitions.filter(
          (transition) => transition.triggerId !== "next",
        );
      });
      const before = allocatePins(project);
      project.triggers.unshift({ ...manual(), pin: 9, echoPin: 10 });
      const after = allocatePins(project);
      expect(after.issues).toEqual([]);
      expect(after.project.triggers[0].pin).toBeNull();
      expect(after.project.triggers[0].echoPin).toBeNull();
      expect(after.project.triggers[1]).toEqual(before.project.triggers[0]);
      expect(after.project.outputs).toEqual(before.project.outputs);
      expect(after.project.audio.players).toEqual(before.project.audio.players);
      expect(after.availableOutputPins).toEqual(before.availableOutputPins);
      expect(after.maxOutputs).toBe(before.maxOutputs);
      if (board !== "mega") {
        expect(after.project.triggers[1].pin).toBe(8);
        expect(after.project.outputs[4].pin).toBe(9);
      }
    },
  );

  it("encodes a canonical CPC2 software record without dormant physical or timer settings", () => {
    const project = manualProject();
    Object.assign(project.triggers[0], {
      activeLow: true,
      pullup: true,
      debounceMs: 150,
      thresholdCm: 250,
      hysteresisCm: 35,
      timerIntervalMs: 1000,
      timerResetOnTrigger: true,
    });
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(errorPaths(project)).toEqual([]);
    expect(usesSceneControls(project)).toBe(true);
    const { bytes } = compileProject(project);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("CPC2");
    expect(verifySceneChecksum(bytes)).toBe(true);
    const offset = new DataView(bytes.buffer).getUint16(22, true);
    expect(Array.from(bytes.slice(offset, offset + 8))).toEqual([
      4, 255, 255, 0, 0, 0, 0, 0,
    ]);
  });

  it("keeps child sequences in CPC3 and preserves beam/SSR wiring", () => {
    const project = beamBench();
    expect(errorPaths(project)).toEqual([]);
    const { bytes } = compileProject(project);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("CPC3");
    expect(project.triggers.map((trigger) => trigger.pin)).toEqual([8, null]);
    expect(project.outputs.map((output) => output.pin)).toEqual([
      7, 6, 5, 4, 9,
    ]);
  });

  it("leaves the legacy project image byte-for-byte unchanged", () => {
    expect(Buffer.from(compileProject(createDefaultProject()).bytes)).toEqual(
      readFileSync("tests/core/default-scene.bin"),
    );
  });

  it.each(["pin", "echoPin"] as const)(
    "rejects a manual %s before compilation",
    (field) => {
      const project = manualProject();
      project.triggers[0][field] = 9;
      expect(errorPaths(project)).toContain("triggers.0");
      expect(compileProject(project).bytes).toHaveLength(0);
    },
  );

  it("rejects a release mapping because a software trigger has no release edge", () => {
    const project = manualProject();
    project.states[0].transitions[1].edge = "release";
    expect(errorPaths(project)).toContain("states.0.transitions.1.edge");
    expect(compileProject(project).bytes).toHaveLength(0);
  });

  it("counts manual triggers against the eight-trigger controller limit", () => {
    const project = manualProject();
    while (project.triggers.length < 8)
      project.triggers.push(manual(`manual-${project.triggers.length}`));
    expect(errorPaths(project)).toEqual([]);
    project.triggers.push(manual("ninth"));
    expect(errorPaths(project)).toContain("triggers");
    expect(compileProject(project).bytes).toHaveLength(0);
  });
});

describe("software-only manual trigger preview", () => {
  it("never fires automatically, even with a dormant timer setting, and rejects physical input/release", () => {
    const simulator = new SceneSimulator(manualProject());
    expect(simulator.advance(60000).stateId).toBe("idle");
    expect(() => simulator.setTrigger("approach", true)).toThrow(
      "Manual triggers",
    );
    expect(() => simulator.setTrigger("approach", false)).toThrow(
      "Manual triggers",
    );
    expect(simulator.release("approach")).toBe(false);
    expect(simulator.snapshot().stateId).toBe("idle");
    expect(simulator.trigger("approach")).toBe(true);
    expect(simulator.snapshot().stateId).toBe("approach");
    simulator.stop();
    expect(simulator.trigger("approach")).toBe(false);
    simulator.reset();
    expect(simulator.advance(60000).stateId).toBe("idle");
  });

  it("uses separate manual audio advancement and physical beam child launches with no parent reset", () => {
    const simulator = new SceneSimulator(beamBench());
    expect(simulator.trigger("next")).toBe(true);
    const approach = simulator.advance(500);
    expect(approach.stateId).toBe("approach");
    expect(approach.audio[0].track).toBe(2);
    simulator.setTrigger("beam", true);
    const pulse = simulator.advance(50);
    expect(pulse.stateId).toBe("approach");
    expect(pulse.elapsedMs).toBe(550);
    expect(pulse.audio[0].positionMs).toBe(550);
    expect(pulse.outputs["output-5"]).toBe(true);
    expect(pulse.children[0].id).toBe("blast");
    expect(simulator.trigger("next")).toBe(true);
    const scare = simulator.snapshot();
    expect(scare.stateId).toBe("scare");
    expect(scare.audio[0].track).toBe(3);
    expect(scare.outputs["output-5"]).toBe(true);
    expect(simulator.advance(250).outputs["output-5"]).toBe(false);
    expect(simulator.trigger("beam")).toBe(false); // child is cooling down
    expect(simulator.snapshot().stateId).toBe("scare");
    expect(simulator.trigger("next")).toBe(true);
    const ambient = simulator.snapshot();
    expect(ambient.stateId).toBe("idle");
    expect(ambient.audio[0].track).toBe(1);
    expect(ambient.children[0].phase).toBe("cooldown");
    simulator.advance(2000);
    expect(simulator.trigger("beam")).toBe(true);
    expect(simulator.snapshot().stateId).toBe("idle");
    expect(simulator.snapshot().outputs["output-5"]).toBe(true);
  });
});
