import type { SceneProject, SceneState, TriggerConfig } from "./model";
import { allocatePins } from "./boards";

export const OUTPUT_COLORS = [
  "#f87171",
  "#4ade80",
  "#60a5fa",
  "#facc15",
  "#c084fc",
  "#22d3ee",
  "#fb923c",
  "#f472b6",
];

export function createTrigger(id: string, name = "New trigger"): TriggerConfig {
  return {
    id,
    name,
    kind: "button",
    pin: null,
    echoPin: null,
    activeLow: true,
    pullup: true,
    debounceMs: 100,
    thresholdCm: 100,
    hysteresisCm: 20,
  };
}

export function createState(id: string, name = "New state"): SceneState {
  return {
    id,
    name,
    durationMs: 10000,
    loopTimeline: false,
    foregroundTrack: null,
    volume: 25,
    loopAudio: false,
    events: [],
    transitions: [],
  };
}

export function createDefaultProject(): SceneProject {
  const idle = createState("idle", "Idle");
  idle.loopTimeline = true;
  idle.transitions = [
    { triggerId: "reset", targetStateId: "idle" },
    { triggerId: "approach", targetStateId: "approach" },
  ];
  const approach = createState("approach", "Approach");
  approach.transitions = [
    { triggerId: "reset", targetStateId: "idle" },
    { triggerId: "scare", targetStateId: "scare" },
  ];
  approach.events = [
    { id: "approach-light", outputId: "output-1", startMs: 0, endMs: 5000 },
  ];
  const scare = createState("scare", "Scare");
  scare.durationMs = 30000;
  scare.transitions = [{ triggerId: "reset", targetStateId: "idle" }];
  scare.events = [
    { id: "scare-1", outputId: "output-1", startMs: 0, endMs: 3000 },
    { id: "scare-2", outputId: "output-2", startMs: 500, endMs: 1500 },
    { id: "scare-3", outputId: "output-3", startMs: 1000, endMs: 5000 },
    { id: "scare-4", outputId: "output-2", startMs: 2500, endMs: 3500 },
    { id: "scare-5", outputId: "output-4", startMs: 4000, endMs: 10000 },
    { id: "scare-6", outputId: "output-1", startMs: 12000, endMs: 16000 },
  ];
  return allocatePins({
    version: 1,
    name: "Midnight workshop",
    board: "uno",
    wiring: "relay-shield",
    initialStateId: "idle",
    outputs: Array.from({ length: 8 }, (_, index) => ({
      id: `output-${index + 1}`,
      name:
        ["Entrance light", "Air blast", "Creature", "Spotlight"][index] ??
        `Output ${index + 1}`,
      pin: null,
      activeLow: false,
      idleActive: false,
      color: OUTPUT_COLORS[index],
    })),
    triggers: [
      createTrigger("approach", "Approach"),
      createTrigger("scare", "Scare"),
      createTrigger("reset", "Reset"),
    ],
    audio: {
      players: [],
      ambientTrack: null,
      ambientVolume: 20,
      keepAmbient: false,
      ambientMixVolume: 0,
      fadeMs: 500,
      tracks: [],
    },
    states: [idle, approach, scare],
  }).project;
}
