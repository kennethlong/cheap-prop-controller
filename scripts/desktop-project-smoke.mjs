import { _electron as electron, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const source = process.argv[2];
if (!source)
  throw new Error("Pass the path to a local MP3 for this desktop media test");
const directory = path.resolve("artifacts/project-smoke");
await mkdir(directory, { recursive: true });
const filename = path.join(directory, "portable-scene.cpc.json");
const exportDirectory = path.join(directory, "card");
await mkdir(exportDirectory, { recursive: true });
const desktop = await electron.launch({
  args: [".", "--mute-audio"],
  env: { ...process.env, CPC_TEST_HIDDEN: "1" },
});
const page = await desktop.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await desktop.evaluate(
    ({ dialog }, files) => {
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
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await expect(
    page.getByLabel("Audio waveform", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  expect(errors).toEqual([]);
  await writeFile(
    "artifacts/desktop-project-results.json",
    JSON.stringify(
      {
        passed: true,
        checks: [
          "Real MP3 decode",
          "Relative project assets",
          "Media bytes preserved",
          "Numbered SD export",
          "New/open round trip",
          "Audio reload from saved relative path",
          "Waveform and muted playback",
        ],
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
