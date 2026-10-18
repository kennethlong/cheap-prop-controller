import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createDefaultProject,
  createState,
  createTrigger,
  synchronizeAudioPlayers,
  type SceneProject,
} from "../../src/shared";

async function openProject(page: Page, project: SceneProject) {
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "manual-beam.cpc.json",
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

async function selectState(page: Page, name: string) {
  await page
    .locator(".state-list")
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

test("manual advance uses no GPIO and stays independent of the beam child", async ({
  page,
}) => {
  let project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 5);
  project.triggers = [{ ...createTrigger("beam", "IR beam"), debounceMs: 0 }];
  project.audio.ambientTrack = 1;
  project.audio.tracks = [1, 2, 3].map((number) => ({
    number,
    name: `Track ${number}`,
    durationMs: 30000,
  }));
  project.audio.transitionMode = "cut";
  project.audio.fadeMs = 0;
  project.states[1].foregroundTrack = 2;
  project.states[2].foregroundTrack = 3;
  project.states.forEach((state) => {
    state.transitions = [{ triggerId: "beam", targetStateId: "blast" }];
  });
  project.states.push({
    ...createState("blast", "Ankle blaster"),
    kind: "child",
    durationMs: 250,
    cooldownMs: 2000,
    events: [{ id: "pulse", outputId: "output-5", startMs: 0, endMs: 250 }],
  });
  project = synchronizeAudioPlayers(project);
  await page.goto("/");
  await openProject(page, project);
  const before = await saveProject(page);
  expect(before.outputs.map((output) => output.pin)).toEqual([7, 6, 5, 4, 9]);
  expect(before.triggers[0].pin).toBe(8);
  expect(before.audio.players[0]).toMatchObject({ txPin: 2, rxPin: 3 });

  await tab(page, "Hardware");
  const capacity = page
    .locator(".resource-stat")
    .filter({ hasText: "Outputs available" })
    .locator("strong");
  const originalCapacity = await capacity.textContent();
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await page.getByLabel("Trigger 2 name").fill("Next audio state");
  await page.getByLabel("Trigger 2 type").selectOption("manual");
  await expect(capacity).toHaveText(originalCapacity!);
  const manualCard = page.locator(".trigger-card").nth(1);
  await expect(manualCard).toContainText("APP TRIGGER · No GPIO used");
  await expect(manualCard).toContainText("no wiring needed");
  await expect(
    manualCard.getByLabel(/Active low|Internal pull-up/),
  ).toHaveCount(0);
  await expect(page.getByLabel("Trigger 2 debounce")).toHaveCount(0);
  const configured = await saveProject(page);
  const manual = configured.triggers[1];
  expect(manual).toMatchObject({
    name: "Next audio state",
    kind: "manual",
    pin: null,
    echoPin: null,
    activeLow: false,
    pullup: false,
    debounceMs: 0,
    thresholdCm: 0,
    hysteresisCm: 0,
  });
  expect(configured.outputs).toEqual(before.outputs);
  expect(configured.triggers[0]).toEqual(before.triggers[0]);
  expect(configured.audio.players).toEqual(before.audio.players);

  // A manual trigger can become any physical input again without hidden invalid
  // threshold values left over from its pin-free configuration.
  for (const kind of ["button", "pir", "ultrasonic"]) {
    await page.getByLabel("Trigger 2 type").selectOption(kind);
    await expect(
      page.getByText("Resolve before deploying", { exact: true }),
    ).toHaveCount(0);
    const physical = (await saveProject(page)).triggers[1];
    expect(physical).toMatchObject({
      kind,
      thresholdCm: 100,
      hysteresisCm: 20,
    });
    expect(physical.pin).not.toBeNull();
    await page.getByLabel("Trigger 2 type").selectOption("manual");
  }
  await expect(capacity).toHaveText(originalCapacity!);

  await tab(page, "Scene");
  for (const [name, target] of [
    ["Idle", "approach"],
    ["Approach", "scare"],
    ["Scare", "idle"],
  ]) {
    await selectState(page, name);
    await page
      .getByRole("button", { name: "Add transition", exact: true })
      .click();
    // The available beam-release transition is converted to manual activation.
    await page.getByLabel("Transition 2 trigger").selectOption(manual.id);
    await expect(page.getByLabel("Transition 2 edge")).toHaveValue("activate");
    await expect(
      page.getByLabel("Transition 2 edge").locator('option[value="release"]'),
    ).toHaveCount(0);
    await page.getByLabel("Transition 2 target state").selectOption(target);
  }
  const saved = await saveProject(page);
  await openProject(page, saved);
  await page.getByRole("button", { name: "Show device console" }).click();
  await expect(page.getByLabel("Controller trigger")).toHaveValue(manual.id);
  await expect(
    page.getByLabel("Controller trigger").locator("option"),
  ).toHaveText(["IR beam", "Next audio state (app)"]);
  await page.getByRole("button", { name: "Hide device console" }).click();

  const clockStart = new Date("2026-10-12T12:00:00Z");
  await page.clock.install({ time: clockStart });
  // Pause at a future instant, rather than racing the browser against the
  // runner's wall clock while this idle page is still using advancing time.
  await page.clock.pauseAt(new Date(clockStart.getTime() + 60_000));
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  const preview = page.locator(".preview-buttons");
  const beam = preview.getByRole("button", { name: "IR beam", exact: true });
  const next = preview.getByRole("button", {
    name: "Next audio state",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Release Next audio state" }),
  ).toHaveCount(0);
  await beam.click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "running",
  );
  await page.clock.runFor(2300);
  await next.click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page.clock.runFor(1000);
  const parentTime = Number(
    await page.getByTestId("preview-state").getAttribute("data-elapsed-ms"),
  );
  const foreground = page.getByTestId("preview-audio-foreground-0");
  const audioTime = Number(await foreground.getAttribute("data-position-ms"));
  await beam.click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "running",
  );
  await page.clock.runFor(100);
  expect(
    Number(
      await page.getByTestId("preview-state").getAttribute("data-elapsed-ms"),
    ),
  ).toBeGreaterThan(parentTime);
  expect(
    Number(await foreground.getAttribute("data-position-ms")),
  ).toBeGreaterThan(audioTime);
  await next.click();
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "running",
  );
  await page.clock.runFor(200);
  await next.click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await expect(page.getByTestId("preview-child-blast")).toHaveAttribute(
    "data-phase",
    "cooldown",
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
});
