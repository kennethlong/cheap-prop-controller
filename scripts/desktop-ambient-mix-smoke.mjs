import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

// Uses real MP3 decoding, desktop IPC, and Web Audio. --mute-audio silences
// the computer output; native source/gain/analyser nodes still process audio.
const executable = process.argv[2];
const execute = promisify(execFile);
if (!ffmpegPath)
  throw new Error("Install ffmpeg-static before this smoke test");
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/ambient-mix-smoke-"));
const filename = path.join(directory, "ambient-mix.cpc.json");
const settingsFile = path.join(directory, "project-folder.json");
const project = JSON.parse(
  await readFile("examples/ambient-crossfades-mega.cpc.json", "utf8"),
);
const tones = [220, 440, 880];
await Promise.all(
  project.audio.tracks.map(async (track, index) => {
    const source = path.join(
      directory,
      `${track.number}-${tones[index]}Hz.mp3`,
    );
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
        `sine=frequency=${tones[index]}:duration=60`,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        source,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    track.path = source;
    track.durationMs = 60_000;
  }),
);
await writeFile(filename, `${JSON.stringify(project, null, 2)}\n`);

const evidence = {
  passed: false,
  executable: executable ? path.resolve(executable) : "development Electron",
  directory,
  hardwareAccess: false,
  outputMuted: true,
  checks: [],
  scenarios: [],
  errors: [],
  screenshots: [],
};
let desktop;
let page;

// Observe native nodes without replacing their implementation or audio data.
function installAudioProbe() {
  const sources = [];
  const gains = new Map();
  const samples = [];
  const events = [];
  const identifyTone = (buffer) => {
    const data = buffer.getChannelData(0);
    const first = Math.floor(buffer.sampleRate * 0.15);
    const last = Math.min(data.length, Math.floor(buffer.sampleRate * 0.65));
    let crossings = 0;
    for (let index = first + 1; index < last; index++)
      if (data[index - 1] <= 0 && data[index] > 0) crossings++;
    return Math.round((crossings * buffer.sampleRate) / (last - first));
  };
  const createGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function (...args) {
    const gain = createGain.apply(this, args);
    const analyser = this.createAnalyser();
    analyser.fftSize = 2048;
    gain.connect(analyser);
    gains.set(gain, {
      analyser,
      values: new Float32Array(analyser.fftSize),
    });
    return gain;
  };
  const createSource = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function (...args) {
    const source = createSource.apply(this, args);
    const record = {
      id: sources.length + 1,
      source,
      context: this,
      gain: null,
      started: false,
      ended: false,
      stops: [],
    };
    sources.push(record);
    const connect = source.connect;
    source.connect = function (...connectArgs) {
      const result = connect.apply(this, connectArgs);
      if (gains.has(connectArgs[0])) record.gain = connectArgs[0];
      return result;
    };
    const start = source.start;
    source.start = function (...startArgs) {
      const result = start.apply(this, startArgs);
      record.started = true;
      record.frequency = identifyTone(source.buffer);
      record.startArgs = startArgs;
      events.push({
        type: "start",
        id: record.id,
        frequency: record.frequency,
        time: performance.now(),
        contextTime: record.context.currentTime,
        args: startArgs,
      });
      return result;
    };
    const stop = source.stop;
    source.stop = function (...stopArgs) {
      const result = stop.apply(this, stopArgs);
      record.stops.push(stopArgs);
      events.push({
        type: "stop",
        id: record.id,
        time: performance.now(),
        args: stopArgs,
      });
      return result;
    };
    source.addEventListener("ended", () => {
      record.ended = true;
      events.push({ type: "ended", id: record.id, time: performance.now() });
    });
    return source;
  };
  const snapshot = () => ({
    time: performance.now(),
    voices: sources
      .filter((record) => record.started && !record.ended)
      .map((record) => {
        const observation = gains.get(record.gain);
        let rms = 0;
        if (observation) {
          observation.analyser.getFloatTimeDomainData(observation.values);
          rms = Math.sqrt(
            observation.values.reduce((sum, value) => sum + value * value, 0) /
              observation.values.length,
          );
        }
        return {
          id: record.id,
          frequency: record.frequency,
          gain: record.gain?.gain.value,
          rms,
          loop: record.source.loop,
          contextTime: record.context.currentTime,
          contextState: record.context.state,
          stops: record.stops.map((args) => [...args]),
        };
      }),
  });
  setInterval(() => {
    samples.push(snapshot());
    if (samples.length > 2400) samples.shift();
  }, 20);
  window.__ambientAudioProbe = { snapshot, samples, events };
}

const isTone = (voice, frequency) => Math.abs(voice.frequency - frequency) < 5;
const near = (value, expected) => Math.abs(value - expected) < 0.015;
const audible = (voice) =>
  voice.contextState === "running" && voice.gain > 0.01 && voice.rms > 0.0005;

async function snapshot() {
  return page.evaluate(() => window.__ambientAudioProbe.snapshot());
}

async function waitForMix(foregroundFrequency, ambientVolume, ambientId) {
  await expect
    .poll(
      async () => {
        const current = await snapshot();
        const ambient = current.voices.find((voice) => isTone(voice, 220));
        const foreground = current.voices.find((voice) =>
          isTone(voice, foregroundFrequency),
        );
        return Boolean(
          ambient &&
          (!ambientId || ambient.id === ambientId) &&
          near(ambient.gain, ambientVolume / 30) &&
          audible(ambient) &&
          (foregroundFrequency === 220 ||
            (foreground &&
              near(foreground.gain, 25 / 30) &&
              audible(foreground))),
        );
      },
      { timeout: 10_000, intervals: [50, 100] },
    )
    .toBe(true);
  return snapshot();
}

async function mediaTab() {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
}

async function saveProject() {
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved", {
    timeout: 15_000,
  });
  return JSON.parse(await readFile(filename, "utf8"));
}

async function captureScreenshot(filename) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const png = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.invalidate();
    await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const captured = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return captured.toPNG().toString("base64");
  });
  await writeFile(filename, Buffer.from(png, "base64"));
  evidence.screenshots.push(filename);
}

async function runScenario(mode) {
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  const idle = await waitForMix(220, 20);
  const ambientId = idle.voices.find((voice) => isTone(voice, 220)).id;
  const beginning = idle.time;
  const triggers = page.locator(".preview-buttons");
  await triggers.getByRole("button", { name: "Approach", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  const approach = await waitForMix(440, 8, ambientId);
  const transitionStart = await page.evaluate(() => performance.now());
  await triggers.getByRole("button", { name: "Scare", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
  const scare = await waitForMix(880, 8, ambientId);
  const transitionEnd = scare.time;
  await triggers.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  const reset = await waitForMix(220, 20, ambientId);
  const trace = await page.evaluate(
    ({ beginning, end }) => ({
      samples: window.__ambientAudioProbe.samples.filter(
        (sample) => sample.time >= beginning && sample.time <= end,
      ),
      events: window.__ambientAudioProbe.events.filter(
        (event) => event.time >= beginning && event.time <= end,
      ),
    }),
    { beginning, end: reset.time },
  );
  expect(trace.samples.length).toBeGreaterThan(15);
  for (const sample of trace.samples) {
    const ambient = sample.voices.filter((voice) => isTone(voice, 220));
    expect(ambient).toHaveLength(1);
    expect(ambient[0].id).toBe(ambientId);
    expect(ambient[0].gain).toBeGreaterThanOrEqual(8 / 30 - 0.015);
    expect(ambient[0].loop).toBe(true);
    expect(ambient[0].stops).toEqual([]);
    expect(audible(ambient[0])).toBe(true);
  }
  expect(trace.events.filter((event) => event.id === ambientId)).toEqual([]);
  const transition = trace.samples.filter(
    (sample) => sample.time >= transitionStart && sample.time <= transitionEnd,
  );
  const overlaps = transition.filter((sample) =>
    [220, 440, 880].every((frequency) =>
      sample.voices.some((voice) => isTone(voice, frequency) && audible(voice)),
    ),
  );
  let foregroundDisposalTailMs = 0;
  if (mode === "crossfade") expect(overlaps.length).toBeGreaterThan(0);
  else {
    // PreviewAudio retires the old source with a 20 ms smoothing ramp and
    // 10 ms stop margin. That short native disposal tail is not a third
    // allocated player or a foreground crossfade.
    for (const sample of overlaps) {
      const retiring = sample.voices.find(
        (voice) => isTone(voice, 440) && voice.stops.length > 0,
      );
      expect(retiring).toBeDefined();
      expect(
        retiring.stops.at(-1)[0] - retiring.contextTime,
      ).toBeLessThanOrEqual(0.04);
    }
    const incomingStart = trace.events.find(
      (event) => event.type === "start" && Math.abs(event.frequency - 880) < 5,
    );
    const outgoingId = approach.voices.find((voice) => isTone(voice, 440)).id;
    const outgoingStop = trace.events.find(
      (event) => event.type === "stop" && event.id === outgoingId,
    );
    expect(incomingStart).toBeDefined();
    expect(outgoingStop).toBeDefined();
    foregroundDisposalTailMs = Math.max(
      0,
      (outgoingStop.args[0] - incomingStart.contextTime) * 1000,
    );
    expect(foregroundDisposalTailMs).toBeLessThanOrEqual(50);
    expect(
      Math.max(
        ...trace.samples.map(
          (sample) =>
            sample.voices.filter(
              (voice) => audible(voice) && voice.stops.length === 0,
            ).length,
        ),
      ),
    ).toBe(2);
  }
  const scenario = {
    mode,
    ambientId,
    idle,
    approach,
    scare,
    reset,
    foregroundOverlapSamples: overlaps.length,
    foregroundDisposalTailMs,
    trace,
  };
  evidence.scenarios.push(scenario);
  evidence.checks.push(
    `${mode}: native ambient source ${ambientId} stays audible at 8/30 with foreground and returns to 20/30 without restart`,
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  return scenario;
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
  await desktop.evaluate(({ BrowserWindow, dialog }, file) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.webContents.setBackgroundThrottling(false);
    }
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  }, filename);
  await page.addInitScript(installAudioProbe);
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(project.name);
  await mediaTab();
  await expect(page.getByText("Preview ready", { exact: true })).toHaveCount(
    3,
    {
      timeout: 15_000,
    },
  );
  evidence.checks.push(
    "Packaged IPC opens absolute MP3 paths and decodes three distinct tones",
  );
  await page.getByLabel("Ambient during foreground").selectOption("mix");
  await page.getByLabel("Ambient volume (0–30)", { exact: true }).fill("20");
  await page
    .getByLabel("Ambient mixed volume (1–30)", { exact: true })
    .fill("8");
  await page.getByLabel("Audio transition").selectOption("crossfade");
  await page.getByLabel("Crossfade milliseconds").fill("500");
  const playerCount = page
    .locator(".resource-stat")
    .filter({ hasText: "Players required by these settings" })
    .locator("strong");
  await expect(playerCount).toHaveText("3");
  const saved = await saveProject();
  expect(saved.audio).toMatchObject({
    ambientVolume: 20,
    ambientMixVolume: 8,
    keepAmbient: true,
    transitionMode: "crossfade",
  });
  expect(saved.audio.players).toHaveLength(3);
  for (const track of saved.audio.tracks) {
    expect(path.isAbsolute(track.path)).toBe(false);
    expect(track.path.replaceAll("\\", "/")).toMatch(/^sounds\/[^/]+\.mp3$/);
  }
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(project.name);
  await mediaTab();
  await expect(page.getByLabel("Ambient during foreground")).toHaveValue("mix");
  await expect(
    page.getByLabel("Ambient volume (0–30)", { exact: true }),
  ).toHaveValue("20");
  await expect(
    page.getByLabel("Ambient mixed volume (1–30)", { exact: true }),
  ).toHaveValue("8");
  await expect(page.getByText("Preview ready", { exact: true })).toHaveCount(
    3,
    {
      timeout: 15_000,
    },
  );
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    projectDirectory: directory,
  });
  evidence.checks.push(
    "Save/open preserves separate normal 20 and mixed 8 volume, with portable sounds paths and isolated settings",
  );
  const settingsScreenshot = path.join(directory, "crossfade-mix-settings.png");
  await captureScreenshot(settingsScreenshot);
  await runScenario("crossfade");
  evidence.checks.push(
    "Crossfade has simultaneous native ambient, Approach, and Scare signals",
  );

  await mediaTab();
  await page.getByLabel("Audio transition").selectOption("fade-through");
  await page.getByLabel("Fade-out milliseconds").fill("400");
  await page.getByLabel("Fade-in milliseconds").fill("400");
  await expect(playerCount).toHaveText("2");
  const sequential = await saveProject();
  expect(sequential.audio.players).toHaveLength(2);
  expect(sequential.audio).toMatchObject({
    ambientVolume: 20,
    ambientMixVolume: 8,
    transitionMode: "fade-through",
    fadeOutMs: 400,
    fadeInMs: 400,
  });
  await runScenario("fade-through");
  evidence.checks.push(
    "Fade-through saves two players and keeps ambient audible throughout sequential foreground switching",
  );
  await mediaTab();
  const sequentialScreenshot = path.join(
    directory,
    "fade-through-mix-settings.png",
  );
  await captureScreenshot(sequentialScreenshot);
  expect(evidence.errors).toEqual([]);
  evidence.passed = true;
  console.log(`Desktop ambient mixing passed. Evidence: ${directory}`);
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    evidence.lastAudioSnapshot = await snapshot().catch(() => null);
    const failureScreenshot = path.join(directory, "failure.png");
    await captureScreenshot(failureScreenshot).catch(() => {});
  }
  throw error;
} finally {
  await writeFile(
    path.join(directory, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    "artifacts/desktop-ambient-mix-results.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (desktop) {
    // Only windows/processes belonging to this launched Electron instance.
    await desktop
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await desktop.close();
  }
}
