import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Real isolated Electron/preload/library/project persistence. Native dialog
// choices are deterministic; all active device operations are blocked mocks.
const executable = process.argv[2];
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(
  path.resolve("artifacts/wiring-configurations-smoke-"),
);
const projectFile = path.join(directory, "wiring-bench.cpc.json");
const libraryFile = path.join(directory, "wiring-configurations.json");
const exportFile = path.join(directory, "Saved bench.cpc-wiring.json");
const invalidFile = path.join(directory, "invalid.cpc-wiring.json");
const modelFile = path.join(directory, "fixture-model.mjs");
await build({
  stdin: {
    contents: `
      export { compileProject, applyWiringConfiguration, BUILT_IN_WIRING_CONFIGURATIONS } from "./src/shared/index";
      export { standardHarnessProject } from "./tests/core/standard-harness-fixture";
    `,
    resolveDir: process.cwd(),
  },
  outfile: modelFile,
  bundle: true,
  platform: "node",
  format: "esm",
});
const {
  compileProject,
  applyWiringConfiguration,
  BUILT_IN_WIRING_CONFIGURATIONS,
  standardHarnessProject,
} = await import(pathToFileURL(modelFile).href);
const initial = standardHarnessProject("sparse");
initial.name = "Native reusable wiring smoke";
const dualBeam = BUILT_IN_WIRING_CONFIGURATIONS.find(
  (item) => item.id === "uno-dual-beam",
);
const expectedProject = applyWiringConfiguration(initial, dualBeam);
await writeFile(projectFile, `${JSON.stringify(initial, null, 2)}\n`);
await writeFile(invalidFile, "{invalid configuration JSON");
const evidence = {
  passed: false,
  directory,
  executable: executable ? path.resolve(executable) : "development Electron",
  hardwareAccess: false,
  deviceTransport:
    "Blocked mock handlers; no physical serial connection or uploads",
  checks: [],
  screenshots: [],
  errors: [],
  runs: [],
};
let desktop;
let page;
async function tab(name) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function list() {
  return page.evaluate(() => window.cpc.listWiringConfigurations());
}
async function readProject() {
  return JSON.parse(await readFile(projectFile, "utf8"));
}
async function launch() {
  desktop = await electron.launch({
    ...(executable ? { executablePath: path.resolve(executable) } : {}),
    args: [
      ...(executable ? [] : ["."]),
      "--mute-audio",
      `--user-data-dir=${path.join(directory, "profile")}`,
    ],
    env: {
      ...process.env,
      CPC_TEST_HIDDEN: "1",
      CPC_TEST_SETTINGS_FILE: path.join(directory, "settings.json"),
      CPC_TEST_WIRING_CONFIGURATIONS_FILE: libraryFile,
      CPC_PROJECTS_DIRECTORY: path.join(directory, "projects"),
    },
  });
  expect(await desktop.evaluate(({ app }) => app.getVersion())).toBe(
    JSON.parse(await readFile("package.json", "utf8")).version,
  );
  await desktop.evaluate(
    ({ BrowserWindow, dialog, ipcMain }, paths) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.hide();
        window.setSize(1500, 1100);
        window.webContents.setBackgroundThrottling(false);
      }
      const fixture = { calls: [], dialogs: [], paths, importCanceled: false };
      globalThis.__wiringSmoke = fixture;
      dialog.showOpenDialog = async (_window, options) => {
        fixture.dialogs.push({ kind: "open", title: options.title });
        const importing = options.title === "Import wiring configuration";
        return {
          canceled: importing && fixture.importCanceled,
          filePaths: [
            importing ? fixture.paths.importFile : fixture.paths.projectFile,
          ],
        };
      };
      dialog.showSaveDialog = async (_window, options) => {
        fixture.dialogs.push({
          kind: "save",
          title: options.title,
          defaultPath: options.defaultPath,
        });
        return {
          canceled: false,
          filePath:
            options.title === "Export wiring configuration"
              ? fixture.paths.exportFile
              : fixture.paths.projectFile,
        };
      };
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      replace("device:list", () => []);
      replace("device:get-status", () => ({ connected: false }));
      for (const channel of [
        "device:connect",
        "device:disconnect",
        "device:flash",
        "device:command",
        "device:upload",
        "device:output-test-begin",
        "device:output-test-set",
        "device:output-test-end",
        "device:ir-learn",
        "device:ir-test",
        "device:ir-cancel",
      ])
        replace(channel, () => {
          fixture.calls.push(channel);
          throw new Error(
            `Device operations are prohibited in this smoke test: ${channel}`,
          );
        });
    },
    { projectFile, exportFile, importFile: exportFile },
  );
  page = await desktop.firstWindow();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await tab("Hardware");
}
async function finishRun() {
  if (!desktop) return;
  const run = await desktop.evaluate(() => ({
    calls: globalThis.__wiringSmoke.calls,
    dialogs: globalThis.__wiringSmoke.dialogs,
  }));
  evidence.runs.push(run);
  try {
    expect(run.calls).toEqual([]);
  } finally {
    await desktop.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    });
    await desktop.close();
    desktop = undefined;
    page = undefined;
  }
}
async function screenshot(name) {
  const target = path.join(directory, name);
  const png = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.invalidate();
    await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return (
      await window.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString("base64");
  });
  await writeFile(target, Buffer.from(png, "base64"));
  evidence.screenshots.push(target);
}
try {
  await launch();
  const configurationRegion = page.getByRole("region", {
    name: "Wiring configurations",
    exact: true,
  });
  await expect(configurationRegion).toBeVisible();
  expect(await list()).toEqual([]);
  await page
    .getByLabel("Wiring configuration", { exact: true })
    .selectOption("builtin:uno-dual-beam");
  await expect(
    page.getByRole("region", { name: "Wiring configuration preview" }),
  ).toBeVisible();
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "standard-uno",
  );
  expect(await readProject()).toEqual(initial);
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "fixed",
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Project saved");
  const savedProject = await readProject();
  expect(savedProject).toEqual(expectedProject);
  expect(
    savedProject.triggers.some(
      (trigger) => trigger.kind === "button" && trigger.pin === 19,
    ),
  ).toBe(true);
  expect(savedProject.states).toEqual(initial.states);
  expect(savedProject.audio.tracks).toEqual(initial.audio.tracks);
  expect(
    compileProject(savedProject).issues.filter(
      (issue) => issue.severity === "error",
    ),
  ).toEqual([]);
  evidence.checks.push(
    "Choosing a built-in only previews; applying Uno dual beam preserves scene/media and persists fixed A5 second beam through real project IPC.",
  );

  await page
    .getByLabel("New wiring configuration name", { exact: true })
    .fill("My ammo box wiring");
  await page
    .getByRole("button", { name: "Save as configuration", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "Saved wiring configuration",
  );
  const [savedConfiguration] = await list();
  expect(savedConfiguration.name).toBe("My ammo box wiring");
  expect(
    savedConfiguration.triggers.every(
      (trigger) =>
        trigger.kind !== "manual" && trigger.kind !== "timer" && !trigger.zones,
    ),
  ).toBe(true);
  expect(savedConfiguration).not.toHaveProperty("states");
  expect(savedConfiguration).not.toHaveProperty("audio");
  await page
    .getByRole("button", { name: "Export configuration", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("Exported");
  expect(JSON.parse(await readFile(exportFile, "utf8"))).toEqual(
    savedConfiguration,
  );
  await page
    .getByRole("button", { name: "Import configuration", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("Imported");
  let entries = await list();
  expect(entries).toHaveLength(2);
  expect(entries[1].id).not.toBe(savedConfiguration.id);
  expect({ ...entries[1], id: savedConfiguration.id }).toEqual(
    savedConfiguration,
  );
  evidence.checks.push(
    "Real preload saves/list configurations, native dialog export writes hardware-only JSON, and native import preserves colliding originals under a new ID.",
  );

  const libraryBefore = await readFile(libraryFile, "utf8");
  await desktop.evaluate((_electron, filename) => {
    globalThis.__wiringSmoke.paths.importFile = filename;
  }, invalidFile);
  await page
    .getByRole("button", { name: "Import configuration", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText("invalid JSON");
  expect(await readFile(libraryFile, "utf8")).toBe(libraryBefore);
  await desktop.evaluate(() => {
    globalThis.__wiringSmoke.importCanceled = true;
  });
  expect(
    await page.evaluate(() => window.cpc.importWiringConfiguration()),
  ).toBeNull();
  expect(await readFile(libraryFile, "utf8")).toBe(libraryBefore);
  await expect(
    page.getByRole("button", {
      name: "Delete saved configuration",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Delete saved configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await list()).length).toBe(1);
  expect(await readProject()).toEqual(savedProject);
  evidence.checks.push(
    "Malformed import is visibly rejected without modifying the library; cancel is a no-op and deleting a saved template preserves the project.",
  );
  await configurationRegion.scrollIntoViewIfNeeded();
  await screenshot("saved-wiring-configurations.png");
  await finishRun();

  await launch();
  entries = await list();
  expect(entries).toEqual([savedConfiguration]);
  await expect(
    page
      .getByLabel("Wiring configuration", { exact: true })
      .locator(`option[value="saved:${savedConfiguration.id}"]`),
  ).toHaveText(/My ammo box wiring/);
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "fixed",
  );
  expect(await readProject()).toEqual(savedProject);
  await page
    .getByLabel("Wiring configuration", { exact: true })
    .selectOption(`saved:${savedConfiguration.id}`);
  await expect(
    page.getByRole("button", { name: "Apply configuration", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("region", { name: "Wiring configuration preview" })
    .scrollIntoViewIfNeeded();
  await screenshot("reopened-wiring-configuration.png");
  await page.evaluate(
    (id) => window.cpc.deleteWiringConfiguration(id),
    savedConfiguration.id,
  );
  expect(await list()).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await tab("Hardware");
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "fixed",
  );
  expect(await readProject()).toEqual(savedProject);
  evidence.checks.push(
    "A fresh Electron process restores the saved library and fixed project; deleting all library entries does not remove embedded project wiring.",
  );
  expect(evidence.errors).toEqual([]);
  await finishRun();
  evidence.passed = true;
  console.log(
    `Desktop wiring configurations smoke passed. Evidence: ${directory}`,
  );
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) await screenshot("failure.png").catch(() => {});
  throw error;
} finally {
  if (desktop)
    await finishRun().catch((error) => {
      evidence.cleanupError = String(error);
    });
  await writeFile(
    path.join(directory, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}
