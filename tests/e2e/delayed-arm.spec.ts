import { expect, test, type Page } from "@playwright/test";
import type { DesktopAPI, DeviceStatus } from "../../src/desktop-api";

interface ArmProbe {
  calls: { command: string; at: number }[];
  stopMode: "ack" | "pending" | "error";
  resetMode: "ack" | "pending" | "error";
  releaseStop(): void;
  releaseReset(): void;
  emitConnection(connected: boolean): void;
}
declare global {
  interface Window {
    __armProbe: ArmProbe;
  }
}

async function setup(page: Page) {
  await page.clock.install({ time: new Date("2026-10-12T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-12T12:00:00Z"));
  await page.addInitScript(() => {
    const listeners = new Set<(value: DeviceStatus) => void>();
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
    let status: DeviceStatus = { connected: true, port: "TEST", hello };
    let resolveStop: (() => void) | undefined;
    let resolveReset: (() => void) | undefined;
    const probe: ArmProbe = {
      calls: [],
      stopMode: "ack",
      resetMode: "ack",
      releaseStop() {
        resolveStop?.();
        resolveStop = undefined;
      },
      releaseReset() {
        resolveReset?.();
        resolveReset = undefined;
      },
      emitConnection(connected) {
        status = { connected, ...(connected ? { port: "TEST", hello } : {}) };
        listeners.forEach((listener) => listener(status));
      },
    };
    window.__armProbe = probe;
    const record = (command: string) =>
      probe.calls.push({ command, at: performance.now() });
    const unsupported = async (): Promise<never> => {
      throw new Error("Unexpected hardware operation in delayed-arm test");
    };
    const api: DesktopAPI = {
      listPorts: async () => [{ path: "TEST" }],
      getDeviceStatus: async () => status,
      connect: async () => {
        probe.emitConnection(true);
        return hello;
      },
      disconnect: async () => probe.emitConnection(false),
      cancelIr: async () => {
        record("STOP");
        if (probe.stopMode === "error")
          throw new Error("STOP acknowledgement failed");
        if (probe.stopMode === "pending")
          await new Promise<void>((resolve) => {
            resolveStop = resolve;
          });
        return { type: "ack", command: "STOP" };
      },
      deviceCommand: async (command) => {
        record(command);
        if (command === "RESET" && probe.resetMode === "error")
          throw new Error("RESET acknowledgement failed");
        if (command === "RESET" && probe.resetMode === "pending")
          await new Promise<void>((resolve) => {
            resolveReset = resolve;
          });
        if (command === "STATUS") return { type: "status", running: false };
        return { type: "ack", command };
      },
      onDeviceStatus: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      onDeviceLog: () => () => {},
      saveProject: async (project) => ({
        project: {
          ...structuredClone(project),
          name: "Saved delayed-arm project",
        },
        path: "C:/test/delayed-arm.cpc.json",
      }),
      openProject: async () => null,
      learnIr: unsupported,
      testIr: unsupported,
      beginOutputTest: unsupported,
      setTestOutputs: unsupported,
      endOutputTest: unsupported,
      uploadScene: unsupported,
      flashFirmware: unsupported,
      importAudio: async () => null,
      readAudio: unsupported,
      saveTrimmedAudio: async () => null,
      exportMedia: async () => null,
    };
    window.cpc = api;
  });
  await page.goto("/");
  await expect(delayedButton(page)).toBeEnabled();
}

const delayedButton = (page: Page) =>
  page.getByRole("button", { name: "Reset & arm in 15 s", exact: true });
const countdown = (page: Page) =>
  page.getByRole("status", { name: "Delayed arming", exact: true });
const resetCalls = (page: Page) =>
  page.evaluate(() =>
    window.__armProbe.calls.filter((call) => call.command === "RESET"),
  );
async function assertRestored(page: Page) {
  await expect(countdown(page)).toHaveCount(0);
  await expect(delayedButton(page)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Arm / reset", exact: true }),
  ).toBeEnabled();
}

test("waits a full fifteen seconds after STOP acknowledgement and arms exactly once", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: "Show device console", exact: true })
    .click();
  await page.evaluate(() => {
    window.__armProbe.stopMode = "pending";
  });
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Stopping controller");
  for (const name of [
    "Arm / reset",
    "Upload scene",
    "Send trigger",
    "Test outputs",
    "Firmware",
    "Record performance",
  ])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "STOP", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Cancel arming", exact: true }),
  ).toBeEnabled();
  await page.clock.runFor(20000);
  expect(await resetCalls(page)).toHaveLength(0);
  await page.evaluate(() => window.__armProbe.releaseStop());
  await expect(countdown(page)).toContainText("Arming in 15 s");
  const acknowledgedAt = await page.evaluate(() => performance.now());
  // Moving away from the app while leaving the room must not cancel arming.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.clock.runFor(14000);
  await expect(countdown(page)).toContainText("Arming in 1 s");
  await page.clock.runFor(999);
  expect(await resetCalls(page)).toHaveLength(0);
  await page.clock.runFor(1);
  await expect.poll(async () => (await resetCalls(page)).length).toBe(1);
  expect(
    (await resetCalls(page))[0].at - acknowledgedAt,
  ).toBeGreaterThanOrEqual(15000);
  await assertRestored(page);
  await page.clock.runFor(30000);
  expect(await resetCalls(page)).toHaveLength(1);
});

test("Cancel arming and STOP prevent late resets and restore controls", async ({
  page,
}) => {
  await setup(page);
  for (const name of ["Cancel arming", "STOP"]) {
    await delayedButton(page).click();
    await expect(countdown(page)).toContainText("Arming in 15 s");
    await page.clock.runFor(5000);
    await page.getByRole("button", { name, exact: true }).click();
    await assertRestored(page);
    await page.clock.runFor(20000);
    expect(await resetCalls(page)).toHaveLength(0);
  }
  const stops = await page.evaluate(() =>
    window.__armProbe.calls.filter((call) => call.command === "STOP"),
  );
  expect(stops.length).toBeGreaterThanOrEqual(3);
});

test("a late STOP acknowledgement cannot restart cancelled arming", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__armProbe.stopMode = "pending";
  });
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Stopping controller");
  await page
    .getByRole("button", { name: "Cancel arming", exact: true })
    .click();
  await page.evaluate(() => window.__armProbe.releaseStop());
  await assertRestored(page);
  await page.clock.runFor(30000);
  expect(await resetCalls(page)).toHaveLength(0);
});

test("cancelling an in-flight RESET sends priority STOP and ignores its late acknowledgement", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__armProbe.resetMode = "pending";
  });
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Arming in 15 s");
  await page.clock.runFor(15000);
  await expect(countdown(page)).toContainText("Arming controller");
  expect(await resetCalls(page)).toHaveLength(1);
  await page
    .getByRole("button", { name: "Cancel arming", exact: true })
    .click();
  await assertRestored(page);
  expect(
    await page.evaluate(() =>
      window.__armProbe.calls.map((call) => call.command),
    ),
  ).toEqual(["STOP", "RESET", "STOP"]);
  await page.evaluate(() => window.__armProbe.releaseReset());
  await page.clock.runFor(30000);
  await assertRestored(page);
  expect(
    await page.evaluate(() =>
      window.__armProbe.calls.map((call) => call.command),
    ),
  ).toEqual(["STOP", "RESET", "STOP"]);
  await expect(
    page.getByText(
      "Controller reset and armed after the 15-second exit delay.",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
});

test("connection loss cancels the deadline even when the same controller reconnects", async ({
  page,
}) => {
  await setup(page);
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Arming in 15 s");
  await page.clock.runFor(5000);
  await page.evaluate(() => window.__armProbe.emitConnection(false));
  await expect(countdown(page)).toHaveCount(0);
  await expect(delayedButton(page)).toBeDisabled();
  await page.evaluate(() => window.__armProbe.emitConnection(true));
  await assertRestored(page);
  await page.clock.runFor(20000);
  expect(await resetCalls(page)).toHaveLength(0);
});

test("workspace and project replacement cancel pending arming", async ({
  page,
}) => {
  await setup(page);
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Arming in 15 s");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Hardware", exact: true })
    .click();
  await assertRestored(page);
  await page.clock.runFor(20000);
  expect(await resetCalls(page)).toHaveLength(0);
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Arming in 15 s");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Saved delayed-arm project",
  );
  await assertRestored(page);
  await page.clock.runFor(20000);
  expect(await resetCalls(page)).toHaveLength(0);
});

test("STOP and RESET failures are visible and do not leave controls locked or retry", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__armProbe.stopMode = "error";
  });
  await delayedButton(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "STOP acknowledgement failed",
  );
  await assertRestored(page);
  await page.clock.runFor(20000);
  expect(await resetCalls(page)).toHaveLength(0);
  await page.evaluate(() => {
    window.__armProbe.stopMode = "ack";
    window.__armProbe.resetMode = "error";
  });
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Arming in 15 s");
  await page.clock.runFor(15000);
  await expect(page.getByRole("alert")).toContainText(
    "RESET acknowledgement failed",
  );
  await assertRestored(page);
  await page.clock.runFor(30000);
  expect(await resetCalls(page)).toHaveLength(1);
});

test("leaving the document invalidates arming before a late STOP acknowledgement", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__armProbe.stopMode = "pending";
  });
  await delayedButton(page).click();
  await expect(countdown(page)).toContainText("Stopping controller");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.evaluate(() => window.__armProbe.releaseStop());
  await page.clock.runFor(30000);
  expect(await resetCalls(page)).toHaveLength(0);
});
