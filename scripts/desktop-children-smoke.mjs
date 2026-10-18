import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

// Real renderer, Web Audio, and project IPC. No physical device access.
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/children-smoke-"));
const filename = path.join(directory, "parallel.cpc.json");
const bundled = await build({
  entryPoints: ["src/shared/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const shared = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const project = shared.createDefaultProject();
project.name = "Parallel child desktop test";
Object.assign(project.triggers[0], {
  kind: "manual",
  name: "Next audio state",
  pin: null,
  echoPin: null,
});
project.triggers[1].name = "Beam";
project.audio.transitionMode = "cut";
project.audio.fadeMs = 0;
project.audio.ambientTrack = 1;
project.audio.tracks = [];
for (const [number, frequency] of [
  [1, 220],
  [2, 440],
]) {
  const source = path.join(directory, `${number}.mp3`);
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=12`,
      "-c:a",
      "libmp3lame",
      source,
    ],
    { windowsHide: true },
  );
  project.audio.tracks.push({
    number,
    name: `Tone ${frequency}`,
    path: source,
    durationMs: 12000,
  });
}
project.states = [
  {
    ...shared.createState("idle", "Idle"),
    loopTimeline: true,
    transitions: [{ triggerId: "approach", targetStateId: "approach" }],
  },
  {
    ...shared.createState("approach", "Approach"),
    foregroundTrack: 2,
    volume: 30,
    loopAudio: true,
    loopTimeline: true,
    events: [{ id: "main", outputId: "output-1", startMs: 0, endMs: 10000 }],
    transitions: [
      { triggerId: "scare", targetStateId: "blast" },
      { triggerId: "approach", targetStateId: "idle" },
    ],
  },
  {
    ...shared.createState("blast", "Ankle blaster"),
    kind: "child",
    durationMs: 500,
    cooldownMs: 1000,
    events: [{ id: "pulse", outputId: "output-8", startMs: 0, endMs: 500 }],
  },
];
const allocated = shared.synchronizeAudioPlayers(project);
expect(
  shared
    .compileProject(allocated)
    .issues.filter((issue) => issue.severity === "error"),
).toEqual([]);
await writeFile(filename, JSON.stringify(allocated, null, 2));
const executable = process.argv[2];
const evidence = {
  passed: false,
  executable: executable ?? "development Electron",
  directory,
  hardwareAccess: false,
  checks: [],
  errors: [],
};
let desktop;
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
      CPC_PROJECTS_DIRECTORY: directory,
    },
  });
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await desktop.evaluate(({ BrowserWindow, dialog, ipcMain }, file) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.webContents.setBackgroundThrottling(false);
    }
    globalThis.__childDeviceAttempts = [];
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("device:list", () => []);
    replace("device:get-status", () => ({ connected: false }));
    for (const channel of [
      "device:connect",
      "device:flash",
      "device:upload",
      "device:command",
      "device:output-test-begin",
      "device:output-test-set",
    ])
      replace(channel, () => {
        globalThis.__childDeviceAttempts.push(channel);
        throw new Error("Hardware access disabled in child smoke");
      });
  }, filename);
  await page.addInitScript(() => {
    const records = [];
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args);
      const record = {
        id: records.length,
        started: false,
        stopped: false,
        context: this,
      };
      records.push(record);
      const start = source.start;
      source.start = function (...values) {
        record.started = true;
        record.startedAt = record.context.currentTime;
        return start.apply(this, values);
      };
      const stop = source.stop;
      source.stop = function (...values) {
        record.stopped = true;
        return stop.apply(this, values);
      };
      return source;
    };
    window.__childAudioProbe = () =>
      records.map(({ context, ...record }) => ({
        ...record,
        position: context.currentTime - (record.startedAt ?? 0),
      }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByRole("button", { name: "Media", exact: true })
    .first()
    .click();
  await expect(page.getByText("Preview ready", { exact: true })).toHaveCount(
    2,
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page
    .getByRole("button", { name: "Next audio state", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__childAudioProbe());
  const foreground = before.findLast(
    (voice) => voice.started && !voice.stopped,
  );
  expect(foreground).toBeDefined();
  const mainBefore = await page.getByTestId("preview-main-time").innerText();
  await page.getByRole("button", { name: "Beam", exact: true }).click();
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "running",
  );
  await expect(page.getByTestId("output-lane-output-8")).toHaveClass(/active/);
  await expect(page.getByTestId("output-lane-output-1")).toHaveClass(/active/);
  await page.getByRole("button", { name: "Beam", exact: true }).click();
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "cooldown",
  );
  await expect(page.getByTestId("output-lane-output-8")).not.toHaveClass(
    /active/,
  );
  await expect(page.getByTestId("output-lane-output-1")).toHaveClass(/active/);
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  expect(await page.getByTestId("preview-main-time").innerText()).not.toBe(
    mainBefore,
  );
  await page.getByRole("button", { name: "Beam", exact: true }).click();
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "cooldown",
  );
  const after = await page.evaluate(() => window.__childAudioProbe());
  expect(after).toHaveLength(before.length);
  const continued = after.find((voice) => voice.id === foreground.id);
  expect(continued.stopped).toBe(false);
  expect(continued.position).toBeGreaterThan(foreground.position);
  evidence.checks.push(
    "App-only manual trigger advances independently of the beam",
    "Beam pulse runs beside Approach output and advances main time",
    "Running/cooldown retriggers ignored",
    "Same native Web Audio source keeps playing without stop/restart",
  );
  const png = await desktop.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(
        undefined,
        { stayHidden: true, stayAwake: true },
      )
    )
      .toPNG()
      .toString("base64"),
  );
  await writeFile(
    path.join(directory, "parallel-preview.png"),
    Buffer.from(png, "base64"),
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect(page.getByTestId("preview-child-blast")).toHaveCount(0);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved");
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.triggers[0]).toMatchObject({
    kind: "manual",
    pin: null,
    echoPin: null,
  });
  expect(saved.states.find((state) => state.id === "blast")).toMatchObject({
    kind: "child",
    cooldownMs: 1000,
  });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator(".state-list")).toContainText("Ankle blaster");
  expect(
    await desktop.evaluate(() => globalThis.__childDeviceAttempts),
  ).toEqual([]);
  expect(evidence.errors).toEqual([]);
  evidence.checks.push(
    "STOP clears child activity",
    "Native save/reopen persists child settings",
    "Zero renderer errors or hardware access",
  );
  evidence.passed = true;
} catch (error) {
  evidence.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  if (desktop) await desktop.close();
  await writeFile(
    path.join(directory, "results.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
}
