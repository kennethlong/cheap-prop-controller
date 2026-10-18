import {
  applyStandardHarness,
  createDefaultProject,
  createState,
  createTrigger,
  type SceneProject,
} from "../../src/shared";

/** Compiler/firmware regression fixture. Never upload this to attached props. */
export function standardHarnessProject(
  variant: "full" | "sparse" | "inactive" = "full",
): SceneProject {
  const project = createDefaultProject();
  project.name = `Standard harness host fixture (${variant})`;
  project.outputs = project.outputs.slice(0, 6);
  project.outputs[1].activeLow = true;
  project.triggers = [
    { ...createTrigger("beam"), debounceMs: 0 },
    {
      ...createTrigger("pir"),
      kind: "pir",
      activeLow: false,
      pullup: false,
      debounceMs: 0,
    },
    {
      ...createTrigger("sonar"),
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
      debounceMs: 0,
    },
    {
      ...createTrigger("backup-pir"),
      kind: "pir",
      activeLow: false,
      pullup: false,
      debounceMs: 0,
    },
    {
      ...createTrigger("backup-sonar"),
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
      distanceMode: "zones",
      zones: [
        {
          id: "near",
          name: "Near",
          minCm: 30,
          maxCm: 100,
          hysteresisCm: 10,
          onEnter: [
            { id: "backup-approach", kind: "state", stateId: "approach" },
          ],
          onExit: [],
        },
      ],
    },
    { ...createTrigger("next"), kind: "manual" },
  ];
  project.audio = {
    ...project.audio,
    players: [{ id: "player-1", kind: "dfplayer", txPin: null, rxPin: null }],
    ambientTrack: 1,
    transitionMode: "cut",
    fadeMs: 0,
    tracks: [1, 2].map((number) => ({ number, name: `Track ${number}` })),
  };
  project.ir = { enabled: true, txPin: null, rxPin: null, commands: [] };
  project.states = [
    {
      ...createState("idle", "Idle"),
      loopTimeline: true,
      transitions: [
        { triggerId: "next", targetStateId: "approach" },
        { triggerId: "pir", targetStateId: "approach" },
        { triggerId: "backup-pir", targetStateId: "approach" },
        { triggerId: "beam", targetStateId: "child" },
      ],
    },
    {
      ...createState("approach", "Approach"),
      foregroundTrack: 2,
      events: [
        { id: "relay-1", outputId: "output-1", startMs: 0, endMs: 2000 },
        { id: "relay-2", outputId: "output-2", startMs: 0, endMs: 1000 },
        { id: "strobe", outputId: "output-6", startMs: 0, endMs: 1000 },
      ],
      transitions: [
        { triggerId: "next", targetStateId: "idle" },
        { triggerId: "sonar", targetStateId: "idle" },
        { triggerId: "beam", targetStateId: "child" },
      ],
    },
    {
      ...createState("child", "Air pulse"),
      kind: "child",
      durationMs: 250,
      cooldownMs: 500,
      events: [{ id: "pulse", outputId: "output-5", startMs: 0, endMs: 250 }],
    },
  ];
  const fixed = applyStandardHarness(project);
  if (variant !== "full") {
    fixed.outputs.find((output) => output.standardSlot === "relay-2")!.enabled =
      false;
    for (const trigger of fixed.triggers)
      if (trigger.standardSlot?.startsWith("backup-")) trigger.enabled = false;
  }
  if (variant === "inactive") {
    for (const output of fixed.outputs)
      if (output.standardSlot === "dc-ssr" || output.standardSlot === "ac-ssr")
        output.enabled = false;
    for (const trigger of fixed.triggers)
      if (trigger.kind !== "manual") trigger.enabled = false;
  }
  return fixed;
}
