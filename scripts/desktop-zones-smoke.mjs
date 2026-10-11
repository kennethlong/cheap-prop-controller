import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

// Real desktop IPC, MP3 decoding, and native Web Audio. No controller is opened.
// --mute-audio silences the speakers without bypassing source/gain processing.
const executable = process.argv[2];
const execute = promisify(execFile);
if (!ffmpegPath)
  throw new Error("Install ffmpeg-static before this smoke test.");
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/zone-smoke-"));
const filename = path.join(directory, "distance-zones.cpc.json");
const settingsFile = path.join(directory, "project-folder.json");
const project = JSON.parse(
  await readFile("examples/ultrasonic-zones-uno.cpc.json", "utf8"),
);
const frequencies = [220, 440, 880];
await Promise.all(
  project.audio.tracks.map(async (track, index) => {
    const source = path.join(
      directory,
      `${track.number}-${frequencies[index]}Hz.mp3`,
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
        `sine=frequency=${frequencies[index]}:duration=60`,
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
    gains.set(gain, { analyser, values: new Float32Array(analyser.fftSize) });
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
    if (samples.length > 6000) samples.shift();
  }, 20);
  window.__zoneAudioProbe = { snapshot, samples, events };
}

const isTone = (voice, frequency) => Math.abs(voice.frequency - frequency) < 5;
const near = (value, expected) => Math.abs(value - expected) < 0.015;
const audible = (voice) =>
  voice.contextState === "running" && voice.gain > 0.01 && voice.rms > 0.0005;
const snapshot = () => page.evaluate(() => window.__zoneAudioProbe.snapshot());
const tone = (sample, frequency) =>
  sample.voices.find((voice) => isTone(voice, frequency));

async function tab(name) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true })
    .click();
}

async function captureScreenshot(name) {
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

async function openProject(file) {
  await desktop.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [target],
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, file);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const confirmation = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  if (await confirmation.isVisible()) await confirmation.click();
  await expect(page.getByLabel("Project name")).toHaveValue(project.name);
  await tab("Media");
  await expect(page.getByText("Preview ready", { exact: true })).toHaveCount(
    3,
    { timeout: 15_000 },
  );
}

async function setDistance(distance, zoneName) {
  const input = page.getByLabel("Visitor distance preview distance", {
    exact: true,
  });
  await input.fill(String(distance));
  await expect(input).toHaveValue(String(distance));
  await expect(page.getByTestId("distance-zone-approach")).toHaveText(
    `Zone: ${zoneName}`,
    { timeout: 5000 },
  );
}

async function waitForLevels(foregroundVolume, ambientVolume = 8, ids = {}) {
  await expect
    .poll(
      async () => {
        const sample = await snapshot();
        const ambient = tone(sample, 220);
        const foreground = tone(sample, ids.frequency ?? 440);
        return Boolean(
          ambient &&
          (!ids.ambient || ambient.id === ids.ambient) &&
          near(ambient.gain, ambientVolume / 30) &&
          audible(ambient) &&
          (foregroundVolume === null ||
            (foreground &&
              (!ids.foreground || foreground.id === ids.foreground) &&
              near(foreground.gain, foregroundVolume / 30) &&
              (foregroundVolume === 0
                ? foreground.rms < 0.0001
                : audible(foreground)))),
        );
      },
      { timeout: 10_000, intervals: [50, 100] },
    )
    .toBe(true);
  return snapshot();
}

async function startAtFar() {
  await tab("Scene");
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await setDistance(300, "Far");
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  return waitForLevels(null, 20);
}

async function verifyContinuity(before, after, frequency) {
  const startVoice = tone(before, frequency);
  const endVoice = tone(after, frequency);
  expect(endVoice.id).toBe(startVoice.id);
  expect(endVoice.contextTime).toBeGreaterThan(startVoice.contextTime);
  expect(endVoice.stops).toEqual([]);
  const trace = await page.evaluate(
    ({ first, last }) => ({
      samples: window.__zoneAudioProbe.samples.filter(
        (sample) => sample.time >= first && sample.time <= last,
      ),
      events: window.__zoneAudioProbe.events.filter(
        (event) => event.time > first && event.time <= last,
      ),
    }),
    { first: before.time, last: after.time },
  );
  expect(trace.samples.length).toBeGreaterThan(5);
  for (const sample of trace.samples) {
    const voices = sample.voices.filter((voice) => isTone(voice, frequency));
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe(startVoice.id);
    expect(voices[0].stops).toEqual([]);
    expect(voices[0].contextState).toBe("running");
  }
  expect(trace.events.filter((event) => event.id === startVoice.id)).toEqual(
    [],
  );
  return trace;
}

async function gapScenario(volume) {
  // The example's Approaching zone changes state (and restarts its foreground).
  // An uncovered gap isolates Close's exit-volume action for continuity checks.
  const variant = structuredClone(project);
  variant.triggers[0].zones[1].minCm = 121;
  variant.triggers[0].zones[2].onEnter[0].volume = volume;
  const file = path.join(directory, `gap-${volume}.cpc.json`);
  await writeFile(file, `${JSON.stringify(variant, null, 2)}\n`);
  await openProject(file);
  const idle = await startAtFar();
  const ambientId = tone(idle, 220).id;
  await setDistance(150, "Approaching");
  const approach = await waitForLevels(12, 8, { ambient: ambientId });
  const foregroundId = tone(approach, 440).id;
  await setDistance(70, "Close");
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  const changed = await waitForLevels(volume, 8, {
    ambient: ambientId,
    foreground: foregroundId,
  });
  await setDistance(115, "None");
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  const resumed = await waitForLevels(12, 8, {
    ambient: ambientId,
    foreground: foregroundId,
  });
  const trace = await verifyContinuity(approach, resumed, 440);
  await verifyContinuity(idle, resumed, 220);
  evidence.scenarios.push({
    type: `volume-${volume}-and-return`,
    idle,
    approach,
    changed,
    resumed,
    trace,
  });
  evidence.checks.push(
    `Native foreground source ${foregroundId} stays alive at 12 → ${volume} → 12 with advancing context time; ambient source ${ambientId} remains live`,
  );
  if (volume === 0) await captureScreenshot("zone-mute-resume-preview.png");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
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
  await desktop.evaluate(({ BrowserWindow, dialog }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.setSize(1440, 1100);
      window.webContents.setBackgroundThrottling(false);
    }
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  await page.addInitScript(installAudioProbe);
  await page.reload();
  await openProject(filename);
  evidence.checks.push(
    "Real desktop IPC opens the example and decodes three distinct 60-second MP3 tones",
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Project saved", {
    timeout: 15_000,
  });
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(saved.triggers).toEqual(project.triggers);
  for (const track of saved.audio.tracks) {
    expect(path.isAbsolute(track.path)).toBe(false);
    expect(track.path.replaceAll("\\", "/")).toMatch(/^sounds\/[^/]+\.mp3$/);
    expect(
      (await readFile(path.resolve(directory, track.path))).length,
    ).toBeGreaterThan(100_000);
  }
  await page.getByRole("button", { name: "New", exact: true }).click();
  await openProject(filename);
  expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
    projectDirectory: directory,
  });
  await tab("Hardware");
  await expect(page.getByLabel("Trigger 1 distance behavior")).toHaveValue(
    "zones",
  );
  const closeZone = page.getByRole("region", {
    name: "Visitor distance zone 3",
    exact: true,
  });
  await expect(closeZone.getByLabel("Zone 3 minimum distance")).toHaveValue(
    "41",
  );
  await expect(closeZone.getByLabel("On enter action 1 volume")).toHaveValue(
    "24",
  );
  await expect(closeZone.getByLabel("On exit action 1 volume")).toHaveValue(
    "12",
  );
  await closeZone.scrollIntoViewIfNeeded();
  await captureScreenshot("zone-editor.png");
  evidence.checks.push(
    "Save/reopen preserves all four zones and ordered actions; MP3s are copied to portable relative sounds paths and settings stay isolated",
  );

  const idle = await startAtFar();
  const ambientId = tone(idle, 220).id;
  await setDistance(150, "Approaching");
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  const approach = await waitForLevels(12, 8, { ambient: ambientId });
  const foregroundId = tone(approach, 440).id;
  await setDistance(70, "Close");
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  const close = await waitForLevels(24, 8, {
    ambient: ambientId,
    foreground: foregroundId,
  });
  const trace = await verifyContinuity(approach, close, 440);
  await page
    .getByRole("group", {
      name: "Visitor distance distance preview",
      exact: true,
    })
    .getByRole("button", { name: "Visitor distance no echo", exact: true })
    .click();
  await expect(
    page.getByLabel("Visitor distance preview distance", { exact: true }),
  ).toHaveValue("");
  const noEchoStarted = tone(await snapshot(), 440).contextTime;
  await expect
    .poll(async () => tone(await snapshot(), 440)?.contextTime ?? 0, {
      timeout: 5000,
      intervals: [50, 100],
    })
    .toBeGreaterThan(noEchoStarted + 0.3);
  await expect(page.getByTestId("distance-zone-approach")).toHaveText(
    "Zone: Close",
  );
  const noEcho = await waitForLevels(24, 8, {
    ambient: ambientId,
    foreground: foregroundId,
  });
  await captureScreenshot("zone-close-preview.png");
  await setDistance(20, "Very close");
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
  const scare = await waitForLevels(30, 8, {
    ambient: ambientId,
    frequency: 880,
  });
  await setDistance(300, "Far");
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  const reset = await waitForLevels(null, 20, { ambient: ambientId });
  await verifyContinuity(idle, reset, 220);
  evidence.scenarios.push({
    type: "unmodified-example",
    idle,
    approach,
    close,
    noEcho,
    scare,
    reset,
    trace,
  });
  evidence.checks.push(
    "Example walks Far → Approaching → Close → Very close → Far with correct states and native audio levels; no echo holds Close without replaying audio",
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await gapScenario(24);
  await gapScenario(0);
  expect(evidence.errors).toEqual([]);
  evidence.passed = true;
  console.log(`Desktop distance zones passed. Evidence: ${directory}`);
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    evidence.lastAudioSnapshot = await snapshot().catch(() => null);
    await captureScreenshot("failure.png").catch(() => {});
  }
  throw error;
} finally {
  await writeFile(
    path.join(directory, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    "artifacts/desktop-zones-results.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (desktop) {
    // Only this test's own Electron instance; never touch another running app.
    await desktop
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await desktop.close();
  }
}
