import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

if (!ffmpegPath) throw new Error("No bundled audio encoder for this platform");
const directory = path.resolve("resources/ffmpeg");
await mkdir(directory, { recursive: true });
const executable = path.join(directory, path.basename(ffmpegPath));
await copyFile(ffmpegPath, executable);
if (process.platform !== "win32") await chmod(executable, 0o755);
// Keep the binary distributor's license and build/source information with it.
for (const suffix of [".LICENSE", ".README"])
  await copyFile(`${ffmpegPath}${suffix}`, `${executable}${suffix}`);
