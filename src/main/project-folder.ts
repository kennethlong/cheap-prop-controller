import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface ProjectFolderOptions {
  documentsDirectory: string;
  appDirectory: string;
  isPackaged: boolean;
  projectsDirectory?: string;
  portableDirectory?: string;
}

/** Select locations without touching disk, so startup never creates folders. */
export function defaultProjectDirectories(
  options: ProjectFolderOptions,
): string[] {
  const fallback = path.join(
    options.documentsDirectory,
    "Cheap Prop Controller",
    "Projects",
  );
  const preferred =
    options.projectsDirectory && path.isAbsolute(options.projectsDirectory)
      ? options.projectsDirectory
      : !options.isPackaged
        ? path.join(options.appDirectory, "projects")
        : options.portableDirectory &&
            path.isAbsolute(options.portableDirectory)
          ? path.join(options.portableDirectory, "projects")
          : fallback;
  // Documents itself was the old default; never create new projects there.
  return [preferred, fallback].filter(
    (directory, index, candidates) =>
      !sameDirectory(directory, options.documentsDirectory) &&
      !candidates
        .slice(0, index)
        .some((other) => sameDirectory(other, directory)),
  );
}

/** Project dialogs have their own location, independent of audio file dialogs. */
export class ProjectFolder {
  constructor(
    private settingsFile: string,
    private options: ProjectFolderOptions,
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
        !sameDirectory(directory, this.options.documentsDirectory) &&
        (await isDirectory(directory))
      )
        return directory;
    } catch {
      // First launch, removed media, or damaged preferences: choose a default.
    }
    const candidates = defaultProjectDirectories(this.options);
    for (const directory of candidates) {
      try {
        await assertWritableDirectory(directory);
        return directory;
      } catch {
        // Installed apps and removable drives may not permit project writes.
      }
    }
    throw new Error(
      `Could not create a writable project folder. Tried: ${candidates.join(
        "; ",
      )}. Check folder permissions, or set CPC_PROJECTS_DIRECTORY to an absolute path in a writable folder.`,
    );
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

function sameDirectory(left: string, right: string) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function assertWritableDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.cpc-write-check-${randomUUID()}.tmp`);
  const file = await open(probe, "wx");
  try {
    await file.writeFile("Project folder write check\n", "utf8");
  } finally {
    try {
      await file.close();
    } finally {
      await unlink(probe);
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
