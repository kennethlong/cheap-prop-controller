import { expect, test, type Page } from "@playwright/test";
import {
  allocatePins,
  createDefaultProject,
  type SceneProject,
} from "../../src/shared";

// Explicit test transport: no browser test opens or transmits to physical hardware.
async function installTransport(
  page: Page,
  project: SceneProject | null = null,
) {
  await page.addInitScript((initial) => {
    let saved: unknown = initial;
    let capture: ((signal: unknown) => void) | null = null;
    const calls: Array<{ method: string; data?: unknown }> = [];
    const hello = {
      type: "hello",
      board: "uno",
      irLearning: true,
      irReplay: true,
    };
    Object.assign(window, {
      cpc: {
        getDeviceStatus: async () => ({
          connected: true,
          port: "MOCK-IR",
          hello,
        }),
        listPorts: async () => [{ path: "MOCK-IR", manufacturer: "Test only" }],
        onDeviceStatus: () => () => {},
        onDeviceLog: () => () => {},
        connect: async () => {
          throw new Error("Physical connections disabled");
        },
        disconnect: async () => {},
        learnIr: () => {
          calls.push({ method: "learn" });
          return new Promise((resolve) => {
            capture = resolve;
          });
        },
        cancelIr: async () => {
          calls.push({ method: "stop" });
          return { type: "ack" };
        },
        testIr: async (command: unknown) => {
          calls.push({ method: "test", data: structuredClone(command) });
          return { type: "ack" };
        },
        deviceCommand: async (command: string) => {
          calls.push({ method: "command", data: command });
          return { type: "ack" };
        },
        uploadScene: async (bytes: unknown) => {
          calls.push({ method: "upload", data: bytes });
          return { type: "ack" };
        },
        saveProject: async (value: unknown) => {
          saved = structuredClone(value);
          return {
            project: structuredClone(saved),
            path: "test/ir-macros.cpc.json",
          };
        },
        openProject: async () =>
          saved
            ? {
                project: structuredClone(saved),
                path: "test/ir-macros.cpc.json",
              }
            : null,
      },
      __irMacroHarness: {
        capture: (signal: unknown) => {
          capture?.(signal);
          capture = null;
        },
        get saved() {
          return saved;
        },
        get calls() {
          return calls;
        },
      },
    });
  }, project);
}

async function tab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true })
    .click();
}

async function save(page: Page): Promise<SceneProject> {
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  return page.evaluate("window.__irMacroHarness.saved");
}

async function learn(
  page: Page,
  name: string,
  code: number,
  count = 1,
  gap = 100,
) {
  await page
    .getByRole("button", { name: "Learn IR command", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await page.evaluate(
    (signal) => {
      (
        window as unknown as {
          __irMacroHarness: { capture(value: unknown): void };
        }
      ).__irMacroHarness.capture(signal);
    },
    { kind: "nec", code },
  );
  const draft = page.getByRole("region", {
    name: "Captured IR command",
    exact: true,
  });
  await draft.getByLabel("Captured name").fill(name);
  await draft.getByLabel("Captured send count").fill(String(count));
  await draft.getByLabel("Captured gap milliseconds").fill(String(gap));
  await draft
    .getByRole("button", { name: "Test captured command", exact: true })
    .click();
  await draft
    .getByRole("button", { name: "Save IR command", exact: true })
    .click();
}

async function pauseClock(page: Page) {
  const start = new Date("2026-10-13T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60_000));
}

function fixture(): SceneProject {
  const project = createDefaultProject();
  project.ir = {
    enabled: true,
    txPin: null,
    rxPin: null,
    commands: [
      {
        id: "on",
        name: "Candles on",
        signal: { kind: "nec", code: 1 },
        sendCount: 1,
        gapMs: 100,
      },
      {
        id: "brighten",
        name: "Slowly brighten",
        signal: { kind: "nec", code: 2 },
        sendCount: 8,
        gapMs: 400,
      },
      {
        id: "off",
        name: "Candles off",
        signal: { kind: "nec", code: 3 },
        sendCount: 1,
        gapMs: 100,
      },
    ],
    macros: [
      {
        id: "candles",
        name: "Candle entrance",
        steps: [
          { id: "step-on", atMs: 0, commandId: "on" },
          { id: "step-brighten", atMs: 1000, commandId: "brighten" },
          { id: "step-off", atMs: 8000, commandId: "off" },
        ],
      },
    ],
  };
  project.states[0].loopTimeline = false;
  project.states[0].irEvents = [
    { id: "candle-cue", atMs: 500, macroId: "candles" },
  ];
  return allocatePins(project).project;
}

async function loadFixture(page: Page) {
  await installTransport(page, fixture());
  await page.goto("/");
  await page.getByRole("button", { name: "Open", exact: true }).click();
}

test("capture and name remote buttons, reuse one macro entry, and reopen its timed preview", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installTransport(page);
  await page.goto("/");
  await tab(page, "Hardware");
  await page.getByLabel("Enable IR remote control").check();
  // Configure the receiver before beginning the same capture workflow as the desktop.
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await learn(page, "Candles on", 1);
  await learn(page, "Slowly brighten", 2, 8, 400);
  await learn(page, "Candles off", 3);
  const library = page.getByRole("region", { name: "IR macros", exact: true });
  await library
    .getByRole("button", { name: "Add IR macro", exact: true })
    .click();
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
  await tab(page, "Scene");
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
  const cue = page.getByRole("button", {
    name: "IR Candle entrance at 0.5 seconds",
    exact: true,
  });
  await expect(cue).toBeVisible();
  await expect(
    page.getByTestId("ir-timeline-lane").getByRole("button"),
  ).toHaveCount(1);
  const saved = await save(page);
  expect(
    saved.ir!.commands.map(({ name, sendCount, gapMs }) => ({
      name,
      sendCount,
      gapMs,
    })),
  ).toEqual([
    { name: "Candles on", sendCount: 1, gapMs: 100 },
    { name: "Slowly brighten", sendCount: 8, gapMs: 400 },
    { name: "Candles off", sendCount: 1, gapMs: 100 },
  ]);
  expect(
    saved.ir!.macros![0].steps.map(({ atMs, commandId }) => ({
      atMs,
      commandId,
    })),
  ).toEqual(
    [0, 1000, 8000].map((atMs, index) => ({
      atMs,
      commandId: saved.ir!.commands[index].id,
    })),
  );
  expect(saved.states[0].irEvents).toEqual([
    expect.objectContaining({ atMs: 500, macroId: saved.ir!.macros![0].id }),
  ]);
  expect(saved.states[0].irEvents![0]).not.toHaveProperty("commandId");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(cue).toBeVisible();
  await pauseClock(page);
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
  await page.screenshot({
    path: "artifacts/ir-macro-preview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  const calls = await page.evaluate<Array<{ method: string; data?: unknown }>>(
    "window.__irMacroHarness.calls",
  );
  expect(calls.filter((call) => call.method === "learn")).toHaveLength(3);
  expect(calls.filter((call) => call.method === "test")).toHaveLength(3);
  expect(calls.filter((call) => call.method === "upload")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "command")).toEqual([]);
  expect(errors).toEqual([]);
});

test("macro edits affect references and pending steps cancel on state exit", async ({
  page,
}) => {
  await loadFixture(page);
  await tab(page, "Hardware");
  await page.getByLabel("IR macro 1 name").fill("Entrance candles");
  await page.getByLabel("IR macro 1 step 3 offset seconds").fill("6");
  await page.getByLabel("IR command 3 name").fill("Extinguish candles");
  await expect(page.getByLabel("IR macro 1 step 3 command")).toHaveValue("off");
  await expect(
    page.getByLabel("IR macro 1 step 3 command").locator("option:checked"),
  ).toHaveText("Extinguish candles");
  await tab(page, "Scene");
  await expect(
    page.getByRole("button", {
      name: "IR Entrance candles at 0.5 seconds",
      exact: true,
    }),
  ).toBeVisible();
  await pauseClock(page);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page.clock.runFor(6000);
  await expect(page.getByTestId("preview-ir-activity")).toHaveText([
    /Candles on/,
    /Slowly brighten/,
  ]);
  await page.clock.runFor(600);
  await expect(page.getByTestId("preview-ir-activity")).toHaveText([
    /Candles on/,
    /Slowly brighten/,
    /Extinguish candles/,
  ]);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page.clock.runFor(1600);
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page.clock.runFor(7000);
  await expect(
    page.getByRole("log", { name: "Preview IR activity" }),
  ).not.toContainText("Extinguish candles");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await tab(page, "Hardware");
  await page
    .getByRole("button", {
      name: "Delete IR command Slowly brighten",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("IR command 2 name")).toHaveValue(
    "Slowly brighten",
  );
  await expect(page.getByRole("alert")).toContainText(/Entrance candles/);
  await page
    .getByRole("button", { name: "Delete IR macro 1 step 2", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Delete IR command Slowly brighten",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const removedCommand = await save(page);
  expect(
    removedCommand.ir!.macros![0].steps.map((step) => step.commandId),
  ).toEqual(["on", "off"]);
  expect(removedCommand.states[0].irEvents).toHaveLength(1);
  await page
    .getByRole("button", {
      name: "Delete IR macro Entrance candles",
      exact: true,
    })
    .click();
  await expect(page.getByRole("dialog")).toContainText(/timeline/i);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const removedMacro = await save(page);
  expect(removedMacro.ir!.macros).toEqual([]);
  expect(removedMacro.states[0].irEvents).toEqual([]);
  expect(removedMacro.ir!.commands.map((command) => command.id)).toEqual([
    "on",
    "off",
  ]);
});

test("a macro step past the state boundary blocks upload until corrected", async ({
  page,
}) => {
  await loadFixture(page);
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeEnabled();
  await tab(page, "Hardware");
  await page.getByLabel("IR macro 1 step 3 offset seconds").fill("10");
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Resolve before deploying", { exact: true }),
  ).toBeVisible();
  const invalid = await save(page);
  expect(invalid.ir!.macros![0].steps[2].atMs).toBe(10000);
  expect(invalid.states[0].irEvents).toHaveLength(1);
  await page.getByLabel("IR macro 1 step 3 offset seconds").fill("8");
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  const calls = await page.evaluate<Array<{ method: string }>>(
    "window.__irMacroHarness.calls",
  );
  expect(calls.filter((call) => call.method === "upload")).toHaveLength(1);
});
