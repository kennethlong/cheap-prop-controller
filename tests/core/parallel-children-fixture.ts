import {
  createDefaultProject,
  createState,
  createTrigger,
  type SceneProject,
} from "../../src/shared";

/** Deterministic host/firmware fixture; never upload it to attached props. */
export function parallelChildrenProject(): SceneProject {
  const project = createDefaultProject();
  project.name = "Parallel children protocol fixture";
  project.wiring = "custom";
  project.outputs = [0, 4, 5].map((index, position) => ({
    ...project.outputs[index],
    pin: [7, 9, 10][position],
  }));
  project.triggers = ["start", "beam", "second", "next"].map((id, index) => ({
    ...createTrigger(id, id),
    pin: [4, 8, 11, 12][index],
    debounceMs: 0,
  }));
  project.audio = {
    ...project.audio,
    players: [{ id: "player-1", kind: "dfplayer", txPin: 2, rxPin: 3 }],
    ambientTrack: 1,
    transitionMode: "cut",
    fadeMs: 0,
    tracks: [1, 2, 3].map((number) => ({ number, name: `Track ${number}` })),
  };
  project.states = [
    {
      ...createState("idle", "Idle"),
      transitions: [{ triggerId: "start", targetStateId: "approach" }],
    },
    {
      ...createState("approach", "Approach"),
      foregroundTrack: 2,
      durationMs: 3000,
      loopTimeline: true,
      events: [
        { id: "parent", outputId: "output-1", startMs: 100, endMs: 1500 },
      ],
      transitions: [
        { triggerId: "beam", targetStateId: "child-a" },
        { triggerId: "second", targetStateId: "child-b" },
        { triggerId: "next", targetStateId: "outro" },
      ],
    },
    {
      ...createState("outro", "Outro"),
      foregroundTrack: 3,
      events: [
        { id: "outro", outputId: "output-1", startMs: 500, endMs: 1000 },
      ],
      transitions: [{ triggerId: "beam", targetStateId: "child-a" }],
    },
    {
      ...createState("child-a", "Air pulse"),
      kind: "child",
      durationMs: 250,
      cooldownMs: 2000,
      events: [{ id: "pulse", outputId: "output-5", startMs: 0, endMs: 250 }],
    },
    {
      ...createState("child-b", "Second child"),
      kind: "child",
      durationMs: 500,
      cooldownMs: 500,
      events: [
        { id: "second-pulse", outputId: "output-6", startMs: 100, endMs: 400 },
      ],
    },
  ];
  return project;
}
