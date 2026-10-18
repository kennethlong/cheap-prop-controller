import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  childOutputOwners,
  compileProject,
  createDefaultProject,
  createState,
  estimateSceneBytes,
  isChildState,
  LIMITS,
  parseProject,
  usesParallelChildren,
  usesSceneControls,
  validateProject,
  verifySceneChecksum,
  type SceneProject,
} from "../../src/shared";
import { parallelChildrenProject } from "./parallel-children-fixture";

const errorPaths = (project: unknown) =>
  validateProject(project)
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.path);

describe("parallel child scene format", () => {
  it("packs independent timelines and cooldowns in CPC3 without growing records", () => {
    const project = parallelChildrenProject();
    const compiled = compileProject(project);
    const { bytes } = compiled;
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number) => view.getUint16(offset, true);
    expect(errorPaths(project)).toEqual([]);
    expect(usesParallelChildren(project)).toBe(true);
    expect(usesSceneControls(project)).toBe(true);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("CPC3");
    expect(compiled.usedBytes).toBe(188);
    expect(compiled.usedBytes).toBe(estimateSceneBytes(project));
    expect(verifySceneChecksum(bytes)).toBe(true);
    const child = u16(26) + 3 * 16;
    expect(u16(child)).toBe(5); // 250 ms
    expect(u16(child + 2)).toBe(0); // no track
    expect(bytes[child + 10]).toBe(0); // no transitions
    expect(bytes[child + 12]).toBe(4);
    expect(bytes[child + 13]).toBe(0);
    expect(u16(child + 14)).toBe(40); // 2,000 ms after completion
    expect(Buffer.from(bytes)).toEqual(
      readFileSync("tests/core/parallel-children-scene.bin"),
    );
    bytes[child + 14] ^= 1;
    expect(verifySceneChecksum(bytes)).toBe(false);
  });

  it("preserves CPC1 and CPC2 bytes when main states explicitly carry defaults", () => {
    for (const controls of [false, true]) {
      const project = createDefaultProject();
      if (controls) project.states[1].events[0].active = false;
      const before = compileProject(project).bytes;
      for (const state of project.states) {
        state.kind = "main";
        state.cooldownMs = 0;
      }
      expect(usesParallelChildren(project)).toBe(false);
      expect(compileProject(project).bytes).toEqual(before);
      expect(before[3]).toBe(controls ? 0x32 : 0x31);
      expect(verifySceneChecksum(before)).toBe(true);
      if (!controls)
        expect(Buffer.from(before)).toEqual(
          readFileSync("tests/core/default-scene.bin"),
        );
    }
  });

  it("allows zero/default and maximum cooldown and counts children in the eight state slots", () => {
    const project = parallelChildrenProject();
    delete project.states[3].cooldownMs;
    project.states[4].cooldownMs = LIMITS.maxDurationMs;
    expect(errorPaths(project)).toEqual([]);
    const bytes = compileProject(project).bytes;
    const view = new DataView(bytes.buffer);
    const offset = view.getUint16(26, true);
    expect(view.getUint16(offset + 3 * 16 + 14, true)).toBe(0);
    expect(view.getUint16(offset + 4 * 16 + 14, true)).toBe(65535);
    for (let index = 5; index < 8; index++)
      project.states.push(createState(`main-${index}`));
    expect(errorPaths(project)).toEqual([]);
    project.states.push(createState("ninth"));
    expect(errorPaths(project)).toContain("states");
  });

  it("exports ownership including every event lane and rejects parent/other-child conflicts", () => {
    const project = parallelChildrenProject();
    const owners = childOutputOwners(project);
    expect([...owners.keys()]).toEqual(["output-5", "output-6"]);
    expect(owners.get("output-5")).toBe(project.states[3]);
    expect(isChildState(project.states[0])).toBe(false);
    project.states[1].events.push({
      id: "conflict",
      outputId: "output-5",
      startMs: 0,
      endMs: 100,
    });
    project.states[4].events[0].outputId = "output-5";
    project.outputs[1].idleActive = true;
    expect(errorPaths(project)).toEqual(
      expect.arrayContaining([
        "states.1.events.1.outputId",
        "states.4.events.0.outputId",
        "outputs.1.idleActive",
      ]),
    );
    expect(compileProject(project).bytes).toHaveLength(0);
  });

  it.each([
    ["kind", "background"],
    ["kind", null],
    ["cooldownMs", "2000"],
    ["cooldownMs", null],
    ["cooldownMs", NaN],
    ["cooldownMs", Infinity],
  ])("rejects malformed child %s=%s on import", (key, value) => {
    const project = parallelChildrenProject();
    Object.assign(project.states[3], { [key]: value });
    expect(errorPaths(project)).toContain(`states.3.${key}`);
    expect(() => parseProject(project)).toThrow();
    expect(compileProject(project).bytes).toHaveLength(0);
  });

  it.each([-50, 1, 249, LIMITS.maxDurationMs + 50])(
    "rejects invalid cooldown %s",
    (cooldownMs) => {
      const project = parallelChildrenProject();
      project.states[3].cooldownMs = cooldownMs;
      expect(errorPaths(project)).toContain("states.3.cooldownMs");
    },
  );

  it.each([
    [
      "initialStateId",
      (p: SceneProject) => {
        p.initialStateId = "child-a";
      },
    ],
    [
      "states.3.events",
      (p: SceneProject) => {
        p.states[3].events = [];
      },
    ],
    [
      "states.3.loopTimeline",
      (p: SceneProject) => {
        p.states[3].loopTimeline = true;
      },
    ],
    [
      "states.3.foregroundTrack",
      (p: SceneProject) => {
        p.states[3].foregroundTrack = 2;
      },
    ],
    [
      "states.3.loopAudio",
      (p: SceneProject) => {
        p.states[3].loopAudio = true;
      },
    ],
    [
      "states.3.irEvents",
      (p: SceneProject) => {
        p.states[3].irEvents = [{ id: "ir", commandId: "unknown", atMs: 0 }];
      },
    ],
    [
      "states.3.transitions",
      (p: SceneProject) => {
        p.states[3].transitions = [
          { triggerId: "beam", targetStateId: "child-b" },
        ];
      },
    ],
    [
      "states.3.audioEndStateId",
      (p: SceneProject) => {
        p.states[3].audioEndStateId = "idle";
      },
    ],
    [
      "states.1.audioEndStateId",
      (p: SceneProject) => {
        p.states[1].audioEndStateId = "child-a";
      },
    ],
    [
      "states.1.cooldownMs",
      (p: SceneProject) => {
        p.states[1].cooldownMs = 50;
      },
    ],
  ] as const)("rejects unsupported child behavior at %s", (path, edit) => {
    const project = parallelChildrenProject();
    edit(project);
    expect(errorPaths(project)).toContain(path);
    expect(compileProject(project).bytes).toHaveLength(0);
  });

  it.each(["child-b", "outro"])(
    "rejects child round-robin with %s",
    (alternate) => {
      const project = parallelChildrenProject();
      project.states[1].transitions[0].alternateStateIds = [alternate];
      expect(errorPaths(project)).toContain(
        "states.1.transitions.0.alternateStateIds",
      );
      project.states[1].transitions[0].targetStateId = "outro";
      project.states[1].transitions[0].alternateStateIds = ["child-a"];
      expect(errorPaths(project)).toContain(
        "states.1.transitions.0.alternateStateIds",
      );
    },
  );

  it("rejects zone state-actions to a child and keeps ordinary threshold child launches valid", () => {
    let project = parallelChildrenProject();
    Object.assign(project.triggers[1], {
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
          hysteresisCm: 10,
          onEnter: [{ id: "launch", kind: "state", stateId: "child-a" }],
          onExit: [],
        },
      ],
    });
    project = allocatePins(project).project;
    expect(errorPaths(project)).toContain(
      "triggers.1.zones.0.onEnter.0.stateId",
    );
    project.triggers[1].distanceMode = "threshold";
    expect(errorPaths(project)).toEqual([]);
  });
});
