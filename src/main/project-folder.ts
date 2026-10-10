import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Project dialogs have their own location, independent of audio file dialogs. */
export class ProjectFolder {
  constructor(
    private settingsFile: string,
    private fallback: string,
  ) {}

  async get(currentProject?: string): Promise<string> {
    if (currentProject) {
      const current = path.dirname(currentProject);
      if (await isDirectory(current)) return current;
    }
    try {
      const settings = JSON.parse(await readFile(this.settingsFile, "utf8"));
      const directory = settings.projectDirectory;
      if (
        typeof directory === "string" &&
        path.isAbsolute(directory) &&
        (await isDirectory(directory))
      )
        return directory;
    } catch {
      // First launch, removed media, or damaged preferences: use Documents.
    }
    return this.fallback;
  }

  async remember(projectFile: string): Promise<void> {
    try {
      await mkdir(path.dirname(this.settingsFile), { recursive: true });
      const temporary = `${this.settingsFile}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ projectDirectory: path.dirname(path.resolve(projectFile)) })}\n`,
        "utf8",
      );
      await rename(temporary, this.settingsFile);
    } catch (error) {
      // A preferences write failure must not turn a successful scene save into
      // an apparent failure. currentPath still gives the right folder this run.
      console.warn("Could not remember the project folder:", error);
    }
  }
}

async function isDirectory(directory: string) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
