import { describe, expect, it } from "vitest";
import {
  createDefaultProject,
  createSimulator,
  synchronizeAudioPlayers,
  type SceneProject,
  type SimulatorSnapshot,
} from "../../src/shared";

function mixedProject(
  transitionMode: SceneProject["audio"]["transitionMode"] = "fade-through",
): SceneProject {
  const project = createDefaultProject();
  Object.assign(project.audio, {
    ambientTrack: 1,
    ambientVolume: 20,
    keepAmbient: true,
    ambientMixVolume: 8,
    transitionMode,
    fadeMs: 400,
    fadeOutMs: 200,
    fadeInMs: 400,
    tracks: [1, 2, 3].map((number) => ({ number, name: `Track ${number}` })),
  });
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  return synchronizeAudioPlayers(project);
}

const ambient = (snapshot: SimulatorSnapshot) =>
  snapshot.audio.find((voice) => voice.role === "ambient")!;
const foreground = (snapshot: SimulatorSnapshot, track = 2) =>
  snapshot.audio.find(
    (voice) => voice.role === "foreground" && voice.track === track,
  );

describe("audible ambient preview", () => {
  it("cuts between normal and mixed volume without restarting ambient", () => {
    const simulator = createSimulator(mixedProject("cut"));
    simulator.advance(1000);
    simulator.trigger("approach");
    expect(ambient(simulator.snapshot())).toMatchObject({
      volume: 8,
      positionMs: 1000,
      playerIndex: 0,
    });
    expect(foreground(simulator.snapshot())).toMatchObject({
      volume: 25,
      playerIndex: 1,
    });
    simulator.advance(250);
    simulator.trigger("scare");
    expect(ambient(simulator.snapshot())).toMatchObject({
      volume: 8,
      positionMs: 1250,
    });
    simulator.advance(250);
    simulator.trigger("reset");
    expect(simulator.snapshot().audio).toHaveLength(1);
    expect(ambient(simulator.snapshot())).toMatchObject({
      volume: 20,
      positionMs: 1500,
    });
  });

  it("crossfades foregrounds while keeping the original ambient fade deadline", () => {
    const simulator = createSimulator(mixedProject("crossfade"));
    simulator.advance(1000);
    simulator.trigger("approach");
    expect(ambient(simulator.advance(100)).volume).toBe(17);
    simulator.trigger("scare");
    expect(simulator.snapshot().audio).toHaveLength(3);
    expect(ambient(simulator.advance(100)).volume).toBe(14);
    expect(ambient(simulator.advance(200))).toMatchObject({
      volume: 8,
      positionMs: 1400,
      playerIndex: 0,
    });
    simulator.trigger("reset");
    expect(ambient(simulator.advance(200)).volume).toBe(14);
    expect(ambient(simulator.advance(200))).toMatchObject({
      volume: 20,
      positionMs: 1800,
    });
    expect(simulator.snapshot().audio).toHaveLength(1);
  });

  it("starts foreground fade-in immediately while ambient independently lowers to its mix", () => {
    const simulator = createSimulator(mixedProject());
    simulator.advance(1000);
    simulator.trigger("approach");
    expect(foreground(simulator.snapshot())).toMatchObject({
      volume: 0,
      positionMs: 0,
      playerIndex: 1,
    });
    const halfway = simulator.advance(100);
    expect(ambient(halfway)).toMatchObject({ volume: 14, positionMs: 1100 });
    expect(foreground(halfway)?.volume).toBe(6.25);
    expect(ambient(simulator.advance(100)).volume).toBe(8);
    expect(foreground(simulator.advance(200))?.volume).toBe(25);
  });

  it("keeps mixed ambient audible while switching the foreground player", () => {
    const simulator = createSimulator(mixedProject());
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.trigger("scare");
    const outgoing = simulator.advance(100);
    expect(ambient(outgoing).volume).toBe(8);
    expect(foreground(outgoing)?.volume).toBe(12.5);
    const switched = simulator.advance(100);
    expect(switched.audio.map((voice) => voice.track)).toEqual([1, 3]);
    expect(ambient(switched)).toMatchObject({
      volume: 8,
      positionMs: 600,
      playerIndex: 0,
    });
    expect(foreground(switched, 3)).toMatchObject({
      volume: 0,
      positionMs: 0,
      playerIndex: 1,
    });
    expect(ambient(simulator.advance(400)).volume).toBe(8);
  });

  it("raises ambient on idle entry without waiting for foreground fade-out or restarting its fade", () => {
    const simulator = createSimulator(mixedProject());
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.trigger("reset");
    expect(ambient(simulator.advance(100)).volume).toBe(11);
    const switched = simulator.advance(100);
    expect(switched.audio).toHaveLength(1);
    expect(ambient(switched)).toMatchObject({ volume: 14, positionMs: 600 });
    expect(ambient(simulator.advance(200))).toMatchObject({
      volume: 20,
      positionMs: 800,
    });
  });

  it("restores normal ambient in a non-idle state with no foreground track", () => {
    const project = mixedProject();
    project.states[2].foregroundTrack = null;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.trigger("scare");
    const restored = simulator.advance(400);
    expect(restored.stateId).toBe("scare");
    expect(restored.audio).toHaveLength(1);
    expect(ambient(restored)).toMatchObject({ volume: 20, positionMs: 800 });
  });

  it("finishes restoring ambient before a longer outgoing foreground fade", () => {
    const project = mixedProject();
    project.audio.fadeOutMs = 600;
    project.audio.fadeInMs = 100;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    simulator.advance(600);
    simulator.reset();
    const restored = simulator.advance(100);
    expect(ambient(restored)).toMatchObject({ volume: 20, positionMs: 700 });
    expect(foreground(restored)?.volume).toBeGreaterThan(0);
    const switched = simulator.advance(500);
    expect(switched.audio).toHaveLength(1);
    expect(ambient(switched)).toMatchObject({ volume: 20, positionMs: 1200 });
  });

  it("retargets rapid reset and foreground entries without delaying the pending foreground switch", () => {
    const simulator = createSimulator(mixedProject());
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.trigger("scare");
    simulator.advance(50);
    simulator.reset();
    expect(ambient(simulator.advance(50)).volume).toBe(9.5);
    simulator.trigger("approach");
    const switched = simulator.advance(100);
    expect(switched.stateId).toBe("approach");
    expect(foreground(switched)).toMatchObject({ positionMs: 0, volume: 0 });
    expect(foreground(switched, 3)).toBeUndefined();
    expect(ambient(switched)).toMatchObject({ volume: 8.75, positionMs: 600 });
    expect(ambient(simulator.advance(100))).toMatchObject({
      volume: 8,
      positionMs: 700,
    });
  });

  it("keeps an interrupted ambient fade continuous when the next foreground starts", () => {
    const project = mixedProject();
    project.audio.fadeOutMs = 400;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(ambient(simulator.advance(100)).volume).toBe(17);
    simulator.trigger("scare");
    expect(ambient(simulator.advance(300)).volume).toBe(8);
    const switched = simulator.advance(100);
    expect(foreground(switched, 3)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(ambient(switched)).toMatchObject({ volume: 8, positionMs: 500 });
  });

  it.each([
    [0, 400],
    [200, 0],
    [0, 0],
  ])(
    "supports zero fade durations (out %i, in %i) without muting ambient",
    (fadeOutMs, fadeInMs) => {
      const project = mixedProject();
      Object.assign(project.audio, { fadeOutMs, fadeInMs });
      const simulator = createSimulator(project);
      simulator.trigger("approach");
      expect(ambient(simulator.snapshot()).volume).toBe(fadeOutMs ? 20 : 8);
      expect(foreground(simulator.snapshot())?.volume).toBe(fadeInMs ? 0 : 25);
      simulator.advance(400);
      simulator.trigger("reset");
      expect(ambient(simulator.snapshot()).volume).toBe(fadeInMs ? 8 : 20);
      expect(ambient(simulator.advance(400)).volume).toBe(20);
    },
  );

  it.each(["cut", "crossfade", "fade-through"] as const)(
    "STOP clears all voices and pending playback for %s",
    (mode) => {
      const simulator = createSimulator(mixedProject(mode));
      simulator.trigger("approach");
      simulator.advance(400);
      simulator.trigger("scare");
      simulator.advance(100);
      expect(simulator.stop().audio).toEqual([]);
      expect(simulator.advance(2000).audio).toEqual([]);
      expect(simulator.trigger("reset")).toBe(false);
      expect(ambient(simulator.start()).positionMs).toBe(0);
      const restarted = simulator.advance(400);
      expect(restarted.audio).toHaveLength(1);
      expect(ambient(restarted)).toMatchObject({ volume: 20, positionMs: 400 });
    },
  );

  it("keeps ambient resident even when its normal idle volume is zero", () => {
    const project = mixedProject();
    project.audio.ambientVolume = 0;
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(ambient(simulator.advance(200)).volume).toBe(8);
    simulator.trigger("reset");
    expect(ambient(simulator.advance(400))).toMatchObject({
      volume: 0,
      positionMs: 600,
    });
    simulator.trigger("approach");
    expect(ambient(simulator.advance(200))).toMatchObject({
      volume: 8,
      positionMs: 800,
    });
  });

  it("distinguishes ambient and foreground roles when they use the same file", () => {
    const project = mixedProject();
    project.states[1].foregroundTrack = 1;
    const simulator = createSimulator(project);
    simulator.advance(1000);
    simulator.trigger("approach");
    const mixed = simulator.advance(400);
    expect(ambient(mixed)).toMatchObject({
      track: 1,
      volume: 8,
      positionMs: 1400,
      playerIndex: 0,
    });
    expect(foreground(mixed, 1)).toMatchObject({
      volume: 25,
      positionMs: 400,
      playerIndex: 1,
    });
  });

  it("does not restore ambient merely because the state's timeline has finished", () => {
    const simulator = createSimulator(mixedProject());
    simulator.trigger("approach");
    const finished = simulator.advance(20000);
    expect(finished.stateId).toBe("approach");
    expect(ambient(finished).volume).toBe(8);
  });

  it.each([undefined, 0])(
    "preserves legacy silent ambient for mix %s",
    (mix) => {
      const project = mixedProject();
      project.audio.ambientMixVolume = mix;
      const simulator = createSimulator(project);
      simulator.trigger("approach");
      expect(foreground(simulator.snapshot())).toBeUndefined();
      expect(ambient(simulator.advance(200)).volume).toBe(0);
      expect(foreground(simulator.snapshot())?.positionMs).toBe(0);
      expect(ambient(simulator.advance(400)).volume).toBe(0);
    },
  );
});
