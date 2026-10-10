import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 256_000;

/** Decode the source rather than trusting editable project metadata or MP3 headers. */
export async function probeAudioDurationMs(
  ffmpegPath: string,
  source: string,
): Promise<number> {
  const result = await runFfmpeg(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-f",
      "s16le",
      "pipe:1",
    ],
    true,
  );
  // Count decoded samples without retaining PCM in memory. FFmpeg progress time
  // reports the start of the last packet, which can undercount by a whole frame.
  const durationMs = (result.stdoutBytes / 2 / 44100) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    throw new Error("The audio file has no decodable audio duration");
  return durationMs;
}

export interface TrimmedMp3Options {
  ffmpegPath: string;
  source: string;
  destination: string;
  startMs: number;
  endMs?: number | null;
}

/** Writes a new MP3; the source is never modified. Destination must be staging. */
export async function exportTrimmedMp3(options: TrimmedMp3Options) {
  const { ffmpegPath, source, destination, startMs } = options;
  const endMs = options.endMs ?? null;
  if (
    !Number.isFinite(startMs) ||
    startMs < 0 ||
    (endMs !== null && (!Number.isFinite(endMs) || endMs <= startMs))
  )
    throw new Error("Clip start and end must define a positive audio range");
  const durationMs = await probeAudioDurationMs(ffmpegPath, source);
  // One millisecond accommodates decimal rounding in the editor and decoder.
  if (startMs >= durationMs || (endMs !== null && endMs > durationMs + 1))
    throw new Error(
      `Clip range exceeds the actual audio duration (${(durationMs / 1000).toFixed(3)} seconds)`,
    );
  const trimEnd =
    endMs === null ? "" : `:end=${Math.min(endMs, durationMs) / 1000}`;
  await runFfmpeg(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-n",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    source,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-af",
    `atrim=start=${startMs / 1000}${trimEnd},asetpts=PTS-STARTPTS`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-id3v2_version",
    "3",
    destination,
  ]);
  if ((await stat(destination)).size === 0)
    throw new Error("Audio export produced an empty MP3");
  return { sourceDurationMs: durationMs };
}

function runFfmpeg(ffmpegPath: string, args: string[], countPcm = false) {
  return new Promise<{ stdout: string; stderr: string; stdoutBytes: number }>(
    (resolve, reject) => {
      const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let stdoutBytes = 0;
      let failure: Error | undefined;
      const timeout = setTimeout(() => {
        failure = new Error("Audio export timed out after two minutes");
        child.kill("SIGKILL");
      }, PROCESS_TIMEOUT_MS);
      const receive = (chunk: Buffer, stream: "stdout" | "stderr") => {
        if (stream === "stdout") {
          stdoutBytes += chunk.length;
          if (countPcm) return;
        }
        outputBytes += chunk.length;
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
          failure ??= new Error(
            "Audio decoder produced too much diagnostic output",
          );
          child.kill("SIGKILL");
          return;
        }
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => receive(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => receive(chunk, "stderr"));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Unable to start the bundled audio encoder: ${error.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              `Audio conversion failed: ${stderr.trim().slice(-2000) || `exit ${code}`}`,
            ),
          );
        else resolve({ stdout, stderr, stdoutBytes });
      });
    },
  );
}
