import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  compileProject,
  createDefaultProject,
  createState,
  createTrigger,
  estimateSceneBytes,
  parseProject,
  pinLabel,
  synchronizeAudioPlayers,
  validateProject,
  verifySceneChecksum,
  type BoardId,
  type SceneProject,
} from "../../src/shared";

const errors = (project: SceneProject) =>
  validateProject(project).filter((issue) => issue.severity === "error");
const paths = (project: SceneProject) =>
  errors(project).map((issue) => issue.path);
function audioProject(board: BoardId = "uno") {
  const project = createDefaultProject();
  project.board = board;
  project.audio.transitionMode = "fade-through";
  project.audio.ambientTrack = 1;
  project.audio.keepAmbient = true;
  project.audio.tracks = [1, 2, 3].map((number) => ({
    number,
    name: `Track ${number}`,
  }));
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  return synchronizeAudioPlayers(project);
}
function advanced(board: BoardId = "uno") {
  const project = audioProject(board);
  project.audio.players.forEach((player) => {
    player.feedback = { pin: null, activeLow: true };
  });
  Object.assign(project.triggers[2], {
    kind: "timer",
    timerIntervalMs: 30000,
    timerResetOnTrigger: true,
  });
  project.outputs[0].idleActive = true;
  project.states[1].events[0].active = false;
  project.states[0].transitions = [
    {
      triggerId: "approach",
      targetStateId: "approach",
      alternateStateIds: ["scare"],
    },
    { triggerId: "reset", targetStateId: "approach" },
  ];
  project.states[1].transitions.push({
    triggerId: "approach",
    edge: "release",
    targetStateId: "idle",
  });
  project.states[2].audioEndStateId = "idle";
  return allocatePins(project).project;
}

describe("scene controls image and compatibility", () => {
  it("preserves the exact old image when optional fields have their legacy defaults", () => {
    const project = createDefaultProject();
    for (const state of project.states) {
      state.audioEndStateId = null;
      state.events.forEach((event) => {
        event.active = true;
      });
      state.transitions.forEach((transition) => {
        transition.edge = "activate";
        transition.alternateStateIds = [];
      });
    }
    expect(Buffer.from(compileProject(project).bytes)).toEqual(
      readFileSync("tests/core/default-scene.bin"),
    );
  });

  it("packs timer, BUSY, OFF, release, variants, and audio-end fields without growing records", () => {
    const project = advanced();
    expect(errors(project)).toEqual([]);
    const { bytes, usedBytes } = compileProject(project);
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number) => view.getUint16(offset, true);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("CPC2");
    expect(verifySceneChecksum(bytes)).toBe(true);
    expect(usedBytes).toBe(estimateSceneBytes(project));
    expect(Array.from(bytes.slice(u16(22) + 16, u16(22) + 24))).toEqual([
      3, 255, 255, 1, 88, 2, 0, 0,
    ]);
    expect(bytes[u16(24) + 3]).toBe(
      project.audio.players[0].feedback!.pin! + 1,
    );
    expect(bytes[u16(26) + 16 + 10]).toBe(3); // two existing transitions plus release
    expect(bytes[u16(26) + 32 + 13]).toBe(1); // state 0 target + 1
    expect(bytes[u16(28) + 5]).toBe(1); // first chronological output event is OFF
    expect(Array.from(bytes.slice(u16(30), u16(30) + 6))).toEqual([
      0, 1, 0, 2, 2, 1,
    ]);
    expect(Array.from(bytes.slice(u16(30) + 10, u16(30) + 12))).toEqual([
      128, 0,
    ]);
    bytes[u16(28) + 5] ^= 1;
    expect(verifySceneChecksum(bytes)).toBe(false);
  });

  it("adds only two bytes per extra destination and no cost for optional flags", () => {
    const project = createDefaultProject();
    const before = estimateSceneBytes(project);
    project.states[1].events[0].active = false;
    project.states[0].transitions[1].edge = "release";
    expect(estimateSceneBytes(project)).toBe(before);
    project.states[0].transitions[1].alternateStateIds = ["scare", "idle"];
    expect(estimateSceneBytes(project)).toBe(before + 4);
    project.states[2].durationMs = 60000;
    expect(estimateSceneBytes(project)).toBe(before + 4);
  });

  it.each([false, true])(
    "retains zones and IR footer layout with CPC2 (IR=%s)",
    (ir) => {
      const project = createDefaultProject();
      project.states[1].events[0].active = false;
      Object.assign(project.triggers[0], {
        kind: "ultrasonic",
        activeLow: false,
        pullup: false,
        distanceMode: "zones",
        zones: [
          {
            id: "near",
            name: "Near",
            minCm: 2,
            maxCm: 100,
            hysteresisCm: 5,
            onEnter: [],
            onExit: [],
          },
        ],
      });
      if (ir)
        project.ir = { enabled: true, txPin: null, rxPin: null, commands: [] };
      const { bytes } = compileProject(allocatePins(project).project);
      expect(bytes[3]).toBe(0x32);
      expect(Array.from(bytes.slice(-8, -4))).toEqual([
        0x5a,
        0x4e,
        ir ? 2 : 1,
        1,
      ]);
      expect(verifySceneChecksum(bytes)).toBe(true);
    },
  );
});

describe("scene control GPIO budgeting", () => {
  it.each(["uno", "nano", "pro-mini", "mega"] as BoardId[])(
    "budgets two players and feedback correctly on %s",
    (board) => {
      const project = audioProject(board);
      const before = allocatePins(project);
      project.audio.players.forEach((player) => {
        player.feedback = { pin: null, activeLow: true };
      });
      const after = allocatePins(project);
      expect(errors(after.project)).toEqual([]);
      if (board === "nano" || board === "pro-mini") {
        expect(
          after.project.audio.players.map((player) => player.feedback!.pin),
        ).toEqual([20, 21]);
        expect(after.maxOutputs).toBe(before.maxOutputs);
        expect(pinLabel(board, 20)).toContain("A6");
        expect(pinLabel(board, 21)).toContain("A7");
      } else if (board === "uno")
        expect(after.maxOutputs).toBe(before.maxOutputs - 2);
      Object.assign(project.triggers[2], { kind: "timer" });
      const timer = allocatePins(project);
      expect(timer.project.triggers[2].pin).toBeNull();
      expect(timer.project.triggers[2].echoPin).toBeNull();
      if (board !== "mega") expect(timer.maxOutputs).toBe(after.maxOutputs + 1);
    },
  );

  it("supports active-high feedback and rejects serial pins, conflicts and input-only outputs", () => {
    const project = advanced("nano");
    project.audio.players[0].feedback!.activeLow = false;
    const compiled = compileProject(project).bytes;
    const playerOffset = new DataView(compiled.buffer).getUint16(24, true);
    expect(compiled[playerOffset + 3]).toBe(128 | 21);
    project.audio.players[0].feedback!.pin = 0;
    expect(paths(project)).toContain("audio.players.0.feedback.pin");
    project.audio.players[0].feedback!.pin = project.outputs[0].pin;
    expect(
      errors(project).some((issue) =>
        issue.message.includes("already assigned"),
      ),
    ).toBe(true);
    project.audio.players[0].feedback!.pin = null;
    expect(paths(project)).toContain("audio.players.0.feedback.pin");
    project.audio.players[0].feedback!.pin = 20;
    project.wiring = "custom";
    project.outputs[0].pin = 21;
    expect(paths(project)).toContain("outputs.0.pin");
  });
});

describe("scene control validation", () => {
  it.each([0, 49, 51, 3276751])("rejects invalid timer period %s", (period) => {
    const project = advanced();
    project.triggers[2].timerIntervalMs = period;
    expect(paths(project)).toContain("triggers.2.timerIntervalMs");
    expect(compileProject(project).bytes.length).toBe(0);
  });

  it("uses a 30s timer default and rejects GPIO or release on a timer", () => {
    const project = advanced();
    delete project.triggers[2].timerIntervalMs;
    expect(errors(project)).toEqual([]);
    project.triggers[2].pin = 19;
    expect(paths(project)).toContain("triggers.2");
    project.triggers[2].pin = null;
    project.states[0].transitions[1].edge = "release";
    expect(paths(project)).toContain("states.0.transitions.1.edge");
  });

  it("allows activation and release together but rejects duplicate groups and destinations", () => {
    const project = advanced();
    project.states[0].transitions.push({
      triggerId: "approach",
      edge: "release",
      targetStateId: "idle",
    });
    expect(errors(project)).toEqual([]);
    project.states[0].transitions.push({
      triggerId: "approach",
      targetStateId: "idle",
    });
    expect(paths(project)).toContain("states.0.transitions.3");
    project.states[0].transitions.pop();
    project.states[0].transitions[0].alternateStateIds = ["approach"];
    expect(paths(project)).toContain(
      "states.0.transitions.0.alternateStateIds",
    );
    project.states[0].transitions[0].alternateStateIds = ["missing"];
    expect(paths(project)).toContain(
      "states.0.transitions.0.alternateStateIds.0",
    );
  });

  it("bounds expanded transitions across all states", () => {
    const project = createDefaultProject();
    project.board = "mega";
    project.wiring = "custom";
    project.triggers = Array.from({ length: 8 }, (_, i) =>
      createTrigger(`t${i}`),
    );
    project.states = Array.from({ length: 8 }, (_, i) => createState(`s${i}`));
    project.initialStateId = "s0";
    for (const state of project.states)
      state.transitions = project.triggers.slice(0, 2).map((trigger) => ({
        triggerId: trigger.id,
        targetStateId: "s0",
        alternateStateIds: project.states.slice(1).map((item) => item.id),
      }));
    const allocated = allocatePins(project).project;
    expect(errors(allocated)).toEqual([]); // 8 * 2 * 8 = 128
    allocated.states[0].transitions.push({
      triggerId: "t2",
      targetStateId: "s0",
    });
    expect(paths(allocated)).toContain("transitions");
  });

  it("requires a nonlooping foreground and every player BUSY wire for audio completion", () => {
    const project = advanced();
    delete project.audio.players[1].feedback;
    expect(paths(project)).toContain("states.2.audioEndStateId");
    project.audio.players[1].feedback = { pin: 19, activeLow: true };
    project.states[2].loopAudio = true;
    expect(paths(project)).toContain("states.2.audioEndStateId");
    project.states[2].loopAudio = false;
    project.states[2].foregroundTrack = null;
    expect(paths(project)).toContain("states.2.audioEndStateId");
    project.states[0].audioEndStateId = "approach";
    expect(paths(project)).toContain("states.0.audioEndStateId");
  });

  it("rejects malformed optional controls at import rather than accepting truthy strings", () => {
    const project = advanced();
    const malformed = JSON.parse(JSON.stringify(project));
    malformed.states[1].events[0].active = "false";
    malformed.audio.players[0].feedback.activeLow = 1;
    malformed.triggers[2].timerResetOnTrigger = "yes";
    malformed.states[0].transitions[0].alternateStateIds = "scare";
    expect(() => parseProject(malformed)).toThrow("Expected true or false");
    expect(compileProject(malformed).bytes.length).toBe(0);
  });
});
