import {
  readFile,
  writeFile,
  rename,
  mkdir,
  copyFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProject } from "../shared/index";
import type { SceneProject } from "../shared/model";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
export class ProjectStore {
  currentPath?: string;
  private grantedAudio = new Set<string>();
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
  async exportMedia(value: unknown, directory: string) {
    const project: SceneProject = parseProject(value);
    const files = project.audio.tracks.filter((track) => track.path);
    if (!files.length) throw new Error("Import at least one MP3 first");
    if (new Set(files.map((track) => track.number)).size !== files.length)
      throw new Error("Each exported track must have a unique number");
    // Validate the entire export before copying anything.
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
        await accessFile(source);
        return { source, name: `${String(track.number).padStart(3, "0")}.mp3` };
      }),
    );
    const folder = path.join(directory, "01");
    await mkdir(folder, { recursive: true });
    for (const file of sources) {
      const destination = path.join(folder, file.name);
      const sourceInfo = await stat(file.source);
      let sameFile = false;
      try {
        const targetInfo = await stat(destination);
        sameFile =
          sourceInfo.dev === targetInfo.dev &&
          sourceInfo.ino === targetInfo.ino;
      } catch {
        /* Destination does not exist yet. */
      }
      if (!sameFile) await copyFile(file.source, destination);
    }
    return { directory, files: sources.length };
  }
}
async function accessFile(filename: string) {
  const info = await stat(filename);
  if (!info.isFile()) throw new Error("Audio source is not a file");
}
