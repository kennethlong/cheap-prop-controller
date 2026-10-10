import { describe, expect, it } from "vitest";
import {
  compileProject,
  createDefaultProject,
  getMediaClip,
  parseProject,
  validateProject,
} from "../../src/shared";

describe("media clip ranges", () => {
  it("keeps old files full length and prefers decoded duration over cached metadata", () => {
    const track = { number: 1, name: "Ambient" };
    expect(getMediaClip(track, 10000)).toEqual({
      startMs: 0,
      endMs: 10000,
      durationMs: 10000,
    });
    expect(
      getMediaClip(
        { ...track, durationMs: 8000, trimStartMs: 2000, trimEndMs: null },
        6000,
      ),
    ).toEqual({ startMs: 2000, endMs: 6000, durationMs: 4000 });
    expect(getMediaClip(track)).toEqual({
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    });
  });

  it("preserves clip metadata without adding any controller storage", () => {
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 1, name: "Audio" }];
    const before = compileProject(project);
    project.audio.tracks[0] = {
      ...project.audio.tracks[0],
      durationMs: 12000,
      trimStartMs: 2000,
      trimEndMs: 6000,
    };
    const reopened = parseProject(JSON.stringify(project));
    expect(reopened.audio.tracks).toEqual(project.audio.tracks);
    expect(compileProject(reopened).bytes).toEqual(before.bytes);
    expect(getMediaClip(reopened.audio.tracks[0])).toEqual({
      startMs: 2000,
      endMs: 6000,
      durationMs: 4000,
    });
  });

  it.each([
    { trimStartMs: -1 },
    { trimStartMs: 5000, trimEndMs: 5000 },
    { trimStartMs: 5000, trimEndMs: 4000 },
    { trimStartMs: 10000 },
    { trimEndMs: 10001 },
    { durationMs: 0 },
    { trimEndMs: Infinity },
    { trimStartMs: NaN },
  ])(
    "rejects invalid clip metadata %j while keeping render bounds safe",
    (range) => {
      const project = createDefaultProject();
      const track = { number: 1, name: "Audio", durationMs: 10000, ...range };
      project.audio.tracks = [track];
      expect(
        validateProject(project).some((issue) =>
          issue.path.startsWith("audio.tracks.0"),
        ),
      ).toBe(true);
      const clip = getMediaClip(track, 10000);
      expect(Number.isFinite(clip.durationMs)).toBe(true);
      expect(clip.startMs).toBeGreaterThanOrEqual(0);
      expect(clip.endMs).toBeLessThanOrEqual(10000);
    },
  );
});
