import { describe, expect, it } from "vitest";
import {
  allocatePins,
  createDefaultProject,
  createSimulator,
  createTrigger,
  synchronizeAudioPlayers,
  type DistanceZone,
  type SceneProject,
  type SimulatorSnapshot,
  type ZoneAction,
} from "../../src/shared";

const stateAction = (stateId: string): ZoneAction => ({
  id: `state-${stateId}`,
  kind: "state",
  stateId,
});
const volumeAction = (
  target: "ambient" | "foreground",
  volume: number,
  fadeMs = 0,
): ZoneAction => ({
  id: `${target}-${volume}-${fadeMs}`,
  kind: "volume",
  target,
  volume,
  fadeMs,
});
const zone = (
  id: string,
  minCm: number,
  maxCm: number,
  onEnter: ZoneAction[] = [],
  onExit: ZoneAction[] = [],
): DistanceZone => ({
  id,
  name: id,
  minCm,
  maxCm,
  hysteresisCm: 5,
  onEnter,
  onExit,
});

function zonedProject(
  mode: SceneProject["audio"]["transitionMode"] = "cut",
): SceneProject {
  const project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 4);
  project.triggers.push({
    ...createTrigger("distance", "Entrance distance"),
    kind: "ultrasonic",
    activeLow: false,
    pullup: false,
    debounceMs: 0,
    distanceMode: "zones",
    zones: [
      zone("far", 201, 400),
      zone("middle", 101, 200),
      zone("near", 2, 100),
    ],
  });
  Object.assign(project.audio, {
    ambientTrack: 1,
    ambientVolume: 20,
    ambientMixVolume: 8,
    keepAmbient: true,
    transitionMode: mode,
    fadeMs: 400,
    fadeInMs: 400,
    fadeOutMs: 200,
    tracks: [1, 2, 3].map((number) => ({ number, name: `Track ${number}` })),
  });
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  return synchronizeAudioPlayers(project);
}
const sensor = (project: SceneProject) => project.triggers[3];
const zones = (project: SceneProject) => sensor(project).zones!;
const ambient = (snapshot: SimulatorSnapshot) =>
  snapshot.audio.find((voice) => voice.role === "ambient")!;
const foreground = (snapshot: SimulatorSnapshot, track = 2) =>
  snapshot.audio.find(
    (voice) => voice.role === "foreground" && voice.track === track,
  );
function simulatorAtFar(project: SceneProject) {
  const simulator = createSimulator(project);
  simulator.setDistance("distance", 300);
  simulator.advance(50);
  return simulator;
}

describe("ultrasonic distance zone preview", () => {
  it.each([
    [2, "near"],
    [100, "near"],
    [101, "middle"],
    [200, "middle"],
    [201, "far"],
    [400, "far"],
  ])("silently baselines inclusive distance %i to %s", (distance, zoneId) => {
    const project = zonedProject();
    zones(project).forEach((item) => {
      item.onEnter = [stateAction("scare")];
    });
    const simulator = createSimulator(project);
    simulator.setDistance("distance", distance as number);
    const snapshot = simulator.advance(1000);
    expect(snapshot.stateId).toBe("idle");
    expect(snapshot.distances.distance).toEqual({
      distanceCm: distance,
      zoneId,
      zoneName: zoneId,
    });
  });

  it("retains a zone through its extended hysteresis boundary in both directions", () => {
    const simulator = simulatorAtFar(zonedProject());
    simulator.setDistance("distance", 196);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("far");
    simulator.setDistance("distance", 195);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("middle");
    simulator.setDistance("distance", 96);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("middle");
    simulator.setDistance("distance", 95);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("near");
    simulator.setDistance("distance", 105);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("near");
    simulator.setDistance("distance", 106);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("middle");
    simulator.setDistance("distance", 205);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("middle");
    simulator.setDistance("distance", 206);
    expect(simulator.advance(50).distances.distance.zoneId).toBe("far");
  });

  it("requires sustained dwell after the first candidate sample and cancels bounce", () => {
    const project = zonedProject();
    sensor(project).debounceMs = 100;
    zones(project)[2].onEnter = [stateAction("scare")];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    expect(simulator.advance(100).stateId).toBe("idle");
    simulator.setDistance("distance", 300);
    simulator.advance(50);
    simulator.setDistance("distance", 50);
    expect(simulator.advance(100).stateId).toBe("idle");
    expect(simulator.advance(50).stateId).toBe("scare");
    expect(simulator.advance(2000).elapsedMs).toBe(2000);
  });

  it.each([null, -1, 0, 1, 401])(
    "holds the active zone and cancels dwell for invalid distance %s",
    (invalid) => {
      const project = zonedProject();
      sensor(project).debounceMs = 100;
      zones(project)[2].onEnter = [stateAction("scare")];
      const simulator = simulatorAtFar(project);
      simulator.setDistance("distance", 50);
      simulator.advance(100);
      simulator.setDistance("distance", invalid);
      expect(simulator.advance(500).distances.distance).toEqual({
        distanceCm: null,
        zoneId: "far",
        zoneName: "far",
      });
      simulator.setDistance("distance", 50);
      expect(simulator.advance(100).stateId).toBe("idle");
      expect(simulator.advance(50).stateId).toBe("scare");
    },
  );

  it("invalid readings cancel candidate time even if replaced before the next tick", () => {
    const project = zonedProject();
    sensor(project).debounceMs = 100;
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    simulator.advance(100);
    simulator.setDistance("distance", null);
    simulator.setDistance("distance", 50);
    expect(simulator.advance(100).distances.distance.zoneId).toBe("far");
    expect(simulator.advance(50).distances.distance.zoneId).toBe("near");
  });

  it("does not baseline a no-echo reading, fire startup actions, or rearm on state entry", () => {
    const project = zonedProject();
    zones(project)[2].onEnter = [stateAction("scare")];
    const simulator = createSimulator(project);
    simulator.setDistance("distance", null);
    expect(simulator.advance(500).distances.distance.zoneId).toBeNull();
    simulator.setDistance("distance", 50);
    expect(simulator.advance(50).stateId).toBe("idle");
    simulator.trigger("approach");
    expect(simulator.advance(200).stateId).toBe("approach");
    simulator.setDistance("distance", 300);
    simulator.advance(50);
    simulator.setDistance("distance", 50);
    expect(simulator.advance(50).stateId).toBe("scare");
    expect(simulator.advance(300).elapsedMs).toBe(300);
  });

  it("runs exit before entry in action order and skips unvisited intermediate zones", () => {
    const project = zonedProject();
    zones(project)[0].onExit = [
      stateAction("approach"),
      volumeAction("foreground", 7),
    ];
    zones(project)[1].onEnter = [volumeAction("foreground", 1)];
    zones(project)[2].onEnter = [volumeAction("foreground", 12)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    const snapshot = simulator.advance(50);
    expect(snapshot.stateId).toBe("approach");
    expect(foreground(snapshot)?.volume).toBe(12);
    expect(foreground(simulator.advance(1000))?.volume).toBe(12);
  });

  it("dispatches an exit into an uncovered gap and an entry from that gap", () => {
    const project = zonedProject();
    sensor(project).zones = [
      zone("far", 250, 400, [], [stateAction("approach")]),
      zone("near", 2, 100, [stateAction("scare")]),
    ];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 150);
    const gap = simulator.advance(50);
    expect(gap.distances.distance.zoneId).toBeNull();
    expect(gap.stateId).toBe("approach");
    simulator.setDistance("distance", 50);
    expect(simulator.advance(50).stateId).toBe("scare");
  });

  it("skips intermediate zone actions when a reading jumps across several ranges", () => {
    const project = zonedProject();
    zones(project)[0].onExit = [stateAction("approach")];
    zones(project)[1].onEnter = [volumeAction("foreground", 1)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    const snapshot = simulator.advance(50);
    expect(snapshot.distances.distance.zoneId).toBe("near");
    expect(foreground(snapshot)?.volume).toBe(25);
  });

  it("uses legacy edges before zones and processes zone sensors in project order", () => {
    const project = zonedProject();
    project.triggers[0].debounceMs = 0;
    zones(project)[2].onEnter = [volumeAction("foreground", 7)];
    project.triggers.push({
      ...sensor(project),
      id: "distance-2",
      pin: null,
      echoPin: null,
      zones: [
        zone("far", 201, 400),
        zone("near", 2, 100, [volumeAction("foreground", 9)]),
      ],
    });
    const simulator = simulatorAtFar(allocatePins(project).project);
    simulator.setDistance("distance-2", 300);
    simulator.advance(50);
    simulator.setTrigger("approach", true);
    simulator.setDistance("distance", 50);
    simulator.setDistance("distance-2", 50);
    const snapshot = simulator.advance(50);
    expect(snapshot.stateId).toBe("approach");
    expect(foreground(snapshot)?.volume).toBe(9);
  });

  it("rejects generic zone triggers and resets zone baselines after STOP/RUN and RESET", () => {
    const project = zonedProject();
    zones(project)[2].onEnter = [stateAction("scare")];
    sensor(project).debounceMs = 100;
    const simulator = simulatorAtFar(project);
    expect(simulator.trigger("distance")).toBe(false);
    expect(() => simulator.setTrigger("distance", true)).toThrow(
      "distance reading",
    );
    simulator.setDistance("distance", 50);
    simulator.advance(100);
    simulator.stop();
    expect(simulator.advance(1000).stateId).toBe("idle");
    simulator.start();
    expect(simulator.advance(500).stateId).toBe("idle");
    expect(simulator.snapshot().distances.distance.zoneId).toBe("near");
    simulator.setDistance("distance", 300);
    simulator.advance(150);
    simulator.setDistance("distance", 50);
    expect(simulator.advance(150).stateId).toBe("scare");
    simulator.reset();
    expect(simulator.advance(500).stateId).toBe("idle");
  });

  it("keeps the original single-threshold release and rearm behavior", () => {
    const project = zonedProject();
    sensor(project).distanceMode = "threshold";
    sensor(project).debounceMs = 100;
    project.states[0].transitions.push({
      triggerId: "distance",
      targetStateId: "scare",
    });
    const simulator = createSimulator(project);
    simulator.setDistance("distance", 90);
    expect(simulator.advance(100).stateId).toBe("scare");
    simulator.reset();
    simulator.setDistance("distance", 110);
    expect(simulator.advance(100).stateId).toBe("idle");
    simulator.setDistance("distance", null);
    simulator.advance(100);
    simulator.setDistance("distance", 90);
    expect(simulator.advance(100).stateId).toBe("scare");
  });
});

describe("zone volume actions", () => {
  it("ramps ambient independently, keeps mute resident, and raises the same playhead", () => {
    const project = zonedProject();
    zones(project)[1].onEnter = [volumeAction("ambient", 0, 200)];
    zones(project)[2].onEnter = [volumeAction("ambient", 10, 100)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 150);
    expect(ambient(simulator.advance(50)).volume).toBe(20);
    expect(ambient(simulator.advance(100)).volume).toBe(10);
    expect(ambient(simulator.advance(100))).toMatchObject({
      volume: 0,
      positionMs: 300,
      playerIndex: 0,
    });
    simulator.advance(500);
    simulator.setDistance("distance", 50);
    expect(ambient(simulator.advance(50)).volume).toBe(0);
    expect(ambient(simulator.advance(50)).volume).toBe(5);
    expect(ambient(simulator.advance(50))).toMatchObject({
      volume: 10,
      positionMs: 950,
      playerIndex: 0,
    });
  });

  it("retargets from the instantaneous fade value and restores configuration on state entry", () => {
    const project = zonedProject();
    zones(project)[1].onEnter = [volumeAction("ambient", 0, 400)];
    zones(project)[2].onEnter = [volumeAction("ambient", 30, 200)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 150);
    simulator.advance(50);
    simulator.advance(50);
    simulator.setDistance("distance", 50);
    expect(ambient(simulator.advance(50)).volume).toBe(15);
    expect(ambient(simulator.advance(100)).volume).toBe(22.5);
    simulator.trigger("approach");
    expect(ambient(simulator.snapshot()).volume).toBe(8);
    simulator.reset();
    expect(ambient(simulator.snapshot()).volume).toBe(20);
  });

  it("applies a following volume action to a newly entered state and leaves a retiring crossfade alone", () => {
    const project = zonedProject("crossfade");
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("foreground", 10, 100),
    ];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.setDistance("distance", 50);
    const entered = simulator.advance(50);
    expect(entered.stateId).toBe("scare");
    expect(foreground(entered, 2)?.volume).toBe(25);
    expect(foreground(entered, 3)?.volume).toBe(0);
    const fading = simulator.advance(100);
    expect(foreground(fading, 2)?.volume).toBe(18.75);
    expect(foreground(fading, 3)).toMatchObject({
      volume: 10,
      positionMs: 100,
    });
    expect(foreground(simulator.advance(300), 2)).toBeUndefined();
  });

  it("mutes and resumes foreground without replaying the clip", () => {
    const project = zonedProject();
    zones(project)[1].onEnter = [volumeAction("foreground", 0)];
    zones(project)[2].onEnter = [volumeAction("foreground", 15)];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(1000);
    simulator.setDistance("distance", 150);
    expect(foreground(simulator.advance(50))).toMatchObject({
      volume: 0,
      positionMs: 1050,
    });
    simulator.advance(500);
    simulator.setDistance("distance", 50);
    expect(foreground(simulator.advance(50))).toMatchObject({
      volume: 15,
      positionMs: 1600,
    });
  });

  it("stores an incoming fade-through target while the outgoing foreground keeps fading out", () => {
    const project = zonedProject("fade-through");
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("foreground", 12, 100),
    ];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.setDistance("distance", 50);
    simulator.advance(50);
    const outgoing = simulator.advance(100);
    expect(foreground(outgoing, 2)?.volume).toBe(12.5);
    expect(foreground(outgoing, 3)).toBeUndefined();
    const started = simulator.advance(100);
    expect(foreground(started, 2)).toBeUndefined();
    expect(foreground(started, 3)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(foreground(simulator.advance(50), 3)?.volume).toBe(6);
    expect(foreground(simulator.advance(50), 3)?.volume).toBe(12);
  });

  it("does not delay foreground handoff for a longer ambient volume envelope", () => {
    const project = zonedProject("fade-through");
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("ambient", 0, 800),
    ];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.setDistance("distance", 50);
    simulator.advance(50);
    const started = simulator.advance(200);
    expect(ambient(started).volume).toBe(6);
    expect(foreground(started, 3)).toMatchObject({ volume: 0, positionMs: 0 });
    const muted = simulator.advance(600);
    expect(ambient(muted)).toMatchObject({ volume: 0, positionMs: 1300 });
    expect(foreground(muted, 3)?.volume).toBe(25);
  });

  it("preserves a zone ambient envelope through a legacy silent-ambient handoff", () => {
    const project = zonedProject("fade-through");
    project.audio.ambientMixVolume = 0;
    zones(project)[2].onEnter = [
      stateAction("approach"),
      volumeAction("ambient", 10, 400),
      volumeAction("foreground", 0, 0),
    ];
    zones(project)[1].onEnter = [volumeAction("foreground", 12, 100)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    expect(foreground(simulator.advance(50))).toMatchObject({
      volume: 0,
      positionMs: 0,
    });
    const started = simulator.advance(200);
    expect(ambient(started)).toMatchObject({ volume: 15, positionMs: 300 });
    expect(foreground(started)).toMatchObject({ volume: 0, positionMs: 200 });
    expect(ambient(simulator.advance(200))).toMatchObject({
      volume: 10,
      positionMs: 500,
    });
    simulator.setDistance("distance", 150);
    simulator.advance(50);
    const raised = simulator.advance(100);
    expect(foreground(raised)).toMatchObject({ volume: 12, positionMs: 550 });
    expect(ambient(raised).volume).toBe(10);
    simulator.trigger("scare");
    expect(ambient(simulator.advance(600)).volume).toBe(0);
  });

  it("fades a superseded silent-ambient override back to zero before the replacement handoff", () => {
    const project = zonedProject("fade-through");
    project.audio.ambientMixVolume = 0;
    project.audio.fadeOutMs = 500;
    project.audio.fadeInMs = 100;
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("ambient", 11),
    ];
    zones(project)[1].onEnter = [stateAction("approach")];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(650);
    simulator.setDistance("distance", 50);
    expect(ambient(simulator.advance(50)).volume).toBe(11);
    simulator.advance(50);
    simulator.setDistance("distance", 150);
    const replacement = simulator.advance(50);
    expect(replacement.stateId).toBe("approach");
    expect(ambient(replacement).volume).toBe(11);
    const fading = simulator.advance(200);
    expect(ambient(fading).volume).toBeCloseTo(6.6);
    // The original foreground deadline arrives 100 ms before ambient silence.
    // The replacement cannot start until both retiring envelopes are ready.
    const originalDeadline = simulator.advance(200);
    expect(foreground(originalDeadline)).toBeUndefined();
    expect(ambient(originalDeadline).volume).toBeCloseTo(2.2);
    const handoff = simulator.advance(100);
    expect(ambient(handoff)).toMatchObject({ volume: 0, positionMs: 1350 });
    expect(foreground(handoff)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(foreground(simulator.advance(100))?.volume).toBe(25);
  });

  it("starts an idle foreground decoder as soon as ambient becomes independent", () => {
    const project = zonedProject("fade-through");
    project.audio.ambientMixVolume = 0;
    project.audio.fadeOutMs = 800;
    project.audio.fadeInMs = 100;
    zones(project)[2].onEnter = [
      stateAction("approach"),
      volumeAction("ambient", 10, 400),
    ];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    const entered = simulator.advance(50);
    expect(foreground(entered)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(ambient(entered)).toMatchObject({ volume: 20, positionMs: 100 });
    const fading = simulator.advance(100);
    expect(foreground(fading)).toMatchObject({ volume: 25, positionMs: 100 });
    expect(ambient(fading).volume).toBe(17.5);
  });

  it("starts at the current time when an override releases an expired foreground wait", () => {
    const project = zonedProject("fade-through");
    project.audio.ambientMixVolume = 0;
    project.audio.fadeOutMs = 500;
    project.audio.fadeInMs = 100;
    zones(project)[0].onEnter = [volumeAction("ambient", 5)];
    zones(project)[1].onEnter = [stateAction("approach")];
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("ambient", 11),
    ];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(650);
    simulator.setDistance("distance", 50);
    simulator.advance(100);
    simulator.setDistance("distance", 150);
    simulator.advance(50);
    const waitingForAmbient = simulator.advance(400);
    expect(foreground(waitingForAmbient)).toBeUndefined();
    expect(ambient(waitingForAmbient).volume).toBeCloseTo(2.2);
    simulator.setDistance("distance", 300);
    const released = simulator.advance(50);
    expect(foreground(released)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(ambient(released)).toMatchObject({ volume: 5, positionMs: 1300 });
    expect(foreground(simulator.advance(100))).toMatchObject({
      volume: 25,
      positionMs: 100,
    });
  });

  it("applies a nonpersistent ambient override only to the restarted incoming track", () => {
    const project = zonedProject("fade-through");
    project.audio.keepAmbient = false;
    project.audio.fadeOutMs = 500;
    zones(project)[1].onEnter = [stateAction("approach")];
    zones(project)[2].onEnter = [
      stateAction("idle"),
      volumeAction("ambient", 30, 100),
    ];
    const simulator = simulatorAtFar(synchronizeAudioPlayers(project));
    simulator.setDistance("distance", 150);
    simulator.advance(100);
    simulator.setDistance("distance", 50);
    const replacement = simulator.advance(50);
    expect(replacement.stateId).toBe("idle");
    expect(ambient(replacement)).toMatchObject({ volume: 16, positionMs: 200 });
    expect(ambient(simulator.advance(100))).toMatchObject({
      volume: 12,
      positionMs: 300,
    });
    const restarted = simulator.advance(300);
    expect(restarted.audio).toHaveLength(1);
    expect(ambient(restarted)).toMatchObject({ volume: 0, positionMs: 0 });
    expect(ambient(simulator.advance(50)).volume).toBe(15);
    expect(ambient(simulator.advance(50))).toMatchObject({
      volume: 30,
      positionMs: 100,
    });
  });

  it("keeps a normally muted ambient resident so a zone can make it audible", () => {
    const project = zonedProject();
    project.audio.ambientVolume = 0;
    zones(project)[2].onEnter = [volumeAction("ambient", 15, 100)];
    const simulator = simulatorAtFar(project);
    simulator.advance(1000);
    simulator.setDistance("distance", 50);
    simulator.advance(50);
    expect(ambient(simulator.advance(100))).toMatchObject({
      volume: 15,
      positionMs: 1200,
    });
  });

  it("cancels pending overrides on state entry and STOP", () => {
    const project = zonedProject("fade-through");
    zones(project)[2].onEnter = [
      stateAction("scare"),
      volumeAction("foreground", 1, 100),
    ];
    const simulator = simulatorAtFar(project);
    simulator.trigger("approach");
    simulator.advance(400);
    simulator.setDistance("distance", 50);
    simulator.advance(50);
    simulator.reset();
    simulator.trigger("approach");
    simulator.advance(600);
    expect(foreground(simulator.snapshot())?.volume).toBe(25);
    expect(foreground(simulator.snapshot(), 3)).toBeUndefined();
    simulator.stop();
    expect(simulator.advance(1000).audio).toEqual([]);
    simulator.start();
    expect(ambient(simulator.advance(400)).volume).toBe(20);
  });

  it("ignores a volume action for an absent role without starting another track", () => {
    const project = zonedProject();
    zones(project)[2].onEnter = [volumeAction("foreground", 30)];
    const simulator = simulatorAtFar(project);
    simulator.setDistance("distance", 50);
    const snapshot = simulator.advance(50);
    expect(snapshot.audio).toHaveLength(1);
    expect(ambient(snapshot)).toMatchObject({
      track: 1,
      volume: 20,
      positionMs: 100,
    });
  });
});
