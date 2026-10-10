import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  allocatePins,
  BOARD_PROFILES,
  compileProject,
  createDefaultProject,
  createSimulator,
  crc16,
  estimateSceneBytes,
  parseProject,
  requiredPlayerCount,
  synchronizeAudioPlayers,
  validateProject,
  verifySceneChecksum,
  type SceneProject,
} from "../../src/shared";

const errors = (project: SceneProject) =>
  validateProject(project).filter((issue) => issue.severity === "error");
function withAudio(keepAmbient = false): SceneProject {
  const project = createDefaultProject();
  project.audio.ambientTrack = 1;
  project.audio.keepAmbient = keepAmbient;
  project.audio.tracks = [1, 2, 3].map((number) => ({
    number,
    name: `Track ${number}`,
  }));
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  return synchronizeAudioPlayers(project);
}

describe("pin allocation and audio resource accounting", () => {
  it("reserves the shield mapping and allocates inputs before remaining outputs", () => {
    const project = createDefaultProject();
    expect(project.outputs.slice(0, 4).map((output) => output.pin)).toEqual([
      7, 6, 5, 4,
    ]);
    expect(project.triggers.map((trigger) => trigger.pin)).toEqual([2, 3, 8]);
    const allocated = allocatePins(project);
    expect(allocated.maxOutputs).toBe(15);
    expect(allocated.availableOutputPins.length).toBe(7);
    expect(errors(project)).toEqual([]);
  });

  it("accounts for two ultrasonic pins and two pins per player", () => {
    const project = withAudio();
    project.triggers[0] = {
      ...project.triggers[0],
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    };
    const allocated = allocatePins(project);
    expect(allocated.maxOutputs).toBe(10); // 18 GPIO minus 4 audio minus 4 sensor pins
    expect(allocated.project.triggers[0].echoPin).not.toBeNull();
    expect(errors(allocated.project)).toEqual([]);
  });

  it("uses all three Mega audio UARTs while preserving up to 32 output channels", () => {
    const project = withAudio(true);
    project.board = "mega";
    const allocated = allocatePins(project);
    expect(
      allocated.project.audio.players.map((player) => [
        player.txPin,
        player.rxPin,
      ]),
    ).toEqual([
      [18, 19],
      [16, 17],
      [14, 15],
    ]);
    expect(allocated.maxOutputs).toBe(32);
    expect(BOARD_PROFILES.mega.eepromBytes).toBe(4096);
    expect(errors(allocated.project)).toEqual([]);
  });

  it("leaves excess outputs unassigned rather than double booking pins", () => {
    const project = withAudio(true);
    project.outputs = Array.from({ length: 20 }, (_, index) => ({
      ...project.outputs[0],
      id: `out-${index}`,
      name: `Output ${index}`,
    }));
    const allocated = allocatePins(project);
    expect(allocated.maxOutputs).toBe(9);
    expect(
      allocated.project.outputs.filter((output) => output.pin === null),
    ).toHaveLength(11);
    expect(allocated.issues).toHaveLength(11);
    const pins = allocated.project.outputs
      .map((output) => output.pin)
      .filter((pin) => pin !== null);
    expect(new Set(pins).size).toBe(pins.length);
  });

  it("distinguishes stored files from simultaneous decoder requirements", () => {
    const project = withAudio();
    expect(requiredPlayerCount(project)).toBe(2);
    project.audio.keepAmbient = true;
    expect(requiredPlayerCount(project)).toBe(3);
    project.states[2].foregroundTrack = 2;
    expect(requiredPlayerCount(project)).toBe(2);
    project.audio.keepAmbient = false;
    project.audio.fadeMs = 0;
    expect(requiredPlayerCount(project)).toBe(1);
    project.audio.tracks.push({ number: 20, name: "Unused additional file" });
    expect(requiredPlayerCount(project)).toBe(1);
    project.states.forEach((state) => {
      state.foregroundTrack = null;
    });
    expect(requiredPlayerCount(project)).toBe(1);
    project.audio.ambientTrack = null;
    expect(requiredPlayerCount(project)).toBe(0);
  });
});

describe("safe project imports and deployment validation", () => {
  it("rejects incompatible or malformed data at the import boundary", () => {
    expect(() => parseProject('{"version":1}')).toThrow("Expected");
    expect(() =>
      parseProject({ ...createDefaultProject(), version: 2 }),
    ).toThrow("Unsupported project version");
    expect(() =>
      parseProject({ ...createDefaultProject(), states: [] }),
    ).toThrow("at least one state");
    const malformed = createDefaultProject() as unknown as Record<
      string,
      unknown
    >;
    malformed.audio = null;
    expect(() => parseProject(malformed)).toThrow("audio");
    expect(validateProject(null)[0].path).toBe("project");
  });

  it("permits typed semantic problems to be imported and repaired", () => {
    const project = createDefaultProject();
    project.outputs[0].pin = project.outputs[1].pin;
    expect(parseProject(JSON.stringify(project)).outputs[0].pin).toBe(6);
    expect(
      errors(project).some((issue) =>
        issue.message.includes("already assigned"),
      ),
    ).toBe(true);
    expect(compileProject(project).bytes).toHaveLength(0);
  });

  it("rejects UART collisions, analog-only Nano pins and altered shield assignments", () => {
    const project = createDefaultProject();
    project.board = "nano";
    project.outputs[0].pin = 20;
    project.outputs[1].pin = 0;
    const messages = errors(project)
      .map((issue) => issue.message)
      .join(" ");
    expect(messages).toContain("not a digital-capable GPIO");
    expect(messages).toContain("reserved for the host serial");
    expect(messages).toContain("must use D7");
  });

  it("checks references, event ordering, nonoverlap and exact tick alignment", () => {
    const project = createDefaultProject();
    const state = project.states[1];
    state.events.push({
      id: "bad",
      outputId: "output-1",
      startMs: 125,
      endMs: 5100,
    });
    state.transitions.push({ triggerId: "missing", targetStateId: "missing" });
    const messages = errors(project)
      .map((issue) => issue.message)
      .join(" ");
    expect(messages).toContain("50 ms tick");
    expect(messages).toContain("cannot overlap");
    expect(messages).toContain("Trigger does not exist");
    expect(messages).toContain("Target state does not exist");
  });

  it("blocks unsupported audio or ultrasonic configuration", () => {
    const project = withAudio(true);
    project.audio.players.pop();
    project.triggers[0].kind = "ultrasonic";
    project.triggers[0].thresholdCm = 390;
    project.triggers[0].hysteresisCm = 20;
    const messages = errors(project)
      .map((issue) => issue.message)
      .join(" ");
    expect(messages).toContain("require 3 MP3 players");
    expect(messages).toContain("HC-SR04");
    expect(messages).toContain("400 cm");
  });

  it("keeps capacity dependent on event complexity rather than scene duration", () => {
    const project = createDefaultProject();
    const before = estimateSceneBytes(project);
    project.states[2].durationMs = 300000;
    expect(estimateSceneBytes(project)).toBe(before);
    project.states[2].events = Array.from({ length: 150 }, (_, index) => ({
      id: `event-${index}`,
      outputId: "output-1",
      startMs: index * 100,
      endMs: index * 100 + 50,
    }));
    const compiled = compileProject(project);
    expect(compiled.usedBytes).toBeGreaterThan(1024);
    expect(compiled.bytes.length).toBe(0);
    expect(compiled.issues.some((issue) => issue.path === "capacity")).toBe(
      true,
    );
    expect(parseProject(project).states[2].events).toHaveLength(150);
    project.board = "mega";
    expect(
      compileProject(allocatePins(project).project).bytes.length,
    ).toBeGreaterThan(1024);
  });
});

describe("compact scene image interoperability", () => {
  it("retains the independently validated C++ golden fixtures", () => {
    const simple = readFileSync(
      new URL("./default-scene.bin", import.meta.url),
    );
    expect(compileProject(createDefaultProject()).bytes).toEqual(
      new Uint8Array(simple),
    );
    let project = withAudio(true);
    project.board = "mega";
    project.triggers[0] = {
      ...project.triggers[0],
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    };
    project = allocatePins(project).project;
    project.audio.players[1].kind = "yx5300";
    const rich = readFileSync(
      new URL("./mega-audio-scene.bin", import.meta.url),
    );
    expect(compileProject(project).bytes).toEqual(new Uint8Array(rich));
  });

  it("matches the standard CRC16-CCITT-FALSE check vector", () => {
    expect(crc16(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });

  it("encodes default records at documented packed offsets and detects corruption", () => {
    const compiled = compileProject(createDefaultProject());
    const bytes = compiled.bytes;
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number) => view.getUint16(offset, true);
    expect(compiled.issues).toEqual([]);
    expect(compiled.usedBytes).toBe(172);
    expect([...bytes.slice(0, 4)]).toEqual([67, 80, 67, 49]);
    expect(u16(4)).toBe(172);
    expect([...bytes.slice(8, 14)]).toEqual([1, 8, 3, 0, 3, 0]);
    expect([20, 22, 24, 26, 28, 30].map(u16)).toEqual([
      32, 48, 72, 72, 120, 162,
    ]);
    expect([...bytes.slice(32, 40)]).toEqual([7, 0, 6, 0, 5, 0, 4, 0]);
    expect([...bytes.slice(48, 56)]).toEqual([0, 2, 255, 3, 100, 0, 20, 2]);
    expect(u16(88)).toBe(200); // Approach duration: 10,000ms / 50
    expect([...bytes.slice(120, 126)]).toEqual([0, 0, 100, 0, 0, 0]);
    expect([...bytes.slice(162, 172)]).toEqual([2, 0, 0, 1, 2, 0, 1, 2, 2, 0]);
    expect(verifySceneChecksum(bytes)).toBe(true);
    bytes[125] ^= 1;
    expect(verifySceneChecksum(bytes)).toBe(false);
    expect(verifySceneChecksum(new Uint8Array())).toBe(false);
  });

  it("sorts binary events without mutating the editable project", () => {
    const project = createDefaultProject();
    project.states[2].events.reverse();
    const first = project.states[2].events[0].id;
    const actual = compileProject(project).bytes;
    const expected = compileProject(createDefaultProject()).bytes;
    expect(actual).toEqual(expected);
    expect(project.states[2].events[0].id).toBe(first);
  });
});

describe("state engine preview and event boundaries", () => {
  it("ignores unarmed state transitions and changes output timelines immediately", () => {
    const simulator = createSimulator(createDefaultProject());
    expect(simulator.trigger("scare")).toBe(false);
    expect(simulator.trigger("approach")).toBe(true);
    expect(simulator.snapshot().outputs["output-1"]).toBe(true);
    simulator.advance(4950);
    expect(simulator.snapshot().outputs["output-1"]).toBe(true);
    simulator.advance(50);
    expect(simulator.snapshot().outputs["output-1"]).toBe(false);
    simulator.trigger("scare");
    simulator.advance(500);
    expect(simulator.snapshot().outputs["output-2"]).toBe(true);
    simulator.trigger("reset");
    expect(simulator.snapshot().stateId).toBe("idle");
    expect(
      Object.values(simulator.snapshot().outputs).every((active) => !active),
    ).toBe(true);
  });

  it("converts active-low levels, deactivates on STOP and restores configured idle on RESET", () => {
    const project = createDefaultProject();
    project.outputs[0].activeLow = true;
    project.outputs[1].idleActive = true;
    const simulator = createSimulator(project);
    expect(simulator.snapshot().physicalOutputs["output-1"]).toBe(true);
    simulator.trigger("approach");
    expect(simulator.snapshot().physicalOutputs["output-1"]).toBe(false);
    const stopped = simulator.stop();
    expect(stopped.running).toBe(false);
    expect(stopped.physicalOutputs["output-1"]).toBe(true);
    expect(stopped.outputs["output-2"]).toBe(false);
    expect(simulator.trigger("scare")).toBe(false);
    simulator.advance(1000);
    expect(simulator.snapshot().totalElapsedMs).toBe(0);
    expect(simulator.reset().outputs["output-2"]).toBe(true);
  });

  it("loops exact boundaries and preserves pause time through omitted advances", () => {
    const project = createDefaultProject();
    project.states[1].durationMs = 5000;
    project.states[1].loopTimeline = true;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    simulator.advance(4999);
    expect(simulator.snapshot().elapsedMs).toBe(4950);
    simulator.advance(1);
    expect(simulator.snapshot().elapsedMs).toBe(0);
    expect(simulator.snapshot().outputs["output-1"]).toBe(true);
  });

  it("debounces inputs, requires release and prioritizes ordered simultaneous edges", () => {
    const simulator = createSimulator(createDefaultProject());
    simulator.setTrigger("approach", true);
    simulator.advance(50);
    expect(simulator.snapshot().stateId).toBe("idle");
    simulator.advance(50);
    expect(simulator.snapshot().stateId).toBe("approach");
    simulator.reset();
    simulator.advance(200);
    expect(simulator.snapshot().stateId).toBe("idle"); // held trigger cannot retrigger
    simulator.setTrigger("approach", false);
    simulator.advance(100);
    simulator.setTrigger("approach", true);
    simulator.setTrigger("reset", true);
    simulator.advance(100);
    expect(simulator.snapshot().stateId).toBe("idle"); // reset is first transition
  });

  it("uses ultrasonic hysteresis without bouncing between nearby distances", () => {
    let project = createDefaultProject();
    project.triggers[0] = {
      ...project.triggers[0],
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    };
    project = allocatePins(project).project;
    const simulator = createSimulator(project);
    simulator.setDistance("approach", 90);
    simulator.advance(100);
    expect(simulator.snapshot().stateId).toBe("approach");
    simulator.reset();
    simulator.setDistance("approach", 110);
    simulator.advance(100);
    expect(simulator.snapshot().stateId).toBe("idle");
    simulator.setDistance("approach", 125);
    simulator.advance(100);
    simulator.setDistance("approach", 90);
    simulator.advance(100);
    expect(simulator.snapshot().stateId).toBe("approach");
  });

  it("crossfades two voices and retains muted ambient position with three players", () => {
    const simulator = createSimulator(withAudio(true));
    simulator.advance(1000);
    simulator.trigger("approach");
    simulator.advance(250);
    let voices = simulator.snapshot().audio;
    expect(voices.find((voice) => voice.track === 1)?.volume).toBe(10);
    expect(voices.find((voice) => voice.track === 2)?.volume).toBe(12.5);
    simulator.advance(250);
    simulator.trigger("scare");
    expect(simulator.snapshot().audio).toHaveLength(3);
    simulator.advance(500);
    voices = simulator.snapshot().audio;
    expect(voices.find((voice) => voice.track === 1)?.volume).toBe(0);
    expect(voices.find((voice) => voice.track === 1)?.positionMs).toBe(2000);
    expect(voices.find((voice) => voice.track === 2)).toBeUndefined();
    simulator.trigger("reset");
    simulator.advance(500);
    expect(simulator.snapshot().audio).toEqual([
      {
        role: "ambient",
        track: 1,
        volume: 20,
        playerIndex: 0,
        positionMs: 2500,
        loop: true,
      },
    ]);
  });

  it("preserves persistent ambient with hard cuts and only two players", () => {
    const project = withAudio(true);
    project.audio.fadeMs = 0;
    const simulator = createSimulator(synchronizeAudioPlayers(project));
    simulator.advance(1000);
    simulator.trigger("approach");
    simulator.advance(1000);
    simulator.trigger("reset");
    expect(simulator.snapshot().audio[0].positionMs).toBe(2000);
    expect(simulator.snapshot().audio[0].volume).toBe(20);
  });
});
