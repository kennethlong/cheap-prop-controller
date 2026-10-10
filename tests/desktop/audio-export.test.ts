import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import {
  exportTrimmedMp3,
  probeAudioDurationMs,
} from "../../src/main/audio-export";

const execute = promisify(execFile);
const temporary: string[] = [];
const binary = ffmpegPath ?? "";
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    const resolved = path.resolve(folder);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cpc-audio-test-")
    )
      throw new Error("Refusing to clean an unexpected test path");
    await rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpc-audio-test-"));
  temporary.push(root);
  const source = path.join(root, "source with spaces.mp3");
  await execute(
    binary,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1320:duration=1",
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      source,
    ],
    { windowsHide: true, timeout: 20_000 },
  );
  return { root, source };
}
function frequency(
  samples: Buffer,
  startSeconds: number,
  durationSeconds: number,
) {
  const start = Math.floor(startSeconds * 44100);
  const end = Math.min(
    samples.length / 2 - 1,
    Math.floor((startSeconds + durationSeconds) * 44100),
  );
  let crossings = 0;
  for (let i = start; i < end; i++) {
    if (samples.readInt16LE(i * 2) <= 0 && samples.readInt16LE((i + 1) * 2) > 0)
      crossings++;
  }
  return crossings / ((end - start) / 44100);
}
describe("physical MP3 clip export", () => {
  it("decodes, crops exact source content, and exports an independent playable MP3", async () => {
    const { root, source } = await fixture();
    const original = await readFile(source);
    expect(await probeAudioDurationMs(binary, source)).toBeCloseTo(3000, 0);
    const destination = path.join(root, "clip.mp3");
    await exportTrimmedMp3({
      ffmpegPath: binary,
      source,
      destination,
      startMs: 1000,
      endMs: 2500,
    });
    expect(await probeAudioDurationMs(binary, destination)).toBeCloseTo(
      1500,
      0,
    );
    const decoded = path.join(root, "clip.pcm");
    await execute(
      binary,
      [
        "-v",
        "error",
        "-i",
        destination,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "44100",
        decoded,
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const samples = await readFile(decoded);
    expect(frequency(samples, 0.1, 0.3)).toBeCloseTo(880, -1);
    expect(frequency(samples, 1.1, 0.3)).toBeCloseTo(1320, -1);
    expect((await readFile(source)).equals(original)).toBe(true);
  }, 30_000);
  it("trims through actual EOF and rejects invalid or out-of-source ranges", async () => {
    const { root, source } = await fixture();
    const destination = path.join(root, "tail.mp3");
    await exportTrimmedMp3({
      ffmpegPath: binary,
      source,
      destination,
      startMs: 2000,
    });
    expect(await probeAudioDurationMs(binary, destination)).toBeCloseTo(
      1000,
      0,
    );
    await expect(
      exportTrimmedMp3({
        ffmpegPath: binary,
        source,
        destination: path.join(root, "invalid.mp3"),
        startMs: 4000,
      }),
    ).rejects.toThrow("actual audio duration");
    await expect(
      exportTrimmedMp3({
        ffmpegPath: binary,
        source,
        destination: path.join(root, "invalid.mp3"),
        startMs: 0,
        endMs: 4000,
      }),
    ).rejects.toThrow("actual audio duration");
    await expect(
      exportTrimmedMp3({
        ffmpegPath: binary,
        source,
        destination: path.join(root, "invalid.mp3"),
        startMs: 1000,
        endMs: 500,
      }),
    ).rejects.toThrow("positive audio range");
  }, 30_000);
  it("reports corrupt audio and missing encoder without producing card files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpc-audio-test-"));
    temporary.push(root);
    const source = path.join(root, "bad.mp3");
    await writeFile(source, "not an MP3");
    await expect(probeAudioDurationMs(binary, source)).rejects.toThrow(
      "conversion failed",
    );
    await expect(
      probeAudioDurationMs(path.join(root, "missing-ffmpeg.exe"), source),
    ).rejects.toThrow("Unable to start");
  });
});
