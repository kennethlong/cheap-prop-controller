import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultProjectDirectories,
  ProjectFolder,
  type ProjectFolderOptions,
} from "../../src/main/project-folder";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("cpc-folder-test-")
    )
      throw new Error(
        "Refusing to remove a path outside the test temporary folder",
      );
    await rm(resolved, { recursive: true, force: true });
  }
});

function options(
  root = path.resolve("project-folder-policy"),
): ProjectFolderOptions {
  return {
    documentsDirectory: path.join(root, "Documents"),
    appDirectory: path.join(root, "application"),
    isPackaged: false,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpc-folder-test-"));
  temporary.push(root);
  const settingsFile = path.join(root, "preferences", "project-folder.json");
  const configuration = options(root);
  const preferred = path.join(configuration.appDirectory, "projects");
  const fallback = path.join(
    configuration.documentsDirectory,
    "Cheap Prop Controller",
    "Projects",
  );
  const create = () => new ProjectFolder(settingsFile, configuration);
  return { root, settingsFile, configuration, preferred, fallback, create };
}

describe("default project folder policy", () => {
  it("prefers an absolute override before development or portable defaults", () => {
    const configuration = options();
    const override = path.join(configuration.appDirectory, "custom-scenes");
    for (const isPackaged of [false, true]) {
      expect(
        defaultProjectDirectories({
          ...configuration,
          isPackaged,
          projectsDirectory: override,
          portableDirectory: path.join(configuration.appDirectory, "portable"),
        }),
      ).toEqual([
        override,
        path.join(
          configuration.documentsDirectory,
          "Cheap Prop Controller",
          "Projects",
        ),
      ]);
    }
  });

  it("uses the repository projects directory in development and ignores relative overrides", () => {
    const configuration = options();
    expect(
      defaultProjectDirectories({
        ...configuration,
        projectsDirectory: "relative-scenes",
      })[0],
    ).toBe(path.join(configuration.appDirectory, "projects"));
  });

  it("uses the portable executable directory rather than its extraction directory", () => {
    const configuration = options();
    const portableDirectory = path.join(
      configuration.documentsDirectory,
      "portable-controller",
    );
    expect(
      defaultProjectDirectories({
        ...configuration,
        isPackaged: true,
        portableDirectory,
      })[0],
    ).toBe(path.join(portableDirectory, "projects"));
  });

  it.each([undefined, "relative-portable"])(
    "uses a dedicated Documents folder for installed apps (%s)",
    (portableDirectory) => {
      const configuration = options();
      expect(
        defaultProjectDirectories({
          ...configuration,
          isPackaged: true,
          portableDirectory,
        }),
      ).toEqual([
        path.join(
          configuration.documentsDirectory,
          "Cheap Prop Controller",
          "Projects",
        ),
      ]);
    },
  );

  it("does not use raw Documents even if an override points there", () => {
    const configuration = options();
    expect(
      defaultProjectDirectories({
        ...configuration,
        projectsDirectory: configuration.documentsDirectory,
      }),
    ).toEqual([
      path.join(
        configuration.documentsDirectory,
        "Cheap Prop Controller",
        "Projects",
      ),
    ]);
  });
});

describe("project dialog folder persistence", () => {
  it("creates the selected default lazily and removes its write probe", async () => {
    const test = await fixture();
    const folders = test.create();
    await expect(stat(test.preferred)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await folders.get()).toBe(test.preferred);
    expect(await readdir(test.preferred)).toEqual([]);
    await expect(stat(test.fallback)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(test.settingsFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("falls back to a dedicated Documents folder if the preferred location cannot be created", async () => {
    const test = await fixture();
    await mkdir(test.configuration.appDirectory);
    await writeFile(test.preferred, "Do not overwrite this existing file");
    expect(await test.create().get()).toBe(test.fallback);
    expect(await readdir(test.fallback)).toEqual([]);
    expect(await readFile(test.preferred, "utf8")).toBe(
      "Do not overwrite this existing file",
    );
  });

  it("reports both failed locations and how to select a writable directory", async () => {
    const test = await fixture();
    await writeFile(
      test.configuration.appDirectory,
      "blocked application directory",
    );
    await writeFile(
      test.configuration.documentsDirectory,
      "blocked Documents directory",
    );
    await expect(test.create().get()).rejects.toThrow(
      "Could not create a writable project folder",
    );
    await expect(test.create().get()).rejects.toThrow(test.preferred);
    await expect(test.create().get()).rejects.toThrow(test.fallback);
    await expect(test.create().get()).rejects.toThrow("CPC_PROJECTS_DIRECTORY");
  });

  it("preserves a remembered custom directory across instances without creating defaults", async () => {
    const test = await fixture();
    const custom = path.join(test.root, "custom-shows");
    await mkdir(custom);
    await test.create().remember(path.join(custom, "show.cpc.json"));
    expect(await test.create().get()).toBe(custom);
    await expect(stat(test.preferred)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(test.fallback)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prefers the current project's directory over remembered and default paths", async () => {
    const test = await fixture();
    const custom = path.join(test.root, "remembered");
    const current = path.join(test.root, "active");
    await mkdir(custom);
    await mkdir(current);
    const folders = test.create();
    await folders.remember(path.join(custom, "show.cpc.json"));
    expect(await folders.get(path.join(current, "current.cpc.json"))).toBe(
      current,
    );
    expect(
      await folders.get(path.join(test.root, "missing", "old.cpc.json")),
    ).toBe(custom);
  });

  it("ignores the old Documents-root preference but preserves an active scene there", async () => {
    const test = await fixture();
    await mkdir(test.configuration.documentsDirectory);
    const currentProject = path.join(
      test.configuration.documentsDirectory,
      "existing.cpc.json",
    );
    await writeFile(currentProject, "Existing project");
    await test.create().remember(currentProject);
    expect(await test.create().get(currentProject)).toBe(
      test.configuration.documentsDirectory,
    );
    await expect(stat(test.preferred)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await test.create().get()).toBe(test.preferred);
    expect(await readFile(currentProject, "utf8")).toBe("Existing project");
  });

  it.each(["missing", "file", "relative", "malformed"])(
    "replaces a %s remembered location with the selected default",
    async (kind) => {
      const test = await fixture();
      await mkdir(path.dirname(test.settingsFile));
      const target = path.join(test.root, "previous-directory");
      if (kind === "file") await writeFile(target, "This is not a directory");
      await writeFile(
        test.settingsFile,
        kind === "malformed"
          ? "{invalid"
          : JSON.stringify({
              projectDirectory:
                kind === "relative" ? "previous-directory" : target,
            }),
      );
      expect(await test.create().get()).toBe(test.preferred);
    },
  );
});
