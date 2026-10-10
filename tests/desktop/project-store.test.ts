import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  readdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../../src/main/project-store";
import { createDefaultProject } from "../../src/shared/index";
import { probeAudioDurationMs } from "../../src/main/audio-export";
import ffmpegPath from "ffmpeg-static";
const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    const resolved = path.resolve(folder);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cpc-store-test-")
    )
      throw new Error(
        "Refusing to remove a path outside the test temporary folder",
      );
    await rm(resolved, { recursive: true, force: true });
  }
});
async function folder() {
  const value = await mkdtemp(path.join(os.tmpdir(), "cpc-store-test-"));
  temporary.push(value);
  return value;
}
async function mp3(filename: string) {
  await promisify(execFile)(
    ffmpegPath!,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "libmp3lame",
      filename,
    ],
    { windowsHide: true, timeout: 20_000 },
  );
}
describe("project file and media persistence", () => {
  it("saves portable audio assets, opens them, and exports numbered card files", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    const content = Buffer.from("ID3fixture");
    await writeFile(source, content);
    const store = new ProjectStore();
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 3, name: "Scare", path: source }];
    const saved = await store.save(project, path.join(root, "show.cpc.json"));
    expect(saved.project.audio.tracks[0].path).toMatch(
      /^sounds\/003-[a-f0-9]{64}\.mp3$/,
    );
    expect(
      (
        await readFile(path.join(root, saved.project.audio.tracks[0].path!))
      ).equals(content),
    ).toBe(true);
    const reopened = new ProjectStore();
    await reopened.open(saved.path);
    expect(
      (await reopened.readAudio(saved.project.audio.tracks[0].path!)).dataUrl,
    ).toContain(content.toString("base64"));
    const card = path.join(root, "card");
    expect((await reopened.exportMedia(saved.project, card)).files).toBe(1);
    expect(
      (await readFile(path.join(card, "01", "003.mp3"))).equals(content),
    ).toBe(true);
    const next = path.join(root, "copy", "copy.cpc.json");
    const copied = await reopened.save(saved.project, next);
    expect(
      (
        await readFile(
          path.join(root, "copy", copied.project.audio.tracks[0].path!),
        )
      ).equals(content),
    ).toBe(true);
  });
  it("rejects arbitrary media reads and parent traversal in opened projects", async () => {
    const root = await folder();
    const nested = path.join(root, "project");
    await mkdir(nested);
    const source = path.join(root, "outside.mp3");
    await writeFile(source, "ID3fixture");
    const store = new ProjectStore();
    await expect(store.readAudio(source)).rejects.toThrow("not imported");
    const project = createDefaultProject();
    project.audio.tracks = [
      { number: 1, name: "Outside", path: "../outside.mp3" },
    ];
    const filename = path.join(nested, "bad.json");
    await writeFile(filename, JSON.stringify(project));
    await store.open(filename);
    await expect(store.readAudio("../outside.mp3")).rejects.toThrow(
      "inside the project",
    );
  });
  it("opens structurally valid scenes with repairable pin conflicts but rejects malformed documents", async () => {
    const root = await folder();
    const store = new ProjectStore();
    const project = createDefaultProject();
    project.outputs[1].pin = project.outputs[0].pin;
    const filename = path.join(root, "repair.json");
    await writeFile(filename, JSON.stringify(project));
    expect((await store.open(filename)).project.outputs).toHaveLength(8);
    await writeFile(filename, '{"version":99}');
    await expect(store.open(filename)).rejects.toThrow();
  });
  it("failed save preserves previously saved JSON and audio assets", async () => {
    const root = await folder();
    const source = path.join(root, "first.mp3");
    await writeFile(source, "original");
    const store = new ProjectStore();
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 1, name: "First", path: source }];
    const filename = path.join(root, "scene.json");
    const saved = await store.save(project, filename);
    const priorJSON = await readFile(filename, "utf8");
    await writeFile(source, "replacement");
    project.audio.tracks.push({
      number: 2,
      name: "Missing",
      path: path.join(root, "missing.mp3"),
    });
    await expect(store.save(project, filename)).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(priorJSON);
    expect(
      await readFile(
        path.join(root, saved.project.audio.tracks[0].path!),
        "utf8",
      ),
    ).toBe("original");
  });
  it("keeps playable originals and trims in sounds across repeat saves and Save As", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    await mp3(source);
    const content = await readFile(source);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [
      {
        number: 1,
        name: "Clip",
        path: source,
        trimStartMs: 500,
        trimEndMs: 1500,
        durationMs: 2000,
      },
    ];
    const saved = await store.save(project, path.join(root, "clipped.json"));
    const reopenedStore = new ProjectStore({ ffmpegPath: ffmpegPath! });
    const reopened = await reopenedStore.open(saved.path);
    expect(reopened.project.audio.tracks[0]).toMatchObject({
      trimStartMs: 500,
      trimEndMs: 1500,
      durationMs: 2000,
    });
    expect(
      (
        await readFile(path.join(root, reopened.project.audio.tracks[0].path!))
      ).equals(content),
    ).toBe(true);
    const clip = reopened.project.audio.tracks[0].trimmedPath!;
    expect(clip).toMatch(/^sounds\/001-trim-[a-f0-9]{64}\.mp3$/);
    expect(
      await probeAudioDurationMs(ffmpegPath!, path.join(root, clip)),
    ).toBeCloseTo(1000, 0);
    const repeated = await reopenedStore.save(reopened.project, saved.path);
    expect(repeated.project.audio.tracks[0]).toEqual(
      reopened.project.audio.tracks[0],
    );
    expect(await readdir(path.join(root, "sounds"))).toHaveLength(2);
    const previousClip = await readFile(path.join(root, clip));
    await expect(
      reopenedStore.saveTrimmedAudio(
        { ...repeated.project.audio.tracks[0], trimEndMs: 1800 },
        path.join(root, clip),
      ),
    ).rejects.toThrow("saved project sounds must not be overwritten");
    expect(await readFile(path.join(root, clip))).toEqual(previousClip);
    const copied = await reopenedStore.save(
      repeated.project,
      path.join(root, "copy", "scene.json"),
    );
    expect(await readdir(path.join(root, "copy", "sounds"))).toHaveLength(2);
    expect(
      (
        await readFile(
          path.join(root, "copy", copied.project.audio.tracks[0].path!),
        )
      ).equals(content),
    ).toBe(true);
    expect(
      await probeAudioDurationMs(
        ffmpegPath!,
        path.join(root, "copy", copied.project.audio.tracks[0].trimmedPath!),
      ),
    ).toBeCloseTo(1000, 0);
    copied.project.audio.tracks[0].trimStartMs = 0;
    copied.project.audio.tracks[0].trimEndMs = null;
    const fullTrack = await reopenedStore.save(copied.project, copied.path);
    expect(fullTrack.project.audio.tracks[0].trimmedPath).toBeUndefined();
    expect((await readFile(source)).equals(content)).toBe(true);
  }, 30_000);
  it("creates sounds for empty scenes and copies legacy assets there without deleting them", async () => {
    const root = await folder();
    const store = new ProjectStore();
    const project = createDefaultProject();
    project.audio.tracks = [];
    const filename = path.join(root, "show.json");
    await store.save(project, filename);
    expect(await readdir(path.join(root, "sounds"))).toEqual([]);
    const legacy = path.join(root, "show.assets", "001.mp3");
    await mkdir(path.dirname(legacy));
    await writeFile(legacy, "legacy original audio");
    project.audio.tracks = [
      { number: 1, name: "Old", path: "show.assets/001.mp3" },
    ];
    await writeFile(filename, JSON.stringify(project));
    const opened = await store.open(filename);
    const migrated = await store.save(opened.project, filename);
    expect(migrated.project.audio.tracks[0].path).toMatch(/^sounds\//);
    expect(
      await readFile(
        path.join(root, migrated.project.audio.tracks[0].path!),
        "utf8",
      ),
    ).toBe("legacy original audio");
    expect(await readFile(legacy, "utf8")).toBe("legacy original audio");
  });
  it("preserves saved JSON and both referenced sounds when a later trim fails", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    await mp3(source);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [
      {
        number: 1,
        name: "Clip",
        path: source,
        trimStartMs: 100,
        trimEndMs: 1000,
      },
    ];
    const filename = path.join(root, "show.json");
    const saved = await store.save(project, filename);
    const previousJSON = await readFile(filename, "utf8");
    const previousFiles = await readdir(path.join(root, "sounds"));
    const previousAudio = await Promise.all(
      previousFiles.map((file) => readFile(path.join(root, "sounds", file))),
    );
    saved.project.audio.tracks[0].trimEndMs = 1800;
    saved.project.audio.tracks.push({
      number: 2,
      name: "Invalid",
      path: source,
      trimEndMs: 5000,
      durationMs: 999999,
    });
    await expect(store.save(saved.project, filename)).rejects.toThrow(
      "actual audio duration",
    );
    expect(await readFile(filename, "utf8")).toBe(previousJSON);
    expect(await readdir(path.join(root, "sounds"))).toEqual(previousFiles);
    expect(
      await Promise.all(
        previousFiles.map((file) => readFile(path.join(root, "sounds", file))),
      ),
    ).toEqual(previousAudio);
    expect(
      (await readdir(root)).filter((file) =>
        file.startsWith(".cpc-project-save-"),
      ),
    ).toEqual([]);
  }, 30_000);
  it("exports a playable crop, rejects forged duration metadata, and preserves existing cards on conversion failure", async () => {
    const root = await folder();
    const source = path.join(root, "full.mp3");
    await promisify(execFile)(
      ffmpegPath!,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:a",
        "libmp3lame",
        source,
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const original = await readFile(source);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [
      {
        number: 1,
        name: "Clip",
        path: source,
        trimStartMs: 500,
        trimEndMs: 1500,
        durationMs: 999_999,
      },
    ];
    const card = path.join(root, "card");
    expect(await store.exportMedia(project, card)).toEqual({
      directory: card,
      files: 1,
    });
    const exported = path.join(card, "01", "001.mp3");
    expect(await probeAudioDurationMs(ffmpegPath!, exported)).toBeCloseTo(
      1000,
      0,
    );
    const previous = await readFile(exported);
    project.audio.tracks[0].trimStartMs = 0;
    project.audio.tracks[0].trimEndMs = 1800;
    project.audio.tracks.push({
      number: 2,
      name: "Invalid",
      path: source,
      trimEndMs: 5000,
      durationMs: 999_999,
    });
    await expect(store.exportMedia(project, card)).rejects.toThrow(
      "actual audio duration",
    );
    expect((await readFile(exported)).equals(previous)).toBe(true);
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(await readdir(card)).toEqual(["01"]);
    expect(await readdir(path.join(card, "01"))).toEqual(["001.mp3"]);
  }, 30_000);
  it("does not overwrite source media when the card destination aliases a source", async () => {
    const root = await folder();
    const card = path.join(root, "card");
    await mkdir(path.join(card, "01"), { recursive: true });
    const source = path.join(card, "01", "001.mp3");
    const content = "original source";
    await writeFile(source, content);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 1, name: "Original", path: source }];
    expect((await store.exportMedia(project, card)).files).toBe(1);
    project.audio.tracks[0].trimStartMs = 500;
    await expect(store.exportMedia(project, card)).rejects.toThrow(
      "must not replace a project source",
    );
    expect(await readFile(source, "utf8")).toBe(content);
  });
  it("preflights every source before touching existing card tracks", async () => {
    const root = await folder();
    const source = path.join(root, "first.mp3");
    await writeFile(source, "new track");
    const card = path.join(root, "card");
    await mkdir(path.join(card, "01"), { recursive: true });
    await writeFile(path.join(card, "01", "001.mp3"), "previous card track");
    const store = new ProjectStore();
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [
      { number: 1, name: "First", path: source },
      { number: 2, name: "Missing", path: path.join(root, "missing.mp3") },
    ];
    await expect(store.exportMedia(project, card)).rejects.toThrow(
      "imported MP3",
    );
    expect(await readFile(path.join(card, "01", "001.mp3"), "utf8")).toBe(
      "previous card track",
    );
  });
  it("saves a separate trimmed MP3 atomically without changing source or project settings", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    await promisify(execFile)(
      ffmpegPath!,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=2",
        "-c:a",
        "libmp3lame",
        source,
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const original = await readFile(source);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const track = {
      number: 1,
      name: "Trimmed",
      path: source,
      trimStartMs: 250,
      trimEndMs: 1250,
      durationMs: 2000,
    };
    const previousTrack = structuredClone(track);
    const destination = path.join(root, "my separate clip.mp3");
    await writeFile(destination, "old exported clip");
    expect(await store.saveTrimmedAudio(track, destination)).toEqual({
      path: destination,
    });
    expect(await probeAudioDurationMs(ffmpegPath!, destination)).toBeCloseTo(
      1000,
      0,
    );
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(track).toEqual(previousTrack);
    const savedClip = await readFile(destination);
    await expect(
      store.saveTrimmedAudio({ ...track, trimEndMs: 5000 }, destination),
    ).rejects.toThrow("actual audio duration");
    expect((await readFile(destination)).equals(savedClip)).toBe(true);
    await expect(store.saveTrimmedAudio(track, source)).rejects.toThrow(
      "separate file",
    );
    expect((await readFile(source)).equals(original)).toBe(true);
    expect(
      (await readdir(root)).filter((name) =>
        name.startsWith(".cpc-audio-save-"),
      ),
    ).toEqual([]);
  }, 30_000);
  it("retains separately saved draft clips in the saved project's sounds folder", async () => {
    const root = await folder();
    const source = path.join(root, "original.mp3");
    await mp3(source);
    const store = new ProjectStore({ ffmpegPath: ffmpegPath! });
    store.grantAudio(source);
    const project = createDefaultProject();
    project.audio.tracks = [{ number: 1, name: "Original", path: source }];
    const saved = await store.save(
      project,
      path.join(root, "project", "show.json"),
    );
    const beforeJSON = await readFile(saved.path, "utf8");
    const track = {
      ...saved.project.audio.tracks[0],
      trimStartMs: 500,
      trimEndMs: 1500,
    };
    const outside = path.join(root, "clip.mp3");
    const result = await store.saveTrimmedAudio(track, outside);
    expect(result.path).toBe(outside);
    expect(result.projectCopyPath).toMatch(
      /sounds[\\/]001-trim-[a-f0-9]{64}\.mp3$/,
    );
    expect(await readFile(result.projectCopyPath!)).toEqual(
      await readFile(outside),
    );
    expect(
      await probeAudioDurationMs(ffmpegPath!, result.projectCopyPath!),
    ).toBeCloseTo(1000, 0);
    const repeated = await store.saveTrimmedAudio(track, outside);
    expect(repeated.projectCopyPath).toBe(result.projectCopyPath);
    expect(await readdir(path.join(root, "project", "sounds"))).toHaveLength(2);
    expect(await readFile(saved.path, "utf8")).toBe(beforeJSON);
    const inside = path.join(root, "project", "sounds", "named clip.mp3");
    const insideResult = await store.saveTrimmedAudio(track, inside);
    expect(insideResult).toEqual({ path: inside, projectCopyPath: inside });
    expect(await probeAudioDurationMs(ffmpegPath!, inside)).toBeCloseTo(
      1000,
      0,
    );
    expect(await readdir(path.join(root, "project", "sounds"))).toHaveLength(3);
  }, 30_000);
});
