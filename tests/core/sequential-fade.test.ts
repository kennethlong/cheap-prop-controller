import { describe, expect, it } from "vitest";
import {
  allocatePins,
  createDefaultProject,
  createSimulator,
  requiredPlayerCount,
  synchronizeAudioPlayers,
  type SceneProject,
  type SimulatorSnapshot,
} from "../../src/shared";

function projectWithFades(
  fadeOutMs = 200,
  fadeInMs = 400,
  keepAmbient = false,
): SceneProject {
  const project = createDefaultProject();
  project.audio = {
    ...project.audio,
    transitionMode: "fade-through",
    fadeOutMs,
    fadeInMs,
    keepAmbient,
    ambientTrack: 1,
    tracks: [1, 2, 3].map((number) => ({ number, name: `Track ${number}` })),
  };
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  return synchronizeAudioPlayers(project);
}

const voice = (snapshot: SimulatorSnapshot, track: number) =>
  snapshot.audio.find((candidate) => candidate.track === track);

describe("sequential fade-through preview", () => {
  it("reserves one player normally or two with persistent ambient", () => {
    const single = projectWithFades();
    const persistent = projectWithFades(200, 400, true);
    expect(requiredPlayerCount(single)).toBe(1);
    expect(single.audio.players).toHaveLength(1);
    expect(allocatePins(single).maxOutputs).toBe(13);
    expect(requiredPlayerCount(persistent)).toBe(2);
    expect(persistent.audio.players).toHaveLength(2);
    expect(allocatePins(persistent).maxOutputs).toBe(11);
  });

  it("fades out before replacing the track while output events start immediately", () => {
    const simulator = createSimulator(projectWithFades());
    simulator.trigger("approach");
    expect(simulator.snapshot().outputs["output-1"]).toBe(true);
    expect(simulator.snapshot().audio.map((item) => item.track)).toEqual([1]);
    expect(voice(simulator.advance(100), 1)?.volume).toBe(10);
    const switched = simulator.advance(100);
    expect(switched.stateId).toBe("approach");
    expect(switched.elapsedMs).toBe(200);
    expect(switched.audio).toEqual([
      {
        role: "foreground",
        track: 2,
        volume: 0,
        playerIndex: 0,
        positionMs: 0,
        loop: false,
      },
    ]);
    expect(voice(simulator.advance(200), 2)?.volume).toBe(12.5);
    expect(voice(simulator.advance(200), 2)?.volume).toBe(25);
  });

  it("uses independent default durations when an older project omits them", () => {
    const project = projectWithFades();
    delete project.audio.fadeOutMs;
    delete project.audio.fadeInMs;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(voice(simulator.advance(200), 1)?.volume).toBeCloseTo(4);
    expect(voice(simulator.advance(50), 2)?.volume).toBe(0);
    expect(voice(simulator.advance(100), 2)?.volume).toBe(10);
    expect(voice(simulator.advance(150), 2)?.volume).toBe(25);
  });

  it("can switch immediately and fade in when outgoing time is zero", () => {
    const simulator = createSimulator(projectWithFades(0, 200));
    simulator.trigger("approach");
    expect(simulator.snapshot().audio.map((item) => item.track)).toEqual([2]);
    expect(voice(simulator.snapshot(), 2)?.volume).toBe(0);
    expect(voice(simulator.advance(100), 2)?.volume).toBe(12.5);
    expect(voice(simulator.advance(100), 2)?.volume).toBe(25);
  });

  it("can fade out then start at full volume when incoming time is zero", () => {
    const simulator = createSimulator(projectWithFades(200, 0));
    simulator.trigger("approach");
    expect(voice(simulator.advance(100), 1)?.volume).toBe(10);
    expect(voice(simulator.advance(100), 2)?.volume).toBe(25);
  });

  it("acts as an immediate cut when both durations are zero", () => {
    const simulator = createSimulator(projectWithFades(0, 0));
    simulator.trigger("approach");
    expect(simulator.snapshot().audio).toHaveLength(1);
    expect(voice(simulator.snapshot(), 2)?.volume).toBe(25);
    simulator.trigger("scare");
    expect(voice(simulator.snapshot(), 3)?.volume).toBe(25);
  });

  it("skips the outgoing wait when starting from silence and can fade to silence", () => {
    const project = projectWithFades(600, 200);
    project.audio.ambientTrack = null;
    project.states[2].foregroundTrack = null;
    const simulator = createSimulator(synchronizeAudioPlayers(project));
    expect(simulator.snapshot().audio).toEqual([]);
    simulator.trigger("approach");
    expect(voice(simulator.snapshot(), 2)?.volume).toBe(0);
    expect(voice(simulator.advance(100), 2)?.volume).toBe(12.5);
    simulator.advance(100);
    simulator.trigger("scare");
    expect(voice(simulator.advance(300), 2)?.volume).toBe(12.5);
    expect(simulator.advance(300).audio).toEqual([]);
  });

  it("uses the latest trigger target without restarting an outgoing fade", () => {
    const simulator = createSimulator(projectWithFades());
    simulator.trigger("approach");
    simulator.advance(100);
    simulator.trigger("scare");
    expect(simulator.snapshot().stateId).toBe("scare");
    expect(voice(simulator.advance(50), 1)?.volume).toBe(5);
    const switched = simulator.advance(50);
    expect(switched.audio.map((item) => item.track)).toEqual([3]);
    expect(voice(switched, 3)?.volume).toBe(0);
    expect(voice(simulator.advance(400), 3)?.volume).toBe(25);
    expect(voice(simulator.snapshot(), 2)).toBeUndefined();
  });

  it("interrupts an incoming fade from its current volume", () => {
    const simulator = createSimulator(projectWithFades());
    simulator.trigger("approach");
    expect(voice(simulator.advance(300), 2)?.volume).toBe(6.25);
    simulator.trigger("scare");
    expect(voice(simulator.advance(100), 2)?.volume).toBe(3.125);
    expect(simulator.advance(100).audio.map((item) => item.track)).toEqual([3]);
    expect(voice(simulator.advance(400), 3)?.volume).toBe(25);
  });

  it.each([
    ["outgoing", 100],
    ["incoming", 300],
  ] as const)(
    "STOP clears pending playback during the %s phase",
    (_, elapsed) => {
      const simulator = createSimulator(projectWithFades());
      simulator.trigger("approach");
      simulator.advance(elapsed);
      const stopped = simulator.stop();
      expect(stopped.audio).toEqual([]);
      expect(stopped.running).toBe(false);
      expect(Object.values(stopped.outputs).every((active) => !active)).toBe(
        true,
      );
      expect(simulator.advance(2000).audio).toEqual([]);
      expect(simulator.trigger("scare")).toBe(false);
      const restarted = simulator.reset();
      expect(restarted.stateId).toBe("idle");
      expect(restarted.audio.map((item) => item.track)).toEqual([1]);
      expect(voice(restarted, 1)?.volume).toBe(0);
      expect(voice(simulator.advance(400), 1)?.volume).toBe(20);
    },
  );

  it("reset replaces the pending target and restarts nonpersistent ambient", () => {
    const simulator = createSimulator(projectWithFades());
    simulator.advance(1000);
    simulator.trigger("approach");
    simulator.advance(100);
    expect(simulator.reset().stateId).toBe("idle");
    expect(voice(simulator.advance(100), 1)?.positionMs).toBe(0);
    expect(voice(simulator.snapshot(), 1)?.volume).toBe(0);
    expect(voice(simulator.advance(400), 1)?.volume).toBe(20);
    expect(voice(simulator.snapshot(), 2)).toBeUndefined();
  });

  it("retains silent ambient position while reusing only one foreground slot", () => {
    const simulator = createSimulator(projectWithFades(200, 400, true));
    simulator.advance(1000);
    simulator.trigger("approach");
    simulator.advance(600);
    expect(voice(simulator.snapshot(), 1)?.positionMs).toBe(1600);
    expect(voice(simulator.snapshot(), 1)?.volume).toBe(0);
    expect(voice(simulator.snapshot(), 2)?.playerIndex).toBe(1);
    simulator.trigger("scare");
    expect(voice(simulator.advance(100), 2)?.volume).toBe(12.5);
    const switched = simulator.advance(100);
    expect(switched.audio.map((item) => item.track)).toEqual([1, 3]);
    expect(voice(switched, 3)?.playerIndex).toBe(1);
    expect(voice(switched, 1)?.positionMs).toBe(1800);
    simulator.advance(400);
    simulator.trigger("reset");
    simulator.advance(200);
    expect(simulator.snapshot().audio.map((item) => item.track)).toEqual([1]);
    expect(voice(simulator.advance(200), 1)?.volume).toBe(10);
    const restored = simulator.advance(200);
    expect(voice(restored, 1)?.volume).toBe(20);
    expect(voice(restored, 1)?.positionMs).toBe(2800);
  });

  it("restarts the same foreground file after its outgoing fade", () => {
    const project = projectWithFades();
    project.states[2].foregroundTrack = 2;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    simulator.advance(1000);
    expect(voice(simulator.snapshot(), 2)?.positionMs).toBe(800);
    simulator.trigger("scare");
    const restarted = simulator.advance(200);
    expect(voice(restarted, 2)?.positionMs).toBe(0);
    expect(voice(restarted, 2)?.volume).toBe(0);
  });

  it("distinguishes identical ambient and foreground files", () => {
    const project = projectWithFades(200, 400, true);
    project.states[1].foregroundTrack = 1;
    const simulator = createSimulator(project);
    simulator.advance(1000);
    simulator.trigger("approach");
    simulator.advance(600);
    expect(
      simulator.snapshot().audio.map((item) => [item.role, item.positionMs]),
    ).toEqual([
      ["ambient", 1600],
      ["foreground", 400],
    ]);
    simulator.trigger("reset");
    const restored = simulator.advance(600);
    expect(restored.audio).toHaveLength(1);
    expect(restored.audio[0].role).toBe("ambient");
    expect(restored.audio[0].positionMs).toBe(2200);
    expect(restored.audio[0].volume).toBe(20);
  });
});
