import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Project persistence uses real Electron IPC. Device handlers below are explicitly
// mocked in this launched process: this test never opens a serial connection.
const executable = process.argv[2];
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/ir-smoke-"));
const filename = path.join(directory, "learned-ir.cpc.json");
const settingsFile = path.join(directory, "project-folder.json");
const evidence = {
  passed: false,
  executable: executable ? path.resolve(executable) : "development Electron",
  directory,
  deviceTransport: "Explicit mock IPC handlers; no physical hardware",
  hardwareAccess: false,
  hardwareTransmissionVerified: false,
  checks: [],
  screenshots: [],
  errors: [],
};
let desktop;
let page;
async function tab(name) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true })
    .click();
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
async function learn(name, signal) {
  await page
    .getByRole("button", { name: "Learn IR command", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "STOP", exact: true }),
  ).toBeEnabled();
  await desktop.evaluate(
    (_, capture) => globalThis.__irSmoke.resolve(capture),
    signal,
  );
  const draft = page.getByRole("region", {
    name: "Captured IR command",
    exact: true,
  });
  await draft.getByLabel("Captured name").fill(name);
  await draft
    .getByRole("button", { name: "Test captured command", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "IR command library" }),
  ).toContainText(`Test queued for “${name}”`);
  await draft
    .getByRole("button", { name: "Save IR command", exact: true })
    .click();
}

try {
  desktop = await electron.launch({
    ...(executable ? { executablePath: path.resolve(executable) } : {}),
    args: executable ? ["--mute-audio"] : [".", "--mute-audio"],
    env: {
      ...process.env,
      CPC_TEST_HIDDEN: "1",
      CPC_TEST_SETTINGS_FILE: settingsFile,
      CPC_PROJECTS_DIRECTORY: path.join(directory, "projects"),
    },
  });
  evidence.version = await desktop.evaluate(({ app }) => app.getVersion());
  expect(evidence.version).toBe(
    JSON.parse(await readFile("package.json", "utf8")).version,
  );
  page = await desktop.firstWindow();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow, ipcMain, dialog }, target) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.setSize(1500, 1000);
      window.webContents.setBackgroundThrottling(false);
    }
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [target],
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
    const fixture = { calls: [], resolve: null, reject: null };
    globalThis.__irSmoke = fixture;
    const hello = {
      type: "hello",
      board: "uno",
      irLearning: true,
      irReplay: true,
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("device:list", () => [
      { path: "MOCK-IR", manufacturer: "Test only" },
    ]);
    replace("device:get-status", () => ({
      connected: true,
      port: "MOCK-IR",
      hello,
    }));
    replace("device:connect", () => {
      throw new Error("Physical connections are disabled in this test.");
    });
    replace("device:disconnect", () => {});
    replace("device:flash", () => {
      throw new Error("Firmware flashing is disabled in this test.");
    });
    replace("device:command", (_, command) => {
      fixture.calls.push({ method: "command", command });
      return { type: "ack" };
    });
    replace("device:upload", (_, bytes) => {
      fixture.calls.push({ method: "upload", length: bytes.length });
      return { type: "ack" };
    });
    replace("device:ir-learn", () => {
      fixture.calls.push({ method: "learn" });
      return new Promise((resolve, reject) => {
        fixture.resolve = resolve;
        fixture.reject = reject;
      });
    });
    replace("device:ir-test", (_, command) => {
      fixture.calls.push({ method: "test", command });
      return { type: "ack" };
    });
    replace("device:ir-cancel", () => {
      fixture.calls.push({ method: "stop" });
      fixture.reject?.(new Error("Learning cancelled. Scene stays stopped."));
      fixture.resolve = null;
      fixture.reject = null;
      return { type: "ack" };
    });
  }, filename);
  await page.reload();
  await tab("Hardware");
  await page.getByLabel("Enable IR remote control").check();
  const library = page.getByRole("region", {
    name: "IR command library",
    exact: true,
  });
  await expect(library).toContainText("Receiver: D2");
  await expect(library).toContainText("Transmitter: D9");
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await library
    .getByRole("button", { name: "Learn IR command", exact: true })
    .click();
  await library
    .getByRole("button", { name: "Cancel learning", exact: true })
    .click();
  await expect(library).toContainText("Learning cancelled");
  // Synthetic transport fixtures are deliberately confined to this smoke script.
  await learn("Candle on", { kind: "nec", code: 551489775 });
  await learn("Dim down", {
    kind: "raw",
    pulsesUs: [1000, 1000, 500, 500, 500],
  });
  await expect(library).toContainText("38 kHz assumed");
  await library
    .getByRole("button", { name: "Test Candle on", exact: true })
    .click();
  await library.scrollIntoViewIfNeeded();
  await screenshot("ir-library.png");
  evidence.checks.push(
    "Real preload/API calls reach explicit mocked IR transport; capture, cancel, queued tests, NEC/raw labels, and saved command names render correctly",
  );

  await page.getByLabel("Trigger 1 type").selectOption("ultrasonic");
  await page.getByLabel("Trigger 1 distance behavior").selectOption("zones");
  const near = page.getByRole("region", {
    name: "Approach zone 1",
    exact: true,
  });
  await near.getByLabel("On enter action 1 type").selectOption("ir");
  await expect(near.getByLabel("On enter action 1 IR command")).toHaveText(
    "Candle onDim down",
  );
  await tab("Scene");
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Idle/ })
    .click();
  await page
    .getByRole("button", { name: "Add IR command", exact: true })
    .click();
  await page.getByLabel("IR event time seconds").fill("0.1");
  await page
    .getByRole("button", { name: "Add IR command", exact: true })
    .click();
  await page.getByLabel("IR event command").selectOption({ label: "Dim down" });
  await page.getByLabel("IR event time seconds").fill("0.5");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.ir).toMatchObject({ enabled: true, rxPin: 2, txPin: 9 });
  expect(saved.ir.commands.map((command) => command.name)).toEqual([
    "Candle on",
    "Dim down",
  ]);
  expect(saved.ir.commands[0].signal).toEqual({ kind: "nec", code: 551489775 });
  expect(saved.ir.commands[1].signal).toEqual({
    kind: "raw",
    pulsesUs: [1000, 1000, 500, 500, 500],
  });
  expect(saved.states[0].irEvents).toHaveLength(2);
  expect(saved.triggers[0].zones[0].onEnter[0]).toMatchObject({
    kind: "ir",
    commandId: saved.ir.commands[0].id,
  });
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    projectDirectory: directory,
  });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "IR Candle on at 0.1 seconds",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "IR Dim down at 0.5 seconds",
      exact: true,
    }),
  ).toBeVisible();
  const firstPoint = await page
    .getByRole("button", { name: "IR Candle on at 0.1 seconds", exact: true })
    .boundingBox();
  const secondPoint = await page
    .getByRole("button", { name: "IR Dim down at 0.5 seconds", exact: true })
    .boundingBox();
  expect(firstPoint).not.toBeNull();
  expect(secondPoint).not.toBeNull();
  expect(secondPoint.y).toBeGreaterThanOrEqual(
    firstPoint.y + firstPoint.height,
  );
  evidence.checks.push(
    "Real project IPC saves and reopens both learned signal formats, nonoverlapping named timeline points, zone references, and isolated project settings",
  );
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page
    .getByLabel("Approach preview distance", { exact: true })
    .fill("300");
  const log = page.getByRole("log", {
    name: "Preview IR activity",
    exact: true,
  });
  await expect(log).toContainText("Candle on · Timeline");
  await expect(log).toContainText("Dim down · Timeline");
  await page
    .getByLabel("Approach preview distance", { exact: true })
    .fill("50");
  await expect(log).toContainText("Candle on · Distance zone");
  await screenshot("ir-preview.png");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  evidence.checks.push(
    "Desktop preview logs both named timeline commands and the named ultrasonic zone action without transmitting IR",
  );
  evidence.calls = await desktop.evaluate(() => globalThis.__irSmoke.calls);
  expect(
    evidence.calls.filter((call) => call.method === "upload"),
  ).toHaveLength(1);
  expect(evidence.calls.filter((call) => call.method === "test")).toHaveLength(
    3,
  );
  expect(evidence.calls.filter((call) => call.method === "stop")).toHaveLength(
    1,
  );
  expect(evidence.errors).toEqual([]);
  evidence.passed = true;
  console.log(
    `Desktop IR smoke passed with mocked hardware. Evidence: ${directory}`,
  );
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) await screenshot("failure.png").catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(directory, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    "artifacts/desktop-ir-results.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (desktop) {
    await desktop
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await desktop.close();
  }
}
