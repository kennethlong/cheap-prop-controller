import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  compileProject,
  createDefaultProject,
  parseProject,
  requiredPlayerCount,
  resolveAudioTransition,
  synchronizeAudioPlayers,
  validateProject,
  type SceneProject,
} from "../../src/shared";

function audioProject(): SceneProject {
  const project = createDefaultProject();
  project.audio.ambientTrack = 1;
  project.audio.tracks = [1, 2, 3].map((number) => ({
    number,
    name: `Track ${number}`,
  }));
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  project.audio.transitionMode = "fade-through";
  project.audio.fadeOutMs = 150;
  project.audio.fadeInMs = 350;
  return synchronizeAudioPlayers(project);
}

describe("audio transition configuration", () => {
  it("fits sequential transitions on one Uno player and releases the second player's pins", () => {
    const project = audioProject();
    expect(requiredPlayerCount(project)).toBe(1);
    expect(project.audio.players).toHaveLength(1);
    expect(allocatePins(project).maxOutputs).toBe(13);
    expect(
      validateProject(project).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    project.audio.keepAmbient = true;
    expect(requiredPlayerCount(project)).toBe(2);
    project.audio.transitionMode = "crossfade";
    expect(requiredPlayerCount(project)).toBe(3);
  });

  it("preserves legacy cut/crossfade behavior and separate settings across save/open", () => {
    const legacy = createDefaultProject();
    expect(
      resolveAudioTransition(parseProject(JSON.stringify(legacy)).audio).mode,
    ).toBe("crossfade");
    legacy.audio.fadeMs = 0;
    expect(resolveAudioTransition(legacy.audio).mode).toBe("cut");
    const project = audioProject();
    expect(parseProject(JSON.stringify(project)).audio).toEqual(project.audio);
    project.audio.transitionMode = "cut";
    expect(requiredPlayerCount(project)).toBe(1);
    const cut = compileProject(project).bytes;
    expect(cut[17]).toBe(0);
    expect(cut[19]).toBe(0);
    expect(project.audio.fadeOutMs).toBe(150);
  });

  it("encodes separate durations without increasing the header or changing legacy images", () => {
    const project = audioProject();
    const compiled = compileProject(project);
    expect(compiled.bytes[16]).toBe(2);
    expect(compiled.bytes[17]).toBe(7);
    expect(compiled.bytes[19]).toBe(3);
    expect(compiled.usedBytes).toBe(176);
    expect(Buffer.from(compiled.bytes)).toEqual(
      readFileSync(new URL("./single-player-fade-scene.bin", import.meta.url)),
    );
    project.audio.fadeOutMs = undefined;
    project.audio.fadeInMs = undefined;
    const defaults = compileProject(project).bytes;
    expect(defaults[17]).toBe(5);
    expect(defaults[19]).toBe(5);
  });

  it.each([-50, 125, 12800, Number.NaN])(
    "rejects invalid fade duration %s",
    (value) => {
      const project = audioProject();
      project.audio.fadeOutMs = value;
      project.audio.fadeInMs = value;
      const errors = validateProject(project);
      expect(errors.some((issue) => issue.path === "audio.fadeOutMs")).toBe(
        true,
      );
      expect(errors.some((issue) => issue.path === "audio.fadeInMs")).toBe(
        true,
      );
      expect(compileProject(project).bytes).toHaveLength(0);
    },
  );

  it("rejects unknown transition modes and accepts zero or maximum durations", () => {
    const project = audioProject();
    expect(() =>
      parseProject({
        ...project,
        audio: { ...project.audio, transitionMode: "unknown" },
      }),
    ).toThrow("audio.transitionMode");
    project.audio.fadeOutMs = 0;
    project.audio.fadeInMs = 12750;
    const bytes = compileProject(project).bytes;
    expect(bytes[17]).toBe(255);
    expect(bytes[19]).toBe(0);
  });
});
