import { mkdir, writeFile } from "node:fs/promises";
import {
  createDefaultProject,
  compileProject,
  allocatePins,
  synchronizeAudioPlayers,
} from "../src/shared/index";
import type { BoardId } from "../src/shared/model";
await mkdir("artifacts/scenes", { recursive: true });
for (const board of ["uno", "nano", "mega", "pro-mini"] as BoardId[]) {
  const project = allocatePins({ ...createDefaultProject(), board }).project;
  const compiled = compileProject(project);
  if (!compiled.bytes.length) throw new Error(JSON.stringify(compiled.issues));
  await writeFile(`artifacts/scenes/${board}.bin`, compiled.bytes);
  await writeFile(
    `artifacts/scenes/${board}.json`,
    JSON.stringify(project, null, 2),
  );
  console.log(
    `${board}: ${compiled.usedBytes}/${compiled.capacityBytes} bytes`,
  );
}
const audioProject = createDefaultProject();
audioProject.audio.tracks = [
  { number: 1, name: "Bench ambient" },
  { number: 2, name: "Bench approach" },
  { number: 3, name: "Bench scare" },
];
audioProject.audio.ambientTrack = 1;
audioProject.audio.keepAmbient = true;
audioProject.states[1].foregroundTrack = 2;
audioProject.states[2].foregroundTrack = 3;
const compiledAudio = compileProject(synchronizeAudioPlayers(audioProject));
if (!compiledAudio.bytes.length)
  throw new Error(JSON.stringify(compiledAudio.issues));
await writeFile("artifacts/scenes/uno-audio.bin", compiledAudio.bytes);
const singlePlayer = structuredClone(audioProject);
singlePlayer.audio.keepAmbient = false;
singlePlayer.audio.transitionMode = "fade-through";
singlePlayer.audio.fadeOutMs = 150;
singlePlayer.audio.fadeInMs = 350;
const fadeProject = synchronizeAudioPlayers(singlePlayer);
const compiledFade = compileProject(fadeProject);
if (!compiledFade.bytes.length)
  throw new Error(JSON.stringify(compiledFade.issues));
await writeFile("artifacts/scenes/uno-fade-through.bin", compiledFade.bytes);
const ambientMix = structuredClone(fadeProject);
ambientMix.audio.keepAmbient = true;
ambientMix.audio.ambientMixVolume = 8;
const compiledMix = compileProject(synchronizeAudioPlayers(ambientMix));
if (!compiledMix.bytes.length)
  throw new Error(JSON.stringify(compiledMix.issues));
await writeFile("artifacts/scenes/uno-ambient-mix.bin", compiledMix.bytes);
const zonesProject = structuredClone(ambientMix);
zonesProject.name = "Ultrasonic approach zones";
zonesProject.triggers[0] = {
  ...zonesProject.triggers[0],
  name: "Visitor distance",
  kind: "ultrasonic",
  activeLow: false,
  pullup: false,
  distanceMode: "zones",
  debounceMs: 150,
  zones: [
    {
      id: "far",
      name: "Far",
      minCm: 201,
      maxCm: 400,
      hysteresisCm: 10,
      onEnter: [{ id: "far-idle", kind: "state", stateId: "idle" }],
      onExit: [],
    },
    {
      id: "approaching",
      name: "Approaching",
      minCm: 101,
      maxCm: 200,
      hysteresisCm: 10,
      onEnter: [
        { id: "approach-state", kind: "state", stateId: "approach" },
        {
          id: "approach-volume",
          kind: "volume",
          target: "foreground",
          volume: 12,
          fadeMs: 300,
        },
      ],
      onExit: [],
    },
    {
      id: "close",
      name: "Close",
      minCm: 41,
      maxCm: 100,
      hysteresisCm: 5,
      onEnter: [
        {
          id: "close-volume",
          kind: "volume",
          target: "foreground",
          volume: 24,
          fadeMs: 250,
        },
      ],
      onExit: [
        {
          id: "leave-close-volume",
          kind: "volume",
          target: "foreground",
          volume: 12,
          fadeMs: 250,
        },
      ],
    },
    {
      id: "very-close",
      name: "Very close",
      minCm: 2,
      maxCm: 40,
      hysteresisCm: 5,
      onEnter: [
        { id: "scare-state", kind: "state", stateId: "scare" },
        {
          id: "scare-volume",
          kind: "volume",
          target: "foreground",
          volume: 30,
          fadeMs: 150,
        },
      ],
      onExit: [],
    },
  ],
};
for (const state of zonesProject.states)
  state.transitions = state.transitions.filter(
    (transition) => transition.triggerId !== zonesProject.triggers[0].id,
  );
const allocatedZones = synchronizeAudioPlayers(zonesProject);
const compiledZones = compileProject(allocatedZones);
if (!compiledZones.bytes.length)
  throw new Error(JSON.stringify(compiledZones.issues));
await writeFile("artifacts/scenes/uno-zones.bin", compiledZones.bytes);
if (process.argv.includes("--golden"))
  await writeFile("tests/core/zones-scene.bin", compiledZones.bytes);
if (process.argv.includes("--golden"))
  await writeFile("tests/core/ambient-mix-scene.bin", compiledMix.bytes);
if (process.argv.includes("--golden"))
  await writeFile(
    "tests/core/single-player-fade-scene.bin",
    compiledFade.bytes,
  );
const dense = createDefaultProject();
const irTraining = createDefaultProject();
irTraining.name = "IR learning starter";
irTraining.ir = { enabled: true, txPin: null, rxPin: null, commands: [] };
const allocatedIrTraining = allocatePins(irTraining).project;
const compiledIrEmpty = compileProject(allocatedIrTraining);
if (!compiledIrEmpty.bytes.length)
  throw new Error(JSON.stringify(compiledIrEmpty.issues));
await writeFile("artifacts/scenes/uno-ir-empty.bin", compiledIrEmpty.bytes);
const irTest = structuredClone(allocatedIrTraining);
irTest.name = "Synthetic IR protocol fixture (not learned prop commands)";
irTest.ir!.commands = [
  {
    id: "test-nec",
    name: "Synthetic NEC test",
    signal: { kind: "nec", code: 0xef10df20 },
    sendCount: 1,
    gapMs: 100,
  },
  {
    id: "test-raw",
    name: "Synthetic raw test",
    signal: { kind: "raw", pulsesUs: [1000, 500, 1000, 500, 550] },
    sendCount: 2,
    gapMs: 150,
  },
];
irTest.states[0].irEvents = [{ id: "startup", atMs: 0, commandId: "test-nec" }];
irTest.states[1].irEvents = [
  { id: "timed", atMs: 1000, commandId: "test-raw" },
];
Object.assign(irTest.triggers[0], {
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
      onEnter: [{ id: "send", kind: "ir", commandId: "test-nec" }],
      onExit: [],
    },
  ],
});
const compiledIr = compileProject(allocatePins(irTest).project);
if (!compiledIr.bytes.length)
  throw new Error(JSON.stringify(compiledIr.issues));
await writeFile("artifacts/scenes/uno-ir.bin", compiledIr.bytes);
if (process.argv.includes("--golden")) {
  await writeFile("tests/core/ir-scene.bin", compiledIr.bytes);
  await writeFile("tests/core/ir-empty-scene.bin", compiledIrEmpty.bytes);
}
dense.states[2].events = Array.from({ length: 110 }, (_, index) => ({
  id: `dense-${index}`,
  outputId: "output-1",
  startMs: index * 250,
  endMs: index * 250 + 100,
}));
const denseImage = compileProject(dense);
if (!denseImage.bytes.length)
  throw new Error(JSON.stringify(denseImage.issues));
await writeFile("artifacts/scenes/uno-dense.bin", denseImage.bytes);
const controls = synchronizeAudioPlayers(structuredClone(ambientMix));
controls.name = "Scene controls with two MP3 players";
controls.audio.players.forEach((player) => {
  player.feedback = { pin: null, activeLow: true };
});
controls.audio.players[1].kind = "yx5300";
Object.assign(controls.triggers[2], {
  kind: "timer",
  name: "Automatic scene",
  timerIntervalMs: 30000,
  timerResetOnTrigger: true,
});
controls.outputs[0].idleActive = true;
controls.states[1].events[0].active = false;
controls.states[0].transitions = [
  {
    triggerId: "approach",
    targetStateId: "approach",
    alternateStateIds: ["scare"],
  },
  {
    triggerId: "reset",
    targetStateId: "approach",
    alternateStateIds: ["scare"],
  },
];
controls.states[1].transitions = [
  { triggerId: "scare", targetStateId: "scare" },
  { triggerId: "approach", edge: "release", targetStateId: "idle" },
];
controls.states[2].transitions = [
  { triggerId: "scare", edge: "release", targetStateId: "idle" },
];
controls.states[2].audioEndStateId = "idle";
const allocatedControls = allocatePins(controls).project;
for (const board of ["uno", "nano", "mega", "pro-mini"] as BoardId[]) {
  const project = allocatePins({ ...controls, board }).project;
  const compiled = compileProject(project);
  if (!compiled.bytes.length) throw new Error(JSON.stringify(compiled.issues));
  await writeFile(`artifacts/scenes/${board}-controls.bin`, compiled.bytes);
  if (process.argv.includes("--golden"))
    await writeFile(`tests/core/${board}-controls-scene.bin`, compiled.bytes);
}
if (process.argv.includes("--examples")) {
  await mkdir("examples", { recursive: true });
  await writeFile(
    "examples/scene-controls-uno.cpc.json",
    JSON.stringify(allocatedControls, null, 2) + "\n",
  );
  await writeFile(
    "examples/ir-learning-starter.cpc.json",
    JSON.stringify(allocatedIrTraining, null, 2) + "\n",
  );
  await writeFile(
    "examples/ultrasonic-zones-uno.cpc.json",
    JSON.stringify(allocatedZones, null, 2) + "\n",
  );
  fadeProject.name = "Single-player fade transitions";
  await writeFile(
    "examples/single-player-fades-uno.cpc.json",
    JSON.stringify(fadeProject, null, 2) + "\n",
  );
  await writeFile(
    "examples/three-state-starter.cpc.json",
    JSON.stringify(createDefaultProject(), null, 2) + "\n",
  );
  audioProject.board = "mega";
  audioProject.name = "Ambient crossfades with three players";
  audioProject.audio.tracks = [
    { number: 1, name: "Ambient MP3" },
    { number: 2, name: "Approach MP3" },
    { number: 3, name: "Scare MP3" },
  ];
  audioProject.triggers[0] = {
    ...audioProject.triggers[0],
    kind: "pir",
    activeLow: false,
    pullup: false,
  };
  audioProject.triggers[1] = {
    ...audioProject.triggers[1],
    kind: "ultrasonic",
    activeLow: false,
    pullup: false,
    thresholdCm: 80,
  };
  const example = synchronizeAudioPlayers(audioProject);
  example.audio.players[1].kind = "yx5300";
  if (!compileProject(example).bytes.length)
    throw new Error("Example project failed validation");
  await writeFile(
    "examples/ambient-crossfades-mega.cpc.json",
    JSON.stringify(example, null, 2) + "\n",
  );
}
