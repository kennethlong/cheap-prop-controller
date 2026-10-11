import { describe, expect, it } from "vitest";
import {
  allocatePins,
  createDefaultProject,
  createSimulator,
  createTrigger,
  synchronizeAudioPlayers,
} from "../../src/shared";

function projectBase() {
  const project = createDefaultProject();
  for (const state of project.states) {
    state.events = [];
    state.durationMs = 1000;
  }
  return project;
}
function timerProject(reset = false) {
  const project = projectBase();
  project.triggers.push({
    ...createTrigger("timer", "Timer"),
    kind: "timer",
    timerIntervalMs: 1000,
    timerResetOnTrigger: reset,
  });
  project.states[0].transitions.push({
    triggerId: "timer",
    targetStateId: "scare",
  });
  project.states[1].transitions.push({
    triggerId: "timer",
    targetStateId: "scare",
  });
  project.states[2].transitions.push({
    triggerId: "timer",
    targetStateId: "idle",
  });
  return allocatePins(project).project;
}
function audioProject(known = true) {
  const project = projectBase();
  project.audio.transitionMode = "cut";
  project.audio.tracks = [
    { number: 1, name: "Scare", ...(known ? { durationMs: 200 } : {}) },
  ];
  project.states[1].foregroundTrack = 1;
  project.states[1].audioEndStateId = "idle";
  const allocated = synchronizeAudioPlayers(project);
  allocated.audio.players.forEach((player) => {
    player.feedback = { pin: null, activeLow: true };
  });
  return allocatePins(allocated).project;
}

describe("ON/OFF timeline and release edges", () => {
  it("an OFF interval overrides idle active and restores it exactly at the ending edge", () => {
    const project = projectBase();
    project.outputs[0].idleActive = true;
    project.outputs[0].activeLow = true;
    project.states[0].events = [
      {
        id: "off",
        outputId: "output-1",
        startMs: 100,
        endMs: 200,
        active: false,
      },
    ];
    const simulator = createSimulator(project);
    expect(simulator.snapshot().outputs["output-1"]).toBe(true);
    expect(simulator.advance(100).physicalOutputs["output-1"]).toBe(true);
    expect(simulator.advance(100).physicalOutputs["output-1"]).toBe(false);
    expect(simulator.stop().outputs["output-1"]).toBe(false);
  });

  it("debounces activation and release separately without repeated held-input transitions", () => {
    const project = projectBase();
    project.states[1].transitions.push({
      triggerId: "approach",
      edge: "release",
      targetStateId: "idle",
    });
    const simulator = createSimulator(project);
    simulator.setTrigger("approach", true);
    expect(simulator.advance(100).stateId).toBe("approach");
    simulator.advance(500);
    simulator.setTrigger("approach", false);
    expect(simulator.advance(50).stateId).toBe("approach");
    simulator.setTrigger("approach", true);
    simulator.advance(50);
    simulator.setTrigger("approach", false);
    expect(simulator.advance(100).stateId).toBe("idle");
  });

  it("suppresses release of an input already held when RUN resets the scene", () => {
    const project = projectBase();
    project.states[0].transitions.push({
      triggerId: "approach",
      edge: "release",
      targetStateId: "scare",
    });
    const simulator = createSimulator(project);
    simulator.setTrigger("approach", true);
    simulator.advance(100);
    simulator.reset();
    simulator.setTrigger("approach", false);
    expect(simulator.advance(100).stateId).toBe("idle");
    simulator.setTrigger("approach", true);
    simulator.advance(100);
    simulator.trigger("reset");
    simulator.setTrigger("approach", false);
    expect(simulator.advance(100).stateId).toBe("scare");
  });

  it("RUN baselines an input whose previous activation was still being debounced", () => {
    const project = projectBase();
    project.states[0].transitions.push({
      triggerId: "approach",
      edge: "release",
      targetStateId: "scare",
    });
    const simulator = createSimulator(project);
    simulator.setTrigger("approach", true);
    simulator.advance(50);
    simulator.reset();
    expect(simulator.advance(200).stateId).toBe("idle");
    simulator.setTrigger("approach", false);
    expect(simulator.advance(100).stateId).toBe("idle");
    simulator.setTrigger("approach", true);
    expect(simulator.advance(100).stateId).toBe("approach");
  });

  it("keeps transition-list priority when activation and release happen in the same tick", () => {
    const project = projectBase();
    project.states[0].transitions = [
      { triggerId: "approach", edge: "release", targetStateId: "scare" },
      { triggerId: "reset", targetStateId: "approach" },
    ];
    const simulator = createSimulator(project);
    simulator.setTrigger("approach", true);
    simulator.advance(100);
    simulator.setTrigger("approach", false);
    simulator.setTrigger("reset", true);
    expect(simulator.advance(100).stateId).toBe("scare");
  });

  it("a missing sonar echo does not invent a release or rearm the next activation", () => {
    const project = projectBase();
    project.triggers[0].kind = "ultrasonic";
    project.triggers[0].activeLow = false;
    project.triggers[0].pullup = false;
    project.states[1].transitions.push({
      triggerId: "approach",
      edge: "release",
      targetStateId: "idle",
    });
    const simulator = createSimulator(allocatePins(project).project);
    simulator.setDistance("approach", 50);
    simulator.advance(100);
    simulator.setDistance("approach", null);
    expect(simulator.advance(1000).stateId).toBe("approach");
    simulator.setDistance("approach", 150);
    expect(simulator.advance(100).stateId).toBe("idle");
  });
});

describe("timer and alternate destination preview", () => {
  it("confirmed zone entry resets a timer before that tick's deadline, but baseline and exit do not", () => {
    const project = timerProject(true);
    project.triggers[0] = {
      ...project.triggers[0],
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
      distanceMode: "zones",
      debounceMs: 0,
      zones: [
        {
          id: "near",
          name: "Near",
          minCm: 2,
          maxCm: 100,
          hysteresisCm: 5,
          onEnter: [],
          onExit: [],
        },
      ],
    };
    project.states.forEach((state) => {
      state.transitions = state.transitions.filter(
        (transition) => transition.triggerId !== "approach",
      );
    });
    const simulator = createSimulator(allocatePins(project).project);
    simulator.setDistance("approach", 300);
    simulator.advance(950);
    simulator.setDistance("approach", 50);
    expect(simulator.advance(50).stateId).toBe("idle");
    simulator.advance(850);
    simulator.setDistance("approach", 300);
    simulator.advance(50);
    expect(simulator.advance(100).stateId).toBe("scare");
    const baseline = createSimulator(allocatePins(project).project);
    baseline.advance(950);
    baseline.setDistance("approach", 50);
    expect(baseline.advance(50).stateId).toBe("scare");
  });

  it("timers use RUN-relative deadlines independent of state entry and repeat", () => {
    const simulator = createSimulator(timerProject());
    simulator.advance(700);
    simulator.trigger("approach");
    expect(simulator.advance(250).stateId).toBe("approach");
    expect(simulator.advance(50).stateId).toBe("scare");
    expect(simulator.advance(1000).stateId).toBe("idle");
  });

  it("an external activation resets enabled timers even when it has no state transition", () => {
    const simulator = createSimulator(timerProject(true));
    simulator.advance(900);
    expect(simulator.trigger("scare")).toBe(false);
    expect(simulator.advance(950).stateId).toBe("idle");
    expect(simulator.advance(50).stateId).toBe("scare");
  });

  it("physical activation wins over a timer deadline and restarts that timer", () => {
    const simulator = createSimulator(timerProject(true));
    simulator.advance(900);
    simulator.setTrigger("approach", true);
    expect(simulator.advance(100).stateId).toBe("approach");
    expect(simulator.advance(950).stateId).toBe("approach");
    expect(simulator.advance(50).stateId).toBe("scare");
  });

  it("release does not postpone a reset-enabled timer", () => {
    const simulator = createSimulator(timerProject(true));
    simulator.setTrigger("scare", true);
    simulator.advance(100);
    simulator.advance(800);
    simulator.setTrigger("scare", false);
    simulator.advance(100);
    expect(simulator.advance(100).stateId).toBe("scare");
  });

  it("STOP prevents timers firing and RUN creates fresh deadlines", () => {
    const simulator = createSimulator(timerProject());
    simulator.advance(950);
    simulator.stop();
    expect(simulator.advance(5000).stateId).toBe("idle");
    simulator.start();
    expect(simulator.advance(950).stateId).toBe("idle");
    expect(simulator.advance(50).stateId).toBe("scare");
    expect(() => simulator.setTrigger("timer", true)).toThrow("automatically");
    expect(simulator.release("timer")).toBe(false);
  });

  it("cycles destinations per state and edge, then resets the sequence on RUN", () => {
    const project = projectBase();
    project.states[0].transitions = [
      {
        triggerId: "approach",
        targetStateId: "approach",
        alternateStateIds: ["scare"],
      },
      {
        triggerId: "approach",
        edge: "release",
        targetStateId: "scare",
        alternateStateIds: ["approach"],
      },
    ];
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(simulator.snapshot().stateId).toBe("approach");
    simulator.trigger("reset");
    simulator.release("approach");
    expect(simulator.snapshot().stateId).toBe("scare");
    simulator.trigger("reset");
    simulator.trigger("approach");
    expect(simulator.snapshot().stateId).toBe("scare");
    simulator.reset();
    simulator.trigger("approach");
    expect(simulator.snapshot().stateId).toBe("approach");
  });
});

describe("foreground playback completion preview", () => {
  it("uses the applied clip length and returns to the configured state", () => {
    const project = audioProject();
    project.audio.tracks[0] = {
      ...project.audio.tracks[0],
      durationMs: 1000,
      trimStartMs: 300,
      trimEndMs: 500,
    };
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(simulator.advance(150).stateId).toBe("approach");
    expect(simulator.advance(50).stateId).toBe("idle");
  });

  it("does not guess unknown duration, and permits an explicit confirmed finish", () => {
    const simulator = createSimulator(audioProject(false));
    expect(simulator.audioFinished()).toBe(false);
    simulator.trigger("approach");
    expect(simulator.advance(10000).stateId).toBe("approach");
    expect(simulator.audioFinished(2)).toBe(false);
    expect(simulator.audioFinished(0)).toBe(true);
    expect(simulator.snapshot().stateId).toBe("idle");
    expect(simulator.audioFinished()).toBe(false);
  });

  it("a simultaneous input state entry takes precedence over audio completion", () => {
    const simulator = createSimulator(audioProject());
    simulator.trigger("approach");
    simulator.advance(100);
    simulator.setTrigger("scare", true);
    expect(simulator.advance(100).stateId).toBe("scare");
  });

  it("waits for incoming playback after fade-through before counting its length", () => {
    const project = audioProject();
    project.audio.transitionMode = "fade-through";
    project.audio.fadeOutMs = 500;
    project.audio.fadeInMs = 100;
    project.audio.ambientTrack = 2;
    project.audio.tracks.push({ number: 2, name: "Ambient", durationMs: 100 });
    const simulator = createSimulator(project);
    simulator.trigger("approach");
    expect(simulator.audioFinished()).toBe(false);
    expect(simulator.advance(650).stateId).toBe("approach");
    expect(simulator.advance(50).stateId).toBe("idle");
  });

  it("ignores a retiring player's completion after a new foreground starts", () => {
    let project = audioProject(false);
    project.audio.transitionMode = "crossfade";
    project.audio.fadeMs = 500;
    project.states[2].foregroundTrack = 2;
    project.states[2].audioEndStateId = "idle";
    project.audio.tracks.push({ number: 2, name: "Second" });
    project = synchronizeAudioPlayers(project);
    project.audio.players.forEach((player) => {
      player.feedback = { pin: null, activeLow: true };
    });
    const simulator = createSimulator(allocatePins(project).project);
    simulator.trigger("approach");
    const first = simulator
      .snapshot()
      .audio.find((voice) => voice.role === "foreground")!.playerIndex;
    simulator.advance(100);
    simulator.trigger("scare");
    expect(simulator.audioFinished(first)).toBe(false);
    expect(simulator.audioFinished()).toBe(true);
    expect(simulator.snapshot().stateId).toBe("idle");
  });
});
