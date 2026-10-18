import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Real Electron/preload/project persistence, with every device handler replaced
// in the isolated process before exercising the UI. No serial port is opened.
const executable = process.argv[2];
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(
  path.resolve("artifacts/standard-harness-smoke-"),
);
const filename = path.join(directory, "standard-harness.cpc.json");
const modelFile = path.join(directory, "fixture-model.mjs");
await build({
  stdin: {
    contents: `
      export { compileProject, toRuntimeProject, STANDARD_OUTPUT_SLOTS } from "./src/shared/index";
      export { standardHarnessProject } from "./tests/core/standard-harness-fixture";
    `,
    resolveDir: process.cwd(),
  },
  outfile: modelFile,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { compileProject, toRuntimeProject, standardHarnessProject } =
  await import(pathToFileURL(modelFile).href);
const initial = standardHarnessProject("full");
initial.name = "Native standard harness smoke";
initial.outputs[4].name = "Solenoid";
initial.outputs[5].name = "Strobe";
for (const trigger of initial.triggers) {
  trigger.name = {
    beam: "Beam",
    pir: "Primary PIR",
    sonar: "Primary ultrasonic",
    "backup-pir": "Backup PIR",
    "backup-sonar": "Backup ultrasonic",
    next: "Next state",
  }[trigger.id];
}
await writeFile(filename, `${JSON.stringify(initial, null, 2)}\n`);
const evidence = {
  passed: false,
  executable: executable ? path.resolve(executable) : "development Electron",
  directory,
  deviceTransport: "Explicit mock IPC handlers; no physical serial connection",
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
async function save() {
  const before = (await stat(filename)).mtimeMs;
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Project saved");
  await expect
    .poll(async () => (await stat(filename)).mtimeMs)
    .not.toBe(before);
  return JSON.parse(await readFile(filename, "utf8"));
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
function connections(project) {
  return {
    outputs: project.outputs.map(({ id, standardSlot, pin }) => ({
      id,
      standardSlot,
      pin,
    })),
    triggers: project.triggers.map(({ id, standardSlot, pin, echoPin }) => ({
      id,
      standardSlot,
      pin,
      echoPin,
    })),
    ir: { txPin: project.ir.txPin, rxPin: project.ir.rxPin },
    players: project.audio.players,
  };
}
async function mockCalls() {
  return desktop.evaluate(() => globalThis.__standardSmoke.calls);
}
function compiledBytes(project) {
  const compiled = compileProject(project);
  expect(compiled.issues.filter((issue) => issue.severity === "error")).toEqual(
    [],
  );
  expect(compiled.bytes.length).toBeGreaterThan(0);
  return Array.from(compiled.bytes);
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
      CPC_TEST_SETTINGS_FILE: path.join(directory, "settings.json"),
      CPC_PROJECTS_DIRECTORY: path.join(directory, "projects"),
    },
  });
  evidence.version = await desktop.evaluate(({ app }) => app.getVersion());
  expect(evidence.version).toBe(
    JSON.parse(await readFile("package.json", "utf8")).version,
  );
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
    const fixture = { calls: [], resolve: null, reject: null, uploaded: null };
    globalThis.__standardSmoke = fixture;
    const hello = {
      type: "hello",
      board: "uno",
      outputTest: true,
      irLearning: true,
      irReplay: true,
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("device:list", () => [
      { path: "MOCK-STANDARD", manufacturer: "Native smoke only" },
    ]);
    replace("device:get-status", () => ({
      connected: true,
      port: "MOCK-STANDARD",
      hello,
    }));
    for (const channel of ["device:connect", "device:flash"]) {
      replace(channel, () => {
        fixture.calls.push({ method: "forbidden", channel });
        throw new Error(`Physical device access is disabled: ${channel}`);
      });
    }
    replace("device:disconnect", () => ({ type: "ack" }));
    replace("device:command", (_, command) => {
      fixture.calls.push({ method: "command", command });
      return { type: "ack" };
    });
    replace("device:upload", (_, bytes) => {
      fixture.uploaded = [...bytes];
      fixture.calls.push({ method: "upload", bytes });
      return { type: "ack" };
    });
    replace("device:output-test-begin", (_, bytes) => {
      if (JSON.stringify(bytes) !== JSON.stringify(fixture.uploaded))
        throw new Error(
          "Mock controller scene differs from requested output test image.",
        );
      fixture.calls.push({ method: "outputBegin", bytes });
      return { type: "ack" };
    });
    replace("device:output-test-set", (_, mask) => {
      fixture.calls.push({ method: "outputMask", mask });
      return { type: "ack" };
    });
    replace("device:output-test-end", () => {
      fixture.calls.push({ method: "outputEnd" });
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
      fixture.calls.push({ method: "irTest", command });
      return { type: "ack" };
    });
    replace("device:ir-cancel", () => {
      fixture.calls.push({ method: "irCancel" });
      fixture.reject?.(new Error("Learning cancelled. Scene stays stopped."));
      fixture.resolve = null;
      fixture.reject = null;
      return { type: "ack" };
    });
  }, filename);
  page = await desktop.firstWindow();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await tab("Hardware");
  await expect(page.getByLabel("Wiring preset")).toHaveValue("standard-uno");
  const map = page.getByRole("region", { name: "Standard harness wiring map" });
  await expect(map.locator('[data-slot="primary-ultrasonic"]')).toContainText(
    "D12",
  );
  await expect(map.locator('[data-slot="primary-ultrasonic"]')).toContainText(
    "D13",
  );
  await expect(map.locator('[data-slot="dc-ssr"]')).toContainText("A3 / D17");
  await expect(map.locator('[data-slot="ac-ssr"]')).toContainText("A4 / D18");
  const originalConnections = connections(initial);
  for (const name of [
    "Backup PIR",
    "Backup ultrasonic",
    "12 V DC SSR",
    "AC strobe SSR",
  ]) {
    await page
      .getByRole("checkbox", { name: `Enable ${name}`, exact: true })
      .uncheck();
  }
  const optionalOff = await save();
  expect(connections(optionalOff)).toEqual(originalConnections);
  expect(optionalOff.states).toEqual(initial.states);
  expect(
    toRuntimeProject(optionalOff).states.some((state) => state.id === "child"),
  ).toBe(false);
  await writeFile(
    path.join(directory, "optional-off.cpc.json"),
    `${JSON.stringify(optionalOff, null, 2)}\n`,
  );
  for (const name of ["12 V DC SSR", "AC strobe SSR"]) {
    await page
      .getByRole("checkbox", { name: `Enable ${name}`, exact: true })
      .check();
  }
  await page
    .getByRole("checkbox", { name: "Enable Shield relay 2", exact: true })
    .uncheck();
  let saved = await save();
  expect(connections(saved)).toEqual(originalConnections);
  expect(saved.states).toEqual(initial.states);
  const runtime = toRuntimeProject(saved);
  expect(runtime.outputs).toHaveLength(5);
  expect(runtime.triggers).toHaveLength(4);
  await map.scrollIntoViewIfNeeded();
  await screenshot("standard-fixed-map.png");
  evidence.checks.push(
    "Native project Open and Save preserve every fixed pin, scene event and device identity while backup sensors and SSRs are disabled and re-enabled; empty child disappears only from runtime.",
  );

  await page
    .getByRole("button", { name: "Show device console", exact: true })
    .click();
  const send = page.getByRole("button", { name: "Send trigger", exact: true });
  await expect(send).toBeDisabled();
  const selector = page.getByLabel("Controller trigger");
  await expect(selector.locator('option[value="backup-pir"]')).toHaveCount(0);
  await expect(selector.locator('option[value="backup-sonar"]')).toHaveCount(0);
  await selector.selectOption("next");
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await expect(send).toBeEnabled();
  expect(
    (await mockCalls()).filter((call) => call.method === "upload").at(-1).bytes,
  ).toEqual(compiledBytes(saved));
  await send.click();
  await expect
    .poll(async () =>
      (await mockCalls()).filter((call) => call.method === "command"),
    )
    .toContainEqual({
      method: "command",
      command: `TRIGGER ${runtime.triggers.findIndex((trigger) => trigger.id === "next")}`,
    });
  await page.getByRole("button", { name: "Test outputs", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Latch physical Air blast", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  const strobe = page.getByRole("button", {
    name: "Latch physical Strobe",
    exact: true,
  });
  await expect(strobe).toBeEnabled();
  await strobe.click();
  const expectedMask =
    1 <<
    runtime.outputs.findIndex((output) => output.standardSlot === "ac-ssr");
  await expect
    .poll(async () =>
      (await mockCalls()).filter((call) => call.method === "outputMask"),
    )
    .toContainEqual({ method: "outputMask", mask: expectedMask });
  await page.getByRole("button", { name: "All off", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await mockCalls())
          .filter((call) => call.method === "outputMask")
          .at(-1)?.mask,
    )
    .toBe(0);
  await page
    .getByRole("button", { name: "Exit output test", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Exit Test Outputs", exact: true })
    .click();
  evidence.checks.push(
    "Mock controller receives exact compiler bytes; Send trigger requires a matching upload; disabled backup inputs are absent and manual trigger/output masks use compact runtime indices.",
  );

  const library = page.getByRole("region", {
    name: "IR command library",
    exact: true,
  });
  await expect(library).toContainText("Receiver: D2");
  await expect(library).toContainText("Transmitter: D9");
  await library
    .getByRole("button", { name: "Learn IR command", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "STOP", exact: true }),
  ).toBeEnabled();
  const signal = { kind: "nec", code: 0x20df10ef };
  await desktop.evaluate(
    (_, value) => globalThis.__standardSmoke.resolve(value),
    signal,
  );
  const draft = page.getByRole("region", {
    name: "Captured IR command",
    exact: true,
  });
  await draft.getByLabel("Captured name").fill("Candles on");
  await draft.getByLabel("Captured send count").fill("1");
  await draft.getByLabel("Captured gap milliseconds").fill("100");
  await draft
    .getByRole("button", { name: "Test captured command", exact: true })
    .click();
  await expect(library).toContainText("Test queued");
  await draft
    .getByRole("button", { name: "Save IR command", exact: true })
    .click();
  saved = await save();
  expect(saved.ir.commands).toHaveLength(1);
  expect(saved.ir.commands[0]).toMatchObject({
    name: "Candles on",
    signal,
    sendCount: 1,
    gapMs: 100,
  });
  expect(connections(saved)).toEqual(originalConnections);
  expect(saved.states).toEqual(initial.states);
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await expect(send).toBeEnabled();
  expect(
    (await mockCalls()).filter((call) => call.method === "upload").at(-1).bytes,
  ).toEqual(compiledBytes(saved));
  await library.scrollIntoViewIfNeeded();
  await screenshot("standard-learned-ir.png");
  evidence.checks.push(
    "Native preload mock capture learns a synthetic NEC frame, names and tests Candles on, saves it in the real project file, and uploads the exact updated compiled image with fixed D2/D9 IR wiring.",
  );

  // Change only in memory, then reopen the saved file through real main-process
  // persistence to prove the restored command did not survive merely in React.
  await page
    .getByLabel("IR command 1 name", { exact: true })
    .fill("Unsaved temporary name");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await tab("Hardware");
  await expect(
    page.getByLabel("IR command 1 name", { exact: true }),
  ).toHaveValue("Candles on");
  await expect(
    page.getByRole("checkbox", { name: "Enable Backup PIR", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "Enable Backup ultrasonic",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Enable Shield relay 2", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Enable 12 V DC SSR", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Enable AC strobe SSR", exact: true }),
  ).toBeChecked();
  expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(saved);
  evidence.checks.push(
    "Reopening from disk discards an unsaved command rename and restores learned IR names, disabled backup/relay slots, enabled SSRs and their unchanged mappings.",
  );
  evidence.calls = await mockCalls();
  expect(
    evidence.calls.filter((call) => call.method === "forbidden"),
  ).toHaveLength(0);
  expect(evidence.calls.filter((call) => call.method === "learn")).toHaveLength(
    1,
  );
  expect(
    evidence.calls.filter((call) => call.method === "irTest"),
  ).toHaveLength(1);
  expect(
    evidence.calls.filter((call) => call.method === "upload"),
  ).toHaveLength(2);
  expect(
    evidence.calls.filter((call) => call.method === "outputBegin"),
  ).toHaveLength(1);
  expect(evidence.errors).toEqual([]);
  evidence.sceneBytes = compiledBytes(saved).length;
  evidence.passed = true;
  console.log(
    `Desktop standard harness smoke passed with mocked hardware. Evidence: ${directory}`,
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
  if (desktop) {
    await desktop
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await desktop.close();
  }
}
