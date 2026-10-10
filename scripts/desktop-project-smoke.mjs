import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const source = process.argv[2];
const executable = process.argv[3];
if (!source)
  throw new Error("Pass the path to a local MP3 for this desktop media test");
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/project-smoke-"));
const filename = path.join(directory, "portable-scene.cpc.json");
const exportDirectory = path.join(directory, "card");
const settingsFile = path.join(directory, "project-folder.json");
await mkdir(exportDirectory, { recursive: true });
const launchOptions = {
  ...(executable ? { executablePath: path.resolve(executable) } : {}),
  args: executable ? ["--mute-audio"] : [".", "--mute-audio"],
  env: {
    ...process.env,
    CPC_TEST_HIDDEN: "1",
    CPC_TEST_SETTINGS_FILE: settingsFile,
  },
};
const desktop = await electron.launch(launchOptions);
const page = await desktop.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await desktop.evaluate(
    ({ dialog }, files) => {
      globalThis.__cpcProjectOpenDefaults = [];
      dialog.showOpenDialog = async (_window, options) => {
        if (options.title === "Open scene project")
          globalThis.__cpcProjectOpenDefaults.push(options.defaultPath);
        return {
          canceled: false,
          filePaths: [
            options.title.includes("MP3 card")
              ? files.exportDirectory
              : options.title.includes("Choose MP3")
                ? files.source
                : files.filename,
          ],
        };
      };
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: files.filename,
      });
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    { source: path.resolve(source), filename, exportDirectory },
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByRole("button", { name: "Add MP3", exact: true }).click();
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByLabel("Ambient track", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  const project = JSON.parse(await readFile(filename, "utf8"));
  expect(path.isAbsolute(project.audio.tracks[0].path)).toBe(false);
  expect(project.audio.tracks[0].path.replaceAll("\\", "/")).toMatch(
    /^sounds\/[^/]+\.mp3$/,
  );
  expect((await stat(path.join(directory, "sounds"))).isDirectory()).toBe(true);
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  const originalDigest = digest(await readFile(source));
  expect(
    digest(await readFile(path.join(directory, project.audio.tracks[0].path))),
  ).toBe(originalDigest);
  await page
    .getByRole("button", { name: "Export files for MP3 cards", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Exported 1 files");
  expect(
    digest(await readFile(path.join(exportDirectory, "01", "001.mp3"))),
  ).toBe(originalDigest);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Midnight workshop",
  );
  expect(
    await desktop.evaluate(() => globalThis.__cpcProjectOpenDefaults.at(-1)),
  ).toBe(directory);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    projectDirectory: directory,
  });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await expect(
    page.getByLabel("Audio waveform", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  const failedDirectory = path.join(directory, "invalid-project");
  await mkdir(failedDirectory);
  const failedFilename = path.join(failedDirectory, "invalid.cpc.json");
  await writeFile(failedFilename, "{ invalid JSON }");
  const rememberedSettings = await readFile(settingsFile, "utf8");
  const reopened = await electron.launch(launchOptions);
  try {
    const reopenedPage = await reopened.firstWindow();
    await reopened.evaluate(({ dialog }, invalidPath) => {
      globalThis.__cpcStartupOpenDefaults = [];
      globalThis.__cpcCancelOpen = true;
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.__cpcStartupOpenDefaults.push(options.defaultPath);
        return {
          canceled: globalThis.__cpcCancelOpen,
          filePaths: [invalidPath],
        };
      };
    }, failedFilename);
    await reopenedPage
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await expect
      .poll(() =>
        reopened.evaluate(() => globalThis.__cpcStartupOpenDefaults.at(-1)),
      )
      .toBe(directory);
    expect(await readFile(settingsFile, "utf8")).toBe(rememberedSettings);
    await reopened.evaluate(() => {
      globalThis.__cpcCancelOpen = false;
    });
    await reopenedPage
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await expect(reopenedPage.getByRole("alert")).toContainText(
      "Could not open",
    );
    expect(await readFile(settingsFile, "utf8")).toBe(rememberedSettings);
    await reopened.evaluate(() => {
      globalThis.__cpcCancelOpen = true;
    });
    await reopenedPage
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await expect
      .poll(() =>
        reopened.evaluate(() => globalThis.__cpcStartupOpenDefaults.length),
      )
      .toBe(3);
    expect(
      await reopened.evaluate(() => globalThis.__cpcStartupOpenDefaults),
    ).toEqual([directory, directory, directory]);
  } finally {
    await reopened.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    });
    await reopened.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    "artifacts/desktop-project-results.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "Real MP3 decode",
          "Project sounds folder and relative MP3 path",
          "Media bytes preserved",
          "Numbered SD export",
          "New/open round trip",
          "Audio reload from saved relative path",
          "Waveform and muted playback",
          "Open defaults to project root after audio import and SD export",
          "Fresh app remembers project root independently of file dialogs",
          "Canceled Open and invalid project preserve remembered root",
        ],
        executable: executable
          ? path.resolve(executable)
          : "development Electron",
        directory,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("Desktop project and audio round trip passed.");
} finally {
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  });
  await desktop.close();
}
