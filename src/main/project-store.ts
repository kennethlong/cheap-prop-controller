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
    const directory = path.dirname(filename);
    const assetDirectory = path.join(directory, "sounds");
    // Immutable, content-addressed assets keep a failed save from changing audio
    // referenced by the previous project. Read all originals, then stage every
    // conversion before installing assets or replacing the project document.
    const assets: AudioAsset[] = [];
    const trims: Array<{ track: MediaTrack; original: AudioAsset }> = [];
    for (const track of project.audio.tracks) {
      delete track.trimmedPath;
      if (!track.path) continue;
      const source = this.resolveAudio(track.path);
      if (!this.grantedAudio.has(source))
        throw new Error(
          `Import the audio file for track ${track.number} before saving`,
        );
      if ((await accessFile(source)).size > 80_000_000)
        throw new Error(`Track ${track.number} exceeds the 80 MB media limit`);
      const content = await readFile(source);
      const asset = audioAsset(
        assetDirectory,
        String(track.number).padStart(3, "0"),
        path.extname(source).toLowerCase(),
        content,
      );
      assets.push(asset);
      track.path = `sounds/${path.basename(asset.destination)}`;
      if ((track.trimStartMs ?? 0) > 0 || track.trimEndMs != null) {
        if (path.extname(source).toLowerCase() !== ".mp3")
          throw new Error("Trimmed project audio needs an imported MP3 file");
        if (!this.options.ffmpegPath)
          throw new Error(
            "The bundled audio encoder is missing; rebuild or reinstall the application",
          );
        trims.push({ track, original: asset });
      }
    }
    await ensureDirectory(directory);
    const staging = await mkdtemp(path.join(directory, ".cpc-project-save-"));
    try {
      for (let index = 0; index < trims.length; index++) {
        const { track, original } = trims[index];
        const source = path.join(staging, `${index}-original.mp3`);
        const temporaryClip = path.join(staging, `${index}-clip.mp3`);
        await writeFile(source, original.content);
        await exportTrimmedMp3({
          ffmpegPath: this.options.ffmpegPath!,
          source,
          destination: temporaryClip,
          startMs: track.trimStartMs ?? 0,
          endMs: track.trimEndMs,
        });
        const clip = audioAsset(
          assetDirectory,
          `${String(track.number).padStart(3, "0")}-trim`,
          ".mp3",
          await readFile(temporaryClip),
        );
        assets.push(clip);
        track.trimmedPath = `sounds/${path.basename(clip.destination)}`;
      }
      // Keep the folder present even for a scene with no imported audio yet.
      await mkdir(assetDirectory, { recursive: true });
      for (const asset of assets) await installAudioAsset(asset);
      const temporary = path.join(staging, "project.json");
      await writeFile(
        temporary,
        `${JSON.stringify(project, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, filename);
    } finally {
      await removeStaging(staging, directory, ".cpc-project-save-");
    }
    for (const track of project.audio.tracks)
      if (track.path)
        this.grantedAudio.add(path.resolve(directory, track.path));
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
    await ensureDirectory(directory);
    const staging = await mkdtemp(path.join(directory, ".cpc-audio-save-"));
    let projectCopyPath: string | undefined;
    try {
      const temporary = path.join(staging, "clip.mp3");
      await exportTrimmedMp3({
        ffmpegPath: this.options.ffmpegPath,
        source,
        destination: temporary,
        startMs: track.trimStartMs ?? 0,
        endMs: track.trimEndMs,
      });
      const clipContent = await readFile(temporary);
      // Generated names can be referenced by other saved scenes in the same
      // folder. Only allow an identical re-export over an immutable asset.
      const savedDigest = path
        .basename(destination)
        .match(/^\d{3}-(?:trim-)?([a-f0-9]{64})\.mp3$/i)?.[1];
      if (
        targetInfo &&
        savedDigest &&
        createHash("sha256").update(clipContent).digest("hex") !==
          savedDigest.toLowerCase()
      )
        throw new Error(
          "Choose a different clip filename; saved project sounds must not be overwritten",
        );
      if (this.currentPath) {
        const sounds = path.join(path.dirname(this.currentPath), "sounds");
        const clip = audioAsset(
          sounds,
          `${String(track.number).padStart(3, "0")}-trim`,
          ".mp3",
          clipContent,
        );
        await mkdir(sounds, { recursive: true });
        if (path.resolve(directory) === path.resolve(sounds)) {
          // The selected file already lives in sounds, so one copy is enough.
          projectCopyPath = destination;
        } else {
          await installAudioAsset(clip);
          projectCopyPath = clip.destination;
        }
      }
      await rename(temporary, destination);
    } finally {
      await removeStaging(staging, directory, ".cpc-audio-save-");
    }
    return {
      path: destination,
      ...(projectCopyPath ? { projectCopyPath } : {}),
    };
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
    await ensureDirectory(directory);
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
interface AudioAsset {
  destination: string;
  content: Buffer;
  digest: string;
}
function audioAsset(
  directory: string,
  prefix: string,
  extension: string,
  content: Buffer,
): AudioAsset {
  const digest = createHash("sha256").update(content).digest("hex");
  return {
    destination: path.join(directory, `${prefix}-${digest}${extension}`),
    content,
    digest,
  };
}
async function installAudioAsset(asset: AudioAsset) {
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
}
async function ensureDirectory(directory: string) {
  // Windows rejects mkdir on an existing drive root, even with recursive:true.
  // Reuse existing directories, but preserve real permission and device errors.
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true });
    return;
  }
  if (!info.isDirectory())
    throw new Error("The destination is not a directory");
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
