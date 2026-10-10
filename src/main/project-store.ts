import {
  readFile,
  writeFile,
  rename,
  mkdir,
  copyFile,
  stat,
  mkdtemp,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProject } from "../shared/index";
import type { MediaTrack, SceneProject } from "../shared/model";
import { exportTrimmedMp3 } from "./audio-export";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
export class ProjectStore {
  currentPath?: string;
  private grantedAudio = new Set<string>();
  constructor(private options: { ffmpegPath?: string } = {}) {}
  private resolveAudio(value: string): string {
    if (path.isAbsolute(value)) return path.resolve(value);
    if (!this.currentPath)
      throw new Error(
        "Save or open the project before loading relative audio files",
      );
    const base = path.dirname(this.currentPath);
    const resolved = path.resolve(base, value);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Audio path must stay inside the project folder");
    return resolved;
  }
  grantAudio(filename: string) {
    if (!AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase()))
      throw new Error("Choose a supported audio file");
    this.grantedAudio.add(path.resolve(filename));
  }
  async open(filename: string) {
    if ((await stat(filename)).size > 2_000_000)
      throw new Error("Project file is too large");
    const project = parseProject(JSON.parse(await readFile(filename, "utf8")));
    this.currentPath = filename;
    this.grantedAudio.clear();
    for (const track of project.audio.tracks) {
      if (track.path) {
        try {
          this.grantAudio(this.resolveAudio(track.path));
        } catch {
          /* Invalid/missing media cannot escape the media read boundary. */
        }
      }
    }
    return { project, path: filename };
  }
  async save(value: unknown, filename: string) {
    const project = structuredClone(parseProject(value));
    const assetName = `${path.basename(filename, path.extname(filename))}.assets`;
    const assetDirectory = path.join(path.dirname(filename), assetName);
    // Immutable, content-addressed assets keep a failed save from changing audio
    // referenced by the previous project. Preflight every source before writing.
    const assets: Array<{
      destination: string;
      content: Buffer;
      digest: string;
    }> = [];
    for (const track of project.audio.tracks) {
      if (!track.path) continue;
      const source = this.resolveAudio(track.path);
      if (!this.grantedAudio.has(source))
        throw new Error(
          `Import the audio file for track ${track.number} before saving`,
        );
      if ((await stat(source)).size > 80_000_000)
        throw new Error(`Track ${track.number} exceeds the 80 MB media limit`);
      const content = await readFile(source);
      const digest = createHash("sha256").update(content).digest("hex");
      const destination = path.join(
        assetDirectory,
        `${String(track.number).padStart(3, "0")}-${digest}${path.extname(source).toLowerCase()}`,
      );
      assets.push({ destination, content, digest });
      track.path = `${assetName}/${path.basename(destination)}`;
    }
    if (assets.length) await mkdir(assetDirectory, { recursive: true });
    for (const asset of assets) {
      try {
        await writeFile(asset.destination, asset.content, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (
          createHash("sha256")
            .update(await readFile(asset.destination))
            .digest("hex") !== asset.digest
        )
          throw new Error(
            "A saved audio asset was modified outside the application. Choose Save As to preserve both versions.",
          );
      }
      this.grantedAudio.add(asset.destination);
    }
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await rename(temporary, filename);
    this.currentPath = filename;
    return { project, path: filename };
  }
  async readAudio(value: string) {
    if (typeof value !== "string") throw new Error("Invalid audio path");
    const filename = this.resolveAudio(value);
    if (!this.grantedAudio.has(filename))
      throw new Error("Audio file was not imported into this project");
    if ((await stat(filename)).size > 80_000_000)
      throw new Error("Audio preview supports files up to 80 MB");
    const types: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".flac": "audio/flac",
    };
    const mime = types[path.extname(filename).toLowerCase()];
    if (!mime) throw new Error("Unsupported audio file type");
    return {
      dataUrl: `data:${mime};base64,${(await readFile(filename)).toString("base64")}`,
    };
  }
  async saveTrimmedAudio(track: MediaTrack, destination: string) {
    if (!track || typeof track.path !== "string" || !track.path)
      throw new Error("Import an MP3 before saving an audio clip");
    const source = this.resolveAudio(track.path);
    if (
      !this.grantedAudio.has(source) ||
      path.extname(source).toLowerCase() !== ".mp3"
    )
      throw new Error("Import an MP3 before saving an audio clip");
    if (path.extname(destination).toLowerCase() !== ".mp3")
      throw new Error("Save the audio clip with an .mp3 extension");
    if (!this.options.ffmpegPath)
      throw new Error(
        "The bundled audio encoder is missing; rebuild or reinstall the application",
      );
    if ((await accessFile(source)).size > 80_000_000)
      throw new Error("Audio clips support source files up to 80 MB");
    let targetInfo;
    try {
      targetInfo = await stat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (targetInfo) {
      if (!targetInfo.isFile())
        throw new Error("The audio clip destination is not a file");
      for (const granted of this.grantedAudio) {
        let originalInfo;
        try {
          originalInfo = await stat(granted);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (
          originalInfo &&
          originalInfo.dev === targetInfo.dev &&
          originalInfo.ino === targetInfo.ino
        )
          throw new Error(
            "Save the clip as a separate file; the original audio must not be overwritten",
          );
      }
    }
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(path.join(directory, ".cpc-audio-save-"));
    try {
      const temporary = path.join(staging, "clip.mp3");
      await exportTrimmedMp3({
        ffmpegPath: this.options.ffmpegPath,
        source,
        destination: temporary,
        startMs: track.trimStartMs ?? 0,
        endMs: track.trimEndMs,
      });
      await rename(temporary, destination);
    } finally {
      await removeStaging(staging, directory, ".cpc-audio-save-");
    }
    return { path: destination };
  }
  async exportMedia(value: unknown, directory: string) {
    const project: SceneProject = parseProject(value);
    const files = project.audio.tracks.filter((track) => track.path);
    if (!files.length) throw new Error("Import at least one MP3 first");
    if (new Set(files.map((track) => track.number)).size !== files.length)
      throw new Error("Each exported track must have a unique number");
    const folder = path.join(directory, "01");
    // Resolve every source before writing, and keep export away from project assets.
    const sources = await Promise.all(
      files.map(async (track) => {
        const source = this.resolveAudio(track.path!);
        if (
          !this.grantedAudio.has(source) ||
          path.extname(source).toLowerCase() !== ".mp3"
        )
          throw new Error(
            `Track ${track.number} needs an imported MP3 file for hardware playback`,
          );
        if (
          !Number.isInteger(track.number) ||
          track.number < 1 ||
          track.number > 255
        )
          throw new Error("Hardware track numbers must be between 1 and 255");
        const sourceInfo = await accessFile(source);
        if (sourceInfo.size > 80_000_000)
          throw new Error(
            `Track ${track.number} exceeds the 80 MB media limit`,
          );
        const startMs = track.trimStartMs ?? 0;
        const endMs = track.trimEndMs ?? null;
        if (
          !Number.isFinite(startMs) ||
          startMs < 0 ||
          (endMs !== null && (!Number.isFinite(endMs) || endMs <= startMs))
        )
          throw new Error(`Track ${track.number} has an invalid clip range`);
        return {
          source,
          sourceInfo,
          name: `${String(track.number).padStart(3, "0")}.mp3`,
          startMs,
          endMs,
          trimmed: startMs > 0 || endMs !== null,
          skip: false,
        };
      }),
    );
    if (sources.some((file) => file.trimmed) && !this.options.ffmpegPath)
      throw new Error(
        "The bundled audio encoder is missing; rebuild or reinstall the application",
      );
    for (const file of sources) {
      const destination = path.join(folder, file.name);
      let targetInfo;
      try {
        targetInfo = await stat(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!targetInfo) continue;
      if (!targetInfo.isFile())
        throw new Error(`The export destination ${file.name} is not a file`);
      const sameSource = sources.find(
        (source) =>
          source.sourceInfo.dev === targetInfo.dev &&
          source.sourceInfo.ino === targetInfo.ino,
      );
      if (sameSource) {
        if (
          !file.trimmed &&
          file.sourceInfo.dev === targetInfo.dev &&
          file.sourceInfo.ino === targetInfo.ino
        )
          file.skip = true;
        else
          throw new Error(
            "Choose an export folder outside the original audio files; exporting must not replace a project source",
          );
      }
    }
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(path.join(directory, ".cpc-export-"));
    try {
      // Encode/copy the entire set before replacing even one existing card track.
      for (const file of sources) {
        if (file.skip) continue;
        const destination = path.join(staging, file.name);
        if (file.trimmed)
          await exportTrimmedMp3({
            ffmpegPath: this.options.ffmpegPath!,
            source: file.source,
            destination,
            startMs: file.startMs,
            endMs: file.endMs,
          });
        else await copyFile(file.source, destination);
      }
      await mkdir(folder, { recursive: true });
      // Each replacement is atomic. A filesystem failure here can leave a partial
      // set; encoding/validation failures above never change existing card tracks.
      for (const file of sources) {
        if (!file.skip)
          await rename(
            path.join(staging, file.name),
            path.join(folder, file.name),
          );
      }
    } finally {
      await removeStaging(staging, directory, ".cpc-export-");
    }
    return { directory, files: sources.length };
  }
}
async function accessFile(filename: string) {
  const info = await stat(filename);
  if (!info.isFile()) throw new Error("Audio source is not a file");
  return info;
}
async function removeStaging(
  staging: string,
  directory: string,
  prefix: string,
) {
  const resolved = path.resolve(staging);
  if (
    path.dirname(resolved) !== path.resolve(directory) ||
    !path.basename(resolved).startsWith(prefix)
  )
    throw new Error("Refusing to clean up an unexpected audio staging folder");
  await rm(resolved, { recursive: true, force: true });
}
