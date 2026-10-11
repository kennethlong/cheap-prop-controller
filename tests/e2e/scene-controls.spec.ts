import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createDefaultProject,
  synchronizeAudioPlayers,
  type SceneProject,
} from "../../src/shared";

async function openProject(page: Page, project: SceneProject) {
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "controls.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
async function saveProject(page: Page): Promise<SceneProject> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
async function tab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function state(page: Page, name: string) {
  await page
    .locator(".state-list")
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

test("timer triggers reserve no pin, persist their interval, and advance preview", async ({
  page,
}) => {
  await page.goto("/");
  await tab(page, "Hardware");
  const outputs = page
    .locator(".resource-stat")
    .filter({ hasText: "Outputs available" })
    .locator("strong");
  await expect(outputs).toHaveText("15");
  await page.getByLabel("Trigger 1 type").selectOption("timer");
  await expect(outputs).toHaveText("16");
  await page.getByLabel("Trigger 1 timer seconds").fill("0.2");
  await page.getByLabel("Trigger 1 restart timer").check();
  await expect(page.getByText("SOFTWARE TIMER · No GPIO used")).toBeVisible();
  await tab(page, "Scene");
  const saved = await saveProject(page);
  expect(saved.triggers[0]).toMatchObject({
    kind: "timer",
    pin: null,
    echoPin: null,
    timerIntervalMs: 200,
    timerResetOnTrigger: true,
  });
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
});

test("activation/release and ordered scene variants are editable and preview cycles them", async ({
  page,
}) => {
  const project = createDefaultProject();
  project.states[1].transitions.push({
    triggerId: "approach",
    edge: "release",
    targetStateId: "idle",
  });
  project.states[2].transitions.push({
    triggerId: "approach",
    edge: "release",
    targetStateId: "idle",
  });
  await page.goto("/");
  await openProject(page, project);
  await state(page, "Idle");
  await page.getByLabel("Transition 2 cycle variants").check();
  await page.getByLabel("Transition 2 variant Scare").check();
  await expect(page.getByText("Order: Approach → Scare")).toBeVisible();
  await state(page, "Approach");
  await expect(page.getByLabel("Transition 3 edge")).toHaveValue("release");
  const saved = await saveProject(page);
  expect(saved.states[0].transitions[1].alternateStateIds).toEqual(["scare"]);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page
    .getByRole("button", { name: "Release Approach", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
});

test("OFF intervals override idle-active outputs and are visible in the editor", async ({
  page,
}) => {
  const project = createDefaultProject();
  project.outputs[0].idleActive = true;
  await page.goto("/");
  await openProject(page, project);
  await state(page, "Scare");
  await page
    .getByRole("button", {
      name: "Entrance light event 0 to 3 seconds",
      exact: true,
    })
    .click();
  await page.getByLabel("Event output value").selectOption("off");
  await expect(
    page.getByRole("button", {
      name: "Entrance light event 0 to 3 seconds",
      exact: true,
    }),
  ).toHaveClass(/event-off/);
  const saved = await saveProject(page);
  expect(saved.states[2].events[0].active).toBe(false);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("output-lane-output-1")).toHaveClass(/active/);
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Scare", exact: true })
    .click();
  await expect(page.getByTestId("output-lane-output-1")).not.toHaveClass(
    /active/,
  );
});

test("recorded held keys produce one undoable overdub; replace affects only armed lanes and discard leaves data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.clock.install();
  await page
    .getByRole("button", { name: "Record performance", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: /Record performance/ });
  for (const name of [
    "Air blast",
    "Creature",
    "Spotlight",
    "Output 5",
    "Output 6",
    "Output 7",
    "Output 8",
  ])
    await modal.getByLabel(`Record ${name}`, { exact: true }).uncheck();
  await modal.getByLabel("Entrance light recorded value").selectOption("off");
  await modal
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await expect(modal.getByRole("status")).toContainText("Recording");
  await page.keyboard.down("1");
  await page.clock.runFor(200);
  await page.keyboard.up("1");
  await modal.getByRole("button", { name: "Finish take", exact: true }).click();
  await expect(modal).toContainText("1 captured interval");
  await modal
    .getByRole("button", { name: "Apply recording", exact: true })
    .click();
  let saved = await saveProject(page);
  expect(
    saved.states[2].events.some(
      (event) => event.active === false && event.outputId === "output-1",
    ),
  ).toBe(true);
  expect(
    saved.states[2].events.filter((event) => event.outputId === "output-2"),
  ).toHaveLength(2);
  expect(
    saved.states[2].events.every(
      (event) => event.startMs % 50 === 0 && event.endMs % 50 === 0,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  saved = await saveProject(page);
  expect(saved.states[2].events).toEqual(
    createDefaultProject().states[2].events,
  );
  await page
    .getByRole("button", { name: "Record performance", exact: true })
    .click();
  for (const name of [
    "Air blast",
    "Creature",
    "Spotlight",
    "Output 5",
    "Output 6",
    "Output 7",
    "Output 8",
  ])
    await modal.getByLabel(`Record ${name}`, { exact: true }).uncheck();
  await modal
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await modal.getByRole("button", { name: "Finish take", exact: true }).click();
  await modal.getByLabel("Recording apply mode").selectOption("replace");
  await modal
    .getByRole("button", { name: "Apply recording", exact: true })
    .click();
  saved = await saveProject(page);
  expect(
    saved.states[2].events.some((event) => event.outputId === "output-1"),
  ).toBe(false);
  expect(
    saved.states[2].events.filter((event) => event.outputId === "output-2"),
  ).toHaveLength(2);
  await page
    .getByRole("button", { name: "Record performance", exact: true })
    .click();
  await modal
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.keyboard.down("2");
  await page.clock.runFor(100);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.keyboard.up("2");
  await expect(modal).toContainText("Review your take");
  await modal
    .getByRole("button", { name: "Discard take", exact: true })
    .click();
  expect((await saveProject(page)).states[2].events).toEqual(
    saved.states[2].events,
  );
  expect(errors).toEqual([]);
});

test("BUSY wiring and audio-finished transition persist and finish preview", async ({
  page,
}) => {
  let project = createDefaultProject();
  project.audio.tracks = [{ number: 1, name: "Scare clip", durationMs: 30000 }];
  project.states[1].foregroundTrack = 1;
  project = synchronizeAudioPlayers(project);
  await page.goto("/");
  await openProject(page, project);
  await tab(page, "Hardware");
  await page.getByLabel("Player 1 BUSY feedback").check();
  await expect(page.getByLabel("Player 1 BUSY active low")).toBeChecked();
  await tab(page, "Scene");
  await state(page, "Approach");
  await page.getByLabel("Audio finished target").selectOption("idle");
  const saved = await saveProject(page);
  expect(saved.audio.players[0].feedback).toMatchObject({
    pin: expect.any(Number),
    activeLow: true,
  });
  expect(saved.states[1].audioEndStateId).toBe("idle");
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page.getByRole("button", { name: "Finish audio", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await state(page, "Approach");
  await page.getByLabel("Initial / reset state").check();
  const initial = await saveProject(page);
  expect(initial.initialStateId).toBe("approach");
  expect(initial.states[1].audioEndStateId).toBeNull();
  expect(initial.states[1].foregroundTrack).toBeNull();
});

test("manual output test checks uploaded scene, drives masks, blocks conflicts and stops on exit/blur", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const hello = {
      type: "hello",
      board: "uno",
      outputTest: true,
      audioFeedback: true,
    };
    const status = { connected: true, port: "TEST-ONLY", hello };
    const calls: Array<{ method: string; mask?: number }> = [];
    let uploaded = "";
    let testing = false;
    Object.assign(window, {
      __testCalls: calls,
      cpc: {
        getDeviceStatus: async () => status,
        listPorts: async () => [{ path: "TEST-ONLY" }],
        onDeviceStatus: () => () => {},
        onDeviceLog: () => () => {},
        uploadScene: async (bytes: number[]) => {
          uploaded = JSON.stringify(bytes);
          return { type: "ack" };
        },
        beginOutputTest: async (bytes: number[]) => {
          calls.push({ method: "begin" });
          if (JSON.stringify(bytes) !== uploaded)
            throw new Error("Upload this scene before testing outputs.");
          testing = true;
          return { type: "ack" };
        },
        setTestOutputs: async (mask: number) => {
          if (!testing) throw new Error("No active test");
          calls.push({ method: "mask", mask });
          return { type: "ack" };
        },
        endOutputTest: async () => {
          testing = false;
          calls.push({ method: "stop" });
          return { type: "ack" };
        },
        cancelIr: async () => {
          testing = false;
          calls.push({ method: "stop" });
          return { type: "ack" };
        },
        deviceCommand: async () => ({
          type: "status",
          players: [{ index: 0, feedback: "playing", busy: true }],
        }),
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Test outputs", exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Manual output test",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  await expect(
    page
      .getByText("Upload this scene before testing outputs.", { exact: false })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await panel
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  await expect(panel).toContainText("Output test active");
  await expect(
    page.getByRole("button", { name: "Upload scene", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Arm / reset", exact: true }),
  ).toBeDisabled();
  await panel.getByLabel("Latch physical Entrance light").click();
  await expect
    .poll(() =>
      page.evaluate(
        "window.__testCalls.filter(c => c.method === 'mask').at(-1)?.mask",
      ),
    )
    .toBe(1);
  await panel.getByRole("button", { name: "All off", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        "window.__testCalls.filter(c => c.method === 'mask').at(-1)?.mask",
      ),
    )
    .toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    panel.getByRole("button", { name: "Enter output test", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate("window.__testCalls.at(-1)?.method"))
    .toBe("stop");
  await panel
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  await panel.getByLabel("Hold physical Entrance light").focus();
  await page.keyboard.down("Space");
  await expect
    .poll(() =>
      page.evaluate(
        "window.__testCalls.filter(c => c.method === 'mask').at(-1)?.mask",
      ),
    )
    .toBe(1);
  await page.keyboard.up("Space");
  await expect
    .poll(() =>
      page.evaluate(
        "window.__testCalls.filter(c => c.method === 'mask').at(-1)?.mask",
      ),
    )
    .toBe(0);
  await expect(
    page.getByRole("button", { name: "Play preview", exact: true }),
  ).toBeVisible();
  const hold = panel.getByLabel("Hold physical Entrance light");
  const holdBox = await hold.boundingBox();
  await page.mouse.move(
    holdBox!.x + holdBox!.width / 2,
    holdBox!.y + holdBox!.height / 2,
  );
  await page.mouse.down();
  await page.keyboard.down("Space");
  await page.mouse.up();
  await expect(hold).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  await expect(hold).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Enter output test", exact: true }),
  ).toBeEnabled();
  const showConsole = page.getByRole("button", {
    name: "Show device console",
    exact: true,
  });
  if (await showConsole.count()) await showConsole.click();
  await expect(page.getByLabel("Physical audio feedback")).toContainText(
    "Player 1 · playing · BUSY active",
  );
});
