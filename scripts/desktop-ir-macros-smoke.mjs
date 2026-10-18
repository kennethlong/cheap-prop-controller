import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Project persistence uses real Electron IPC. Device handlers below are explicitly
// mocked in this launched process: this test never opens a serial connection.
const executable = process.argv[2];
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/ir-macros-smoke-"));
const filename = path.join(directory, "learned-ir-macros.cpc.json");
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
async function learn(name, signal, sendCount = 1, gapMs = 100) {
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
  await draft.getByLabel("Captured send count").fill(String(sendCount));
  await draft.getByLabel("Captured gap milliseconds").fill(String(gapMs));
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
    args: [
      ...(executable ? [] : ["."]),
      "--mute-audio",
      `--user-data-dir=${path.join(directory, "profile")}`,
    ],
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
    for (const channel of [
      "device:output-test-begin",
      "device:output-test-set",
      "device:output-test-end",
    ]) {
      replace(channel, () => {
        throw new Error(`Physical hardware access disabled: ${channel}`);
      });
    }
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
  // Synthetic signals are confined to the mocked transport in this process.
  await learn("Candles on", { kind: "nec", code: 1 });
  await learn("Slowly brighten", { kind: "nec", code: 2 }, 8, 400);
  await learn("Candles off", {
    kind: "raw",
    pulsesUs: [1000, 1000, 500, 500, 500],
  });
  await page.getByRole("button", { name: "Add IR macro", exact: true }).click();
  await page.getByLabel("IR macro 1 name").fill("Candle entrance");
  await page
    .getByRole("button", { name: "Add step to Candle entrance", exact: true })
    .click();
  await page
    .getByLabel("IR macro 1 step 2 command")
    .selectOption({ label: "Slowly brighten" });
  await page.getByLabel("IR macro 1 step 2 offset seconds").fill("1");
  await page
    .getByRole("button", { name: "Add step to Candle entrance", exact: true })
    .click();
  await page
    .getByLabel("IR macro 1 step 3 command")
    .selectOption({ label: "Candles off" });
  await page.getByLabel("IR macro 1 step 3 offset seconds").fill("8");
  await page
    .getByRole("region", { name: "IR macros", exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot("ir-macro-library.png");
  evidence.checks.push(
    "Real preload capture and test IPC handles NEC and raw signals; named repeat settings become reusable macro steps",
  );

  await tab("Scene");
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Idle/ })
    .click();
  await page.getByLabel("Loop timeline").uncheck();
  await page.getByRole("button", { name: "Add IR event", exact: true }).click();
  await page
    .getByLabel("IR event command")
    .selectOption({ label: "Candle entrance" });
  await page.getByLabel("IR event time seconds").fill("0.5");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.ir.commands.map(({ name }) => name)).toEqual([
    "Candles on",
    "Slowly brighten",
    "Candles off",
  ]);
  expect(saved.ir.commands[1]).toMatchObject({
    sendCount: 8,
    gapMs: 400,
    signal: { kind: "nec", code: 2 },
  });
  expect(saved.ir.commands[2].signal).toEqual({
    kind: "raw",
    pulsesUs: [1000, 1000, 500, 500, 500],
  });
  expect(
    saved.ir.macros[0].steps.map(({ atMs, commandId }) => ({
      atMs,
      commandId,
    })),
  ).toEqual(
    [0, 1000, 8000].map((atMs, index) => ({
      atMs,
      commandId: saved.ir.commands[index].id,
    })),
  );
  expect(saved.states[0].irEvents).toEqual([
    expect.objectContaining({ atMs: 500, macroId: saved.ir.macros[0].id }),
  ]);
  expect(saved.states[0].irEvents[0]).not.toHaveProperty("commandId");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "IR Candle entrance at 0.5 seconds",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByTestId("ir-timeline-lane").getByRole("button"),
  ).toHaveCount(1);
  evidence.checks.push(
    "Real project IPC saves and reopens three named remote buttons, repeated brightness presses, macro offsets, and exactly one timeline entry",
  );
  await screenshot("ir-macro-timeline.png");
  const start = new Date("2026-10-13T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page.clock.runFor(600);
  await expect(page.getByTestId("preview-ir-activity")).toHaveText([
    /Candles on/,
  ]);
  await page.clock.runFor(1000);
  await expect(page.getByTestId("preview-ir-activity")).toHaveText([
    /Candles on/,
    /Slowly brighten/,
  ]);
  await page.clock.runFor(7000);
  await expect(page.getByTestId("preview-ir-activity")).toHaveText([
    /Candles on/,
    /Slowly brighten/,
    /Candles off/,
  ]);
  await screenshot("ir-macro-preview.png");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  evidence.checks.push(
    "Desktop preview expands the one macro at 0.5, 1.5 and 8.5 seconds without sending additional hardware commands",
  );
  evidence.calls = await desktop.evaluate(() => globalThis.__irSmoke.calls);
  expect(
    evidence.calls.filter((call) => call.method === "upload"),
  ).toHaveLength(1);
  expect(evidence.calls.filter((call) => call.method === "test")).toHaveLength(
    3,
  );
  expect(evidence.calls.filter((call) => call.method === "learn")).toHaveLength(
    4,
  );
  expect(evidence.calls.filter((call) => call.method === "stop")).toHaveLength(
    1,
  );
  expect(
    evidence.calls.filter((call) => call.method === "command"),
  ).toHaveLength(0);
  expect(evidence.errors).toEqual([]);
  evidence.passed = true;
  console.log(
    `Desktop IR macro smoke passed with mocked hardware. Evidence: ${directory}`,
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
    "artifacts/desktop-ir-macros-results.json",
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
