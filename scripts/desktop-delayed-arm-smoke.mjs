import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

// Exercise the real renderer and context-isolated preload without opening a
// physical serial port. Every hardware IPC handler is replaced before reload.
await mkdir("artifacts", { recursive: true });
const directory = await mkdtemp(path.resolve("artifacts/delayed-arm-smoke-"));
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
  await desktop.evaluate(({ BrowserWindow, ipcMain }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.hide();
      window.webContents.setBackgroundThrottling(false);
    }
    globalThis.__delayedArmCalls = [];
    globalThis.__delayedArmUnexpected = [];
    const hello = {
      type: "hello",
      board: "uno",
      outputTest: true,
      audioFeedback: false,
      irLearning: true,
      irReplay: true,
      manualTriggers: true,
      sceneControls: true,
      parallelChildren: true,
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    const ack = (command) => {
      globalThis.__delayedArmCalls.push({ command, at: Date.now() });
      return { type: "ack", command };
    };
    replace("device:list", () => [{ path: "MOCK" }]);
    replace("device:get-status", () => ({
      connected: true,
      port: "MOCK",
      hello,
    }));
    replace("device:ir-cancel", () => ack("STOP"));
    replace("device:command", (_event, command) => {
      if (command === "RESET" || command === "STATUS") return ack(command);
      globalThis.__delayedArmUnexpected.push(`device:command ${command}`);
      throw new Error(`Unexpected command in delayed-arm smoke: ${command}`);
    });
    for (const channel of [
      "device:connect",
      "device:disconnect",
      "device:flash",
      "device:upload",
      "device:ir-learn",
      "device:ir-test",
      "device:output-test-begin",
      "device:output-test-set",
      "device:output-test-end",
    ])
      replace(channel, () => {
        globalThis.__delayedArmUnexpected.push(channel);
        throw new Error(`Physical hardware access disabled: ${channel}`);
      });
  });
  await page.reload();
  const delayed = page.getByRole("button", {
    name: "Reset & arm in 15 s",
    exact: true,
  });
  const countdown = page.getByRole("status", {
    name: "Delayed arming",
    exact: true,
  });
  const calls = () => desktop.evaluate(() => globalThis.__delayedArmCalls);
  const resetCount = async () =>
    (await calls()).filter((call) => call.command === "RESET").length;
  await expect(delayed).toBeEnabled();
  await delayed.click();
  await expect(countdown).toContainText("Arming in 15 s");
  await expect(
    page.getByRole("button", { name: "Arm / reset", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "STOP", exact: true }),
  ).toBeEnabled();
  await page.waitForTimeout(1200);
  expect(await resetCount()).toBe(0);
  const png = await desktop.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(
        undefined,
        {
          stayHidden: true,
          stayAwake: true,
        },
      )
    )
      .toPNG()
      .toString("base64"),
  );
  await writeFile(
    path.join(directory, "countdown.png"),
    Buffer.from(png, "base64"),
  );
  await expect.poll(resetCount, { timeout: 18000 }).toBe(1);
  await expect(countdown).toHaveCount(0);
  await expect(delayed).toBeEnabled();
  const happyCalls = await calls();
  const stop = happyCalls.find((call) => call.command === "STOP");
  const reset = happyCalls.find((call) => call.command === "RESET");
  expect(reset.at - stop.at).toBeGreaterThanOrEqual(15000);
  evidence.checks.push(
    "Real preload sends STOP then exactly one RESET after at least 15 seconds",
  );
  evidence.checks.push(
    "Countdown is visible; conflicting controls disabled; STOP remains available",
  );
  evidence.armDelayMs = reset.at - stop.at;

  await delayed.click();
  await expect(countdown).toContainText("Arming in 15 s");
  await page.waitForTimeout(1000);
  await page
    .getByRole("button", { name: "Cancel arming", exact: true })
    .click();
  await expect(countdown).toHaveCount(0);
  await expect(delayed).toBeEnabled();
  await page.waitForTimeout(15500);
  expect(await resetCount()).toBe(1);
  evidence.checks.push(
    "Cancel arming remains cancelled beyond its original deadline",
  );
  expect(
    await desktop.evaluate(() => globalThis.__delayedArmUnexpected),
  ).toEqual([]);
  expect(evidence.errors).toEqual([]);
  evidence.commands = await calls();
  evidence.checks.push("No physical hardware access or renderer errors");
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
