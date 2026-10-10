import { _electron as electron, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const port = process.argv[2];
if (!port)
  throw new Error(
    "Usage: node scripts/desktop-smoke.mjs COM6 (bare, disposable test controller only)",
  );
const desktop = await electron.launch({
  ...(process.env.CPC_EXECUTABLE
    ? { executablePath: process.env.CPC_EXECUTABLE }
    : {}),
  args: process.env.CPC_EXECUTABLE ? ["--mute-audio"] : [".", "--mute-audio"],
  env: {
    ...process.env,
    CPC_TEST_HIDDEN: process.argv.includes("--visible") ? "0" : "1",
  },
});
const page = await desktop.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const results = [];
try {
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Midnight workshop",
  );
  await expect(page.getByLabel("Serial port", { exact: true })).toBeVisible();
  await expect(
    page
      .getByLabel("Serial port", { exact: true })
      .locator(`option[value="${port}"]`),
  ).toHaveCount(1);
  await page.getByLabel("Serial port", { exact: true }).selectOption(port);
  if (process.argv.includes("--flash")) {
    await page.getByRole("button", { name: "Firmware", exact: true }).click();
    await page
      .getByRole("button", { name: "Install firmware", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Firmware installed", {
      timeout: 30000,
    });
    results.push({
      check: "Desktop installs bundled firmware through AVRDUDE",
      passed: true,
    });
    await page
      .getByRole("button", { name: "Hide device console", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible({ timeout: 12000 });
  results.push({
    check: "Electron preload, native serial and firmware handshake",
    passed: true,
  });
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Scene uploaded", {
    timeout: 12000,
  });
  results.push({
    check: "Editor compiler through IPC and real USB scene upload",
    passed: true,
  });
  await page
    .getByRole("button", { name: "Show device console", exact: true })
    .click();
  await page.getByLabel("Physical trigger").selectOption("0");
  await page.getByRole("button", { name: "Send trigger", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Read status", exact: true }),
  ).toBeEnabled();
  const status = await page.evaluate(() => window.cpc.deviceCommand("STATUS"));
  expect(status.state).toBe(1);
  expect(status.outputs).toBe(1);
  results.push({
    check: "Physical trigger button executes Approach on Uno",
    passed: true,
    status,
  });
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Read status", exact: true }),
  ).toBeEnabled();
  const stopped = await page.evaluate(() => window.cpc.deviceCommand("STATUS"));
  expect(stopped.running).toBe(false);
  expect(stopped.outputs).toBe(0);
  results.push({
    check: "Desktop STOP disarms actual controller",
    passed: true,
    status: stopped,
  });
  const denseImage = Array.from(
    await readFile("artifacts/scenes/uno-dense.bin"),
  );
  const interrupted = await page.evaluate(async (bytes) => {
    const upload = window.cpc.uploadScene(bytes).then(
      () => ({ completed: true }),
      (error) => ({ completed: false, error: String(error) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    const start = performance.now();
    await window.cpc.deviceCommand("STOP");
    const latencyMs = performance.now() - start;
    return {
      upload: await upload,
      latencyMs,
      status: await window.cpc.deviceCommand("STATUS"),
    };
  }, denseImage);
  expect(interrupted.upload.completed).toBe(false);
  expect(interrupted.status.running).toBe(false);
  expect(interrupted.status.outputs).toBe(0);
  expect(interrupted.latencyMs).toBeLessThan(500);
  results.push({
    check: "STOP cancels an actual in-progress EEPROM upload",
    passed: true,
    ...interrupted,
  });
  const sampleImage = Array.from(await readFile("artifacts/scenes/uno.bin"));
  await page.evaluate((bytes) => window.cpc.uploadScene(bytes), sampleImage);
  await page.evaluate(() => window.cpc.deviceCommand("STOP"));
  await page
    .getByRole("button", { name: "Hide device console", exact: true })
    .click();
  await page.screenshot({
    path: "artifacts/desktop-connected.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
} finally {
  try {
    await page.evaluate(async () => {
      await window.cpc.deviceCommand("STOP");
      await window.cpc.disconnect();
    });
  } catch {
    /* Cleanup after a failed connection. */
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/desktop-smoke-results.json",
    JSON.stringify({ results, errors }, null, 2),
  );
  await desktop.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
  });
  await desktop.close();
}
console.log(JSON.stringify({ results, errors }, null, 2));
