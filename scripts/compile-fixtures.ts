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
const dense = createDefaultProject();
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
if (process.argv.includes("--examples")) {
  await mkdir("examples", { recursive: true });
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
