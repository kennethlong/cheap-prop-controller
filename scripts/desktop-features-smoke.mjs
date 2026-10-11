import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

// Real project IPC and desktop preload, with explicitly mocked device handlers.
// This script never opens a serial port or flashes the user's controller.
const executable = process.argv[2];
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/features-smoke-"));
const filename = path.join(directory, "scene-controls.cpc.json");
const project = JSON.parse(
  await readFile("examples/scene-controls-uno.cpc.json", "utf8"),
);
if (!ffmpegPath)
  throw new Error("Install ffmpeg-static before this smoke test.");
const execute = promisify(execFile);
const tones = [220, 440, 880];
await Promise.all(
  project.audio.tracks.map(async (track, index) => {
    const source = path.join(
      directory,
      `track-${track.number}-${tones[index]}Hz.mp3`,
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
        `sine=frequency=${tones[index]}:duration=12`,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        source,
      ],
      { windowsHide: true, timeout: 30000 },
    );
    track.path = source;
    track.durationMs = 12000;
  }),
);
await writeFile(filename, `${JSON.stringify(project, null, 2)}\n`);
const evidence = {
  passed: false,
  executable: executable ? path.resolve(executable) : "development Electron",
  directory,
  hardwareAccess: false,
  outputMuted: true,
  deviceTransport: "Explicit mock IPC handlers; no physical hardware",
  checks: [],
  screenshots: [],
  errors: [],
};
let desktop;
let page;
// Observe native Web Audio nodes without substituting samples or implementations.
function installRecordingAudioProbe() {
  const records = [];
  const gains = new Map();
  const createGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function (...args) {
    const gain = createGain.apply(this, args);
    const analyser = this.createAnalyser();
    analyser.fftSize = 2048;
    gain.connect(analyser);
    gains.set(gain, { analyser, samples: new Float32Array(analyser.fftSize) });
    return gain;
  };
  const createSource = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function (...args) {
    const source = createSource.apply(this, args);
    const record = {
      source,
      context: this,
      gain: null,
      started: false,
      ended: false,
      stopCalls: 0,
      frequency: null,
    };
    records.push(record);
    const connect = source.connect;
    source.connect = function (...targets) {
      const result = connect.apply(this, targets);
      if (gains.has(targets[0])) record.gain = targets[0];
      return result;
    };
    const start = source.start;
    source.start = function (...startArgs) {
      const result = start.apply(this, startArgs);
      record.started = true;
      const data = source.buffer.getChannelData(0);
      const first = Math.floor(source.buffer.sampleRate * 0.2);
      const last = Math.min(
        data.length,
        Math.floor(source.buffer.sampleRate * 0.7),
      );
      let crossings = 0;
      for (let index = first + 1; index < last; index++)
        if (data[index - 1] <= 0 && data[index] > 0) crossings++;
      record.frequency = Math.round(
        (crossings * source.buffer.sampleRate) / (last - first),
      );
      return result;
    };
    const stop = source.stop;
    source.stop = function (...stopArgs) {
      const result = stop.apply(this, stopArgs);
      record.stopCalls++;
      return result;
    };
    source.addEventListener("ended", () => {
      record.ended = true;
    });
    return source;
  };
  window.__recordingAudio = {
    snapshot: () =>
      records.map((record) => {
        const observation = gains.get(record.gain);
        let rms = 0;
        if (observation) {
          observation.analyser.getFloatTimeDomainData(observation.samples);
          rms = Math.sqrt(
            observation.samples.reduce((sum, value) => sum + value * value, 0) /
              observation.samples.length,
          );
        }
        return {
          frequency: record.frequency,
          started: record.started,
          ended: record.ended,
          stopCalls: record.stopCalls,
          gain: record.gain?.gain.value,
          rms,
          loop: record.source.loop,
          duration: record.source.buffer?.duration,
          contextState: record.context.state,
        };
      }),
  };
}
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
try {
  desktop = await electron.launch({
    ...(executable ? { executablePath: path.resolve(executable) } : {}),
    args: executable ? ["--mute-audio"] : [".", "--mute-audio"],
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
  page = await desktop.firstWindow();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  await page.addInitScript(installRecordingAudioProbe);
  await desktop.evaluate(({ BrowserWindow, ipcMain, dialog }, file) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.setSize(1500, 1000);
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
    const fixture = { calls: [], uploaded: "", testing: false };
    globalThis.__featuresSmoke = fixture;
    const hello = {
      type: "hello",
      board: "uno",
      sceneControls: true,
      outputTest: true,
      audioFeedback: true,
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace("device:list", () => [
      { path: "MOCK-CONTROLS", manufacturer: "Test only" },
    ]);
    replace("device:get-status", () => ({
      connected: true,
      port: "MOCK-CONTROLS",
      hello,
    }));
    replace("device:connect", () => {
      throw new Error("Physical connection disabled in test");
    });
    replace("device:flash", () => {
      throw new Error("Flashing disabled in test");
    });
    replace("device:disconnect", () => {});
    const stop = () => {
      fixture.testing = false;
      fixture.calls.push({ method: "stop" });
      return { type: "ack" };
    };
    replace("device:ir-cancel", stop);
    replace("device:output-test-end", stop);
    replace("device:command", (_, command) => {
      if (command === "STOP") return stop();
      return {
        type: "status",
        players: [
          { index: 0, feedback: "playing", busy: true },
          { index: 1, feedback: "stopped", busy: false },
        ],
      };
    });
    replace("device:upload", (_, bytes) => {
      fixture.uploaded = JSON.stringify(bytes);
      fixture.calls.push({ method: "upload", length: bytes.length });
      return { type: "ack" };
    });
    replace("device:output-test-begin", (_, bytes) => {
      if (fixture.uploaded !== JSON.stringify(bytes))
        throw new Error("Scene mismatch");
      fixture.testing = true;
      fixture.calls.push({ method: "begin" });
      return { type: "ack" };
    });
    replace("device:output-test-set", (_, mask) => {
      if (!fixture.testing) throw new Error("Test not active");
      fixture.calls.push({ method: "mask", mask });
      return { type: "ack" };
    });
  }, filename);
  await page.reload();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Scene controls with two MP3 players",
  );
  await tab("Hardware");
  await expect(page.getByLabel("Player 1 BUSY feedback")).toBeChecked();
  await expect(page.getByLabel("Player 2 BUSY feedback")).toBeChecked();
  await expect(page.getByLabel("Trigger 3 type")).toHaveValue("timer");
  await page.getByLabel("Trigger 3 timer seconds").fill("25");
  await screenshot("hardware-controls.png");
  await tab("Scene");
  await expect(page.getByLabel("Transition 1 cycle variants")).toBeChecked();
  await expect(page.getByText("Order: Approach → Scare").first()).toBeVisible();
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Approach/ })
    .click();
  await expect(page.getByLabel("Transition 2 edge")).toHaveValue("release");
  await page
    .getByRole("button", {
      name: "Entrance light event 0 to 5 seconds",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Event output value")).toHaveValue("off");
  await screenshot("off-and-release.png");
  await page
    .getByRole("button", { name: "Record performance", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: /Record performance/ });
  await modal.getByLabel("Entrance light recorded value").selectOption("off");
  await modal
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__recordingAudio
          .snapshot()
          .some(
            (voice) =>
              voice.started &&
              !voice.ended &&
              Math.abs(voice.frequency - 440) <= 3 &&
              voice.rms > 0.0001 &&
              Math.abs(voice.gain - 25 / 30) < 0.02 &&
              voice.contextState === "running",
          ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__recordingAudio
          .snapshot()
          .some(
            (voice) =>
              voice.started &&
              !voice.ended &&
              Math.abs(voice.frequency - 220) <= 3 &&
              voice.rms > 0.0001 &&
              Math.abs(voice.gain - 8 / 30) < 0.02 &&
              voice.loop,
          ),
      ),
    )
    .toBe(true);
  evidence.recordingAudio = await page.evaluate(() =>
    window.__recordingAudio.snapshot(),
  );
  await page.keyboard.down("2");
  await new Promise((resolve) => setTimeout(resolve, 180));
  await page.keyboard.up("2");
  await modal.getByRole("button", { name: "Finish take", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__recordingAudio
          .snapshot()
          .filter((voice) => voice.started)
          .every((voice) => voice.ended || voice.stopCalls > 0),
      ),
    )
    .toBe(true);
  await expect(modal).toContainText("1 captured interval");
  await screenshot("recording-review.png");
  await modal
    .getByRole("button", { name: "Apply recording", exact: true })
    .click();
  await page.getByRole("button", { name: /^Air blast event / }).click();
  await page.getByLabel("Event output value").selectOption("off");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(filename, "utf8")).triggers[2]
          .timerIntervalMs,
    )
    .toBe(25000);
  const saved = JSON.parse(await readFile(filename, "utf8"));
  expect(
    saved.states[1].events.some(
      (event) => event.outputId === "output-2" && event.active === false,
    ),
  ).toBe(true);
  expect(saved.states[0].transitions[0].alternateStateIds).toEqual(["scare"]);
  expect(saved.states[2].audioEndStateId).toBe("idle");
  evidence.checks.push(
    "Real desktop open/save preserves timer, variants, BUSY wiring, release, OFF events, and one-pass recording through project IPC",
    "Recording decodes real linked MP3s through desktop IPC, renders native 440 Hz foreground at 25/30 and looping 220 Hz mixed ambient at 8/30 with measured nonzero samples (computer muted), stops both voices, and applies an editable take",
  );
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await page.getByRole("button", { name: "Test outputs", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Manual output test",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  await expect(panel).toContainText("Output test active");
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("Latch physical Entrance light").click();
  await expect
    .poll(() =>
      desktop.evaluate(
        () =>
          globalThis.__featuresSmoke.calls
            .filter((call) => call.method === "mask")
            .at(-1)?.mask,
      ),
    )
    .toBe(1);
  await screenshot("manual-output-test.png");
  await panel.getByRole("button", { name: "All off", exact: true }).click();
  await expect
    .poll(() =>
      desktop.evaluate(
        () =>
          globalThis.__featuresSmoke.calls
            .filter((call) => call.method === "mask")
            .at(-1)?.mask,
      ),
    )
    .toBe(0);
  await panel
    .getByRole("button", { name: "Exit output test", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Show device console", exact: true })
    .click();
  await expect(page.getByLabel("Physical audio feedback")).toContainText(
    "Player 1 · playing · BUSY active",
  );
  evidence.checks.push(
    "Real preload routes begin/mask/stop requests to explicit mocked handlers; test lock, All off, exit, and playback feedback render correctly",
  );
  evidence.calls = await desktop.evaluate(
    () => globalThis.__featuresSmoke.calls,
  );
  expect(evidence.errors).toEqual([]);
  evidence.passed = true;
  console.log(
    `Desktop scene controls smoke passed (mocked hardware): ${directory}`,
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
    "artifacts/desktop-features-results.json",
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
