import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("preview follows the three-state scene and shows active outputs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Midnight workshop",
  );
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  const triggers = page.locator(".preview-buttons");
  await triggers.getByRole("button", { name: "Approach", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await expect(page.getByTestId("output-lane-output-1")).toHaveClass(/active/);
  await triggers.getByRole("button", { name: "Scare", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
  await triggers.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await expect(page.getByTestId("output-lane-output-1")).not.toHaveClass(
    /active/,
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  expect(errors).toEqual([]);
});

test("draw, edit, delete, undo, save, and reopen a timeline event", async ({
  page,
}) => {
  await page.goto("/");
  const lane = page.getByTestId("output-lane-output-8").locator(".lane-track");
  const box = await lane.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 30, box!.y + 18);
  await page.mouse.down();
  await page.mouse.move(box!.x + 145, box!.y + 18, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByLabel("Event start seconds")).toBeVisible();
  await page.getByLabel("Event start seconds").fill("2");
  await page.getByLabel("Event end seconds").fill("4");
  const event = page.getByRole("button", {
    name: "Output 8 event 2 to 4 seconds",
    exact: true,
  });
  await expect(event).toBeVisible();
  await page.getByRole("button", { name: "Delete event", exact: true }).click();
  await expect(event).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(event).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const data = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(
    data.states.find((state: { id: string }) => state.id === "scare").events,
  ).toContainEqual(
    expect.objectContaining({
      outputId: "output-8",
      startMs: 2000,
      endMs: 4000,
    }),
  );
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "saved.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Scare/ })
    .click();
  await expect(event).toBeVisible();
});

test("hardware allocation responds to board and two-pin ultrasonic inputs", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await page.getByLabel("Microcontroller").selectOption("mega");
  await expect(
    page
      .locator(".resource-stat")
      .filter({ hasText: "Outputs available" })
      .locator("strong"),
  ).toHaveText("32");
  await page.getByLabel("Microcontroller").selectOption("uno");
  await expect(
    page
      .locator(".resource-stat")
      .filter({ hasText: "Outputs available" })
      .locator("strong"),
  ).toHaveText("15");
  await page.getByLabel("Trigger 1 type").selectOption("ultrasonic");
  await expect(
    page
      .locator(".resource-stat")
      .filter({ hasText: "Outputs available" })
      .locator("strong"),
  ).toHaveText("14");
  await expect(page.locator(".trigger-card").first()).toContainText("ECHO");
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page.screenshot({ path: "artifacts/editor-scene.png", fullPage: true });
});

test("malformed import and invalid event edits remain repairable", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole("alert")).toContainText("Could not open project");
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Midnight workshop",
  );
  await page
    .getByRole("button", {
      name: "Entrance light event 0 to 3 seconds",
      exact: true,
    })
    .click();
  await page.getByLabel("Event end seconds").fill("0");
  await expect(page.getByText("Resolve before deploying")).toBeVisible();
  await page.getByLabel("Event end seconds").fill("3");
  await expect(page.getByText("Resolve before deploying")).toHaveCount(0);
});

test("fade-through settings persist and reserve one player unless ambient continues", async ({
  page,
}) => {
  const sample = JSON.parse(
    await readFile("examples/three-state-starter.cpc.json", "utf8"),
  );
  sample.audio.tracks = [
    { number: 1, name: "Ambient" },
    { number: 2, name: "Approach" },
    { number: 3, name: "Scare" },
  ];
  sample.audio.ambientTrack = 1;
  sample.audio.keepAmbient = false;
  sample.audio.fadeMs = 400;
  sample.states.find(
    (state: { id: string }) => state.id === "approach",
  ).foregroundTrack = 2;
  sample.states.find(
    (state: { id: string }) => state.id === "scare",
  ).foregroundTrack = 3;

  await page.goto("/");
  const projectInput = page.locator('input[type=file][accept=".json,.cpc"]');
  await projectInput.setInputFiles({
    name: "legacy-audio.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  const playerCount = page
    .locator(".resource-stat")
    .filter({ hasText: "Players required by these settings" })
    .locator("strong");
  await expect(page.getByLabel("Audio transition")).toHaveValue("crossfade");
  await expect(page.getByLabel("Crossfade milliseconds")).toHaveValue("400");
  await expect(playerCount).toHaveText("2");

  await page.getByLabel("Audio transition").selectOption("fade-through");
  await expect(page.getByLabel("Fade-out milliseconds")).toHaveValue("250");
  await expect(page.getByLabel("Fade-in milliseconds")).toHaveValue("250");
  await expect(page.getByLabel("Crossfade milliseconds")).toHaveCount(0);
  await expect(playerCount).toHaveText("1");
  await page.getByLabel("Fade-out milliseconds").fill("200");
  await page.getByLabel("Fade-in milliseconds").fill("450");
  await page
    .getByLabel("Keep ambient running silently during foreground audio")
    .check();
  await expect(playerCount).toHaveText("2");
  await page
    .getByLabel("Keep ambient running silently during foreground audio")
    .uncheck();
  await expect(playerCount).toHaveText("1");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(saved.audio).toMatchObject({
    transitionMode: "fade-through",
    fadeOutMs: 200,
    fadeInMs: 450,
    fadeMs: 400,
  });
  expect(saved.audio.players).toHaveLength(1);

  await page.getByLabel("Audio transition").selectOption("cut");
  await expect(page.getByLabel("Fade-out milliseconds")).toHaveCount(0);
  await expect(page.getByLabel("Fade-in milliseconds")).toHaveCount(0);
  await expect(playerCount).toHaveText("1");
  await projectInput.setInputFiles({
    name: "saved-fades.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await expect(page.getByLabel("Audio transition")).toHaveValue("fade-through");
  await expect(page.getByLabel("Fade-out milliseconds")).toHaveValue("200");
  await expect(page.getByLabel("Fade-in milliseconds")).toHaveValue("450");
  await expect(playerCount).toHaveText("1");
});
