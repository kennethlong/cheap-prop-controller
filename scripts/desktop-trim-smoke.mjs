import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const executable = process.argv[2]?.startsWith("--")
  ? undefined
  : process.argv[2];
const visible = process.argv.includes("--visible");
const execute = promisify(execFile);
if (!ffmpegPath)
  throw new Error("Install ffmpeg-static before running the trim smoke test");
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/trim-smoke-"));
const source = path.join(directory, "Eight second original.mp3");
const trimmed = path.join(directory, "Separate trimmed clip.mp3");
const filename = path.join(directory, "trimmed-scene.cpc.json");
const exportDirectory = path.join(directory, "card");
await mkdir(exportDirectory);
await execute(
  ffmpegPath,
  [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    source,
  ],
  { windowsHide: true, timeout: 20_000 },
);
const digest = (data) => createHash("sha256").update(data).digest("hex");
const originalDigest = digest(await readFile(source));
async function decodedDuration(file) {
  const result = await execute(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "44100",
      "pipe:1",
    ],
    {
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 8_000_000,
      timeout: 20_000,
    },
  );
  return result.stdout.length / 2 / 44100;
}
const desktop = await electron.launch({
  ...(executable ? { executablePath: path.resolve(executable) } : {}),
  args: executable ? ["--mute-audio"] : [".", "--mute-audio"],
  env: {
    ...process.env,
    CPC_TEST_HIDDEN: visible ? "0" : "1",
    CPC_TEST_SETTINGS_FILE: path.join(directory, "project-folder.json"),
  },
});
const errors = [];
const checks = [];
let screenshot;
try {
  const version = await desktop.evaluate(({ app }) => app.getVersion());
  expect(version).toBe("0.4.0");
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await desktop.evaluate(
    ({ dialog }, files) => {
      globalThis.__cpcTrimSaveDefaults = [];
      globalThis.__cpcProjectSaveCalls = 0;
      globalThis.__cpcCancelNextProjectSave = true;
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: [
          options.title.includes("MP3 card")
            ? files.exportDirectory
            : options.title.includes("Choose MP3")
              ? files.source
              : files.filename,
        ],
      });
      dialog.showSaveDialog = async (_window, options) => {
        if (options.title === "Save trimmed MP3")
          globalThis.__cpcTrimSaveDefaults.push(options.defaultPath);
        else {
          globalThis.__cpcProjectSaveCalls += 1;
          if (globalThis.__cpcCancelNextProjectSave) {
            globalThis.__cpcCancelNextProjectSave = false;
            return { canceled: true };
          }
        }
        return {
          canceled: false,
          filePath:
            options.title === "Save trimmed MP3"
              ? files.trimmed
              : files.filename,
        };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    },
    { source, trimmed, filename, exportDirectory },
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByRole("button", { name: "Add MP3", exact: true }).click();
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "Trim audio for track 1", exact: true })
    .click();
  await expect(
    page.getByLabel("Trim end seconds", { exact: true }),
  ).toHaveValue("8.000");
  await page.getByLabel("Trim start seconds", { exact: true }).fill("2");
  await page.getByLabel("Trim end seconds", { exact: true }).fill("4.5");
  await expect(page.getByTestId("trim-duration")).toHaveText("2.500 s");
  checks.push("Real MP3 import and 2.000–4.500 second trim selection");
  await page.evaluate(() => {
    window.__cpcTrimStarts = [];
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__cpcTrimStarts.push(args);
      return original.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "Preview selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__cpcTrimStarts.length))
    .toBeGreaterThan(0);
  const audition = await page.evaluate(() => window.__cpcTrimStarts.at(-1));
  expect(audition[1]).toBe(2);
  expect(audition[2]).toBe(2.5);
  await page
    .getByRole("button", { name: "Stop selection", exact: true })
    .click();
  checks.push(
    "Muted real Web Audio preview starts at 2 seconds for 2.5 seconds",
  );
  await page.getByRole("button", { name: /^Save trimmed MP3/ }).click();
  await expect
    .poll(() => desktop.evaluate(() => globalThis.__cpcProjectSaveCalls))
    .toBe(1);
  await expect(
    page.getByRole("button", { name: /^Save trimmed MP3/ }),
  ).toBeEnabled();
  expect(
    await desktop.evaluate(() => globalThis.__cpcTrimSaveDefaults.length),
  ).toBe(0);
  await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(trimmed)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(page.getByTestId("trim-duration")).toHaveText("2.500 s");
  checks.push(
    "Canceling the initial project save stops MP3 export and preserves the draft trim",
  );
  await page.getByRole("button", { name: /^Save trimmed MP3/ }).click();
  await expect(page.getByRole("status")).toContainText("Trimmed MP3 saved", {
    timeout: 30_000,
  });
  const savedDuration = await decodedDuration(trimmed);
  expect(Math.abs(savedDuration - 2.5)).toBeLessThan(0.002);
  expect(digest(await readFile(source))).toBe(originalDigest);
  const draftProject = JSON.parse(await readFile(filename, "utf8"));
  const soundsDirectory = path.join(directory, "sounds");
  expect((await stat(soundsDirectory)).isDirectory()).toBe(true);
  expect(draftProject.audio.tracks[0].path.replaceAll("\\", "/")).toMatch(
    /^sounds\/[^/]+\.mp3$/,
  );
  expect(draftProject.audio.tracks[0].trimmedPath).toBeUndefined();
  const draftSoundFiles = await readdir(soundsDirectory);
  const draftSoundDurations = await Promise.all(
    draftSoundFiles
      .filter((name) => name.toLowerCase().endsWith(".mp3"))
      .map((name) => decodedDuration(path.join(soundsDirectory, name))),
  );
  expect(
    draftSoundDurations.some((duration) => Math.abs(duration - 2.5) < 0.002),
  ).toBe(true);
  checks.push(
    "Save trimmed MP3 first saves the scene, keeps the draft clip in sounds, also writes the chosen external 2.5 second MP3, and preserves original",
  );
  await expect(
    page.getByLabel("Trim start seconds", { exact: true }),
  ).toHaveValue(/^2(?:\.0+)?$/);
  await expect(
    page.getByLabel("Trim end seconds", { exact: true }),
  ).toHaveValue(/^4\.50*$/);
  await expect(page.getByTestId("trim-duration")).toHaveText("2.500 s");
  await expect(
    page.getByRole("button", { name: "Apply trim", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Apply trim", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply trim", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved", {
    timeout: 15_000,
  });
  const project = JSON.parse(await readFile(filename, "utf8"));
  expect(project.audio.tracks[0]).toMatchObject({
    trimStartMs: 2000,
    trimEndMs: 4500,
    durationMs: 8000,
  });
  expect(path.isAbsolute(project.audio.tracks[0].path)).toBe(false);
  expect(project.audio.tracks[0].path.replaceAll("\\", "/")).toMatch(
    /^sounds\/[^/]+\.mp3$/,
  );
  expect(project.audio.tracks[0].trimmedPath.replaceAll("\\", "/")).toMatch(
    /^sounds\/[^/]+\.mp3$/,
  );
  expect(path.isAbsolute(project.audio.tracks[0].trimmedPath)).toBe(false);
  const projectClipDuration = await decodedDuration(
    path.join(directory, project.audio.tracks[0].trimmedPath),
  );
  expect(Math.abs(projectClipDuration - 2.5)).toBeLessThan(0.002);
  expect(
    digest(await readFile(path.join(directory, project.audio.tracks[0].path))),
  ).toBe(originalDigest);
  checks.push(
    "Project saves clip bounds with the full original and a playable 2.5 second trimmed MP3 under sounds",
  );
  await page
    .getByRole("button", { name: "Export files for MP3 cards", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Exported 1 files", {
    timeout: 30_000,
  });
  const cardDuration = await decodedDuration(
    path.join(exportDirectory, "01", "001.mp3"),
  );
  expect(Math.abs(cardDuration - 2.5)).toBeLessThan(0.002);
  checks.push("SD-card export physically contains the 2.5 second clip");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Midnight workshop",
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "Trim audio for track 1", exact: true })
    .click();
  await expect(
    page.getByLabel("Trim start seconds", { exact: true }),
  ).toHaveValue("2.000");
  await expect(
    page.getByLabel("Trim end seconds", { exact: true }),
  ).toHaveValue("4.500");
  await expect(page.getByTestId("trim-duration")).toHaveText("2.500 s");
  expect(digest(await readFile(source))).toBe(originalDigest);
  expect(await decodedDuration(source)).toBe(8);
  expect(errors).toEqual([]);
  checks.push(
    "Reopened project restores editor bounds and original remains eight seconds",
  );
  await page.getByRole("button", { name: /^Save trimmed MP3/ }).click();
  await expect(page.getByRole("status")).toContainText("Trimmed MP3 saved", {
    timeout: 30_000,
  });
  const reopenedDefaultPath = await desktop.evaluate(() =>
    globalThis.__cpcTrimSaveDefaults.at(-1),
  );
  expect(path.isAbsolute(reopenedDefaultPath)).toBe(true);
  expect(path.relative(directory, reopenedDefaultPath).startsWith("..")).toBe(
    false,
  );
  expect(path.dirname(reopenedDefaultPath)).toBe(soundsDirectory);
  expect(Math.abs((await decodedDuration(trimmed)) - 2.5)).toBeLessThan(0.002);
  expect(
    digest(await readFile(path.join(directory, project.audio.tracks[0].path))),
  ).toBe(originalDigest);
  checks.push(
    "Separate MP3 save resolves reopened relative source and uses a project-local absolute Save dialog path",
  );
  if (visible) {
    screenshot = path.resolve("artifacts/desktop-trim-smoke.png");
    await page
      .getByRole("region", {
        name: "Audio editor for Eight second original.mp3",
      })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot, timeout: 15_000 });
  }
  await writeFile(
    "artifacts/desktop-trim-results.json",
    `${JSON.stringify(
      {
        passed: true,
        version,
        executable: executable
          ? path.resolve(executable)
          : "development Electron",
        directory,
        checks,
        savedDurationSeconds: savedDuration,
        cardDurationSeconds: cardDuration,
        projectClipDurationSeconds: projectClipDuration,
        soundsFiles: await readdir(soundsDirectory),
        errors,
        screenshot,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Desktop trim round trip passed. Evidence: ${directory}`);
} finally {
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  });
  await desktop.close();
}
