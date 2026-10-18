import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createDefaultProject,
  synchronizeAudioPlayers,
  type SceneProject,
} from "../../src/shared";

async function openProject(page: Page, project: SceneProject) {
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "parallel.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
async function saveProject(page: Page): Promise<SceneProject> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
async function selectState(page: Page, name: string) {
  await page
    .locator(".state-list")
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

test("child pulse presets persist and run alongside the parent's timeline and audio", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let project = createDefaultProject();
  project.audio.tracks = [
    { number: 1, name: "Approach audio", durationMs: 30000 },
  ];
  project.states[1].foregroundTrack = 1;
  project.audio.fadeMs = 0;
  project = synchronizeAudioPlayers(project);
  await page.goto("/");
  await openProject(page, project);
  await page
    .getByRole("button", { name: "Add child sequence", exact: true })
    .click();
  await page.getByLabel("State name", { exact: true }).fill("Ankle pulse");
  await expect(page.getByText("Parallel child", { exact: true })).toBeVisible();
  for (const duration of [100, 150, 200, 250, 300, 350, 400, 450, 500]) {
    await page
      .getByLabel("Event duration milliseconds")
      .selectOption(String(duration));
    await expect(page.getByLabel("State duration seconds")).toHaveValue(
      String(duration / 1000),
    );
    await expect(page.getByLabel("Event end seconds")).toHaveValue(
      String(duration / 1000),
    );
  }
  await page.getByLabel("Event duration milliseconds").selectOption("250");
  await page.getByLabel("Child cooldown seconds").fill("2");
  await expect(page.getByLabel("Foreground track")).toHaveCount(0);
  await expect(page.getByLabel("Initial / reset state")).toHaveCount(0);
  await expect(page.getByLabel("Loop timeline")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Record performance", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add transition", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("ir-timeline-lane")).toHaveCount(0);
  await expect(page.getByTestId("child-output-ownership")).toContainText(
    "Output 5",
  );
  await selectState(page, "Approach");
  const childOption = page
    .getByLabel("Transition 2 target state")
    .getByRole("option", {
      name: "Run child: Ankle pulse (parallel)",
      exact: true,
    });
  const childId = (await childOption.getAttribute("value"))!;
  await page.getByLabel("Transition 2 target state").selectOption(childId);
  await expect(page.getByLabel("Transition 2 cycle variants")).toBeDisabled();
  await expect(
    page
      .getByLabel("Audio finished target")
      .locator(`option[value="${childId}"]`),
  ).toHaveCount(0);
  const reservedLane = page.getByTestId("output-lane-output-5");
  await expect(reservedLane.locator(".lane-track")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(reservedLane).toContainText("Reserved for child: Ankle pulse");
  await reservedLane
    .locator(".lane-track")
    .click({ position: { x: 80, y: 12 } });
  await page
    .getByRole("button", { name: "Record performance", exact: true })
    .click();
  await expect(
    page.getByLabel("Record Output 5", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const saved = await saveProject(page);
  expect(saved.states[1].events).toEqual(project.states[1].events);
  expect(saved.states.find((state) => state.id === childId)).toMatchObject({
    kind: "child",
    durationMs: 250,
    cooldownMs: 2000,
    events: [{ outputId: "output-5", startMs: 0, endMs: 250 }],
  });
  await openProject(page, saved);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Approach", exact: true })
    .click();
  await page.clock.runFor(1000);
  const parentTime = Number(
    await page.getByTestId("preview-state").getAttribute("data-elapsed-ms"),
  );
  const audioTime = Number(
    await page
      .getByTestId("preview-audio-foreground-0")
      .getAttribute("data-position-ms"),
  );
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Scare", exact: true })
    .click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await expect(
    page.getByRole("heading", { name: "Approach", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveAttribute(
    "data-phase",
    "running",
  );
  await expect(reservedLane).toHaveClass(/active/);
  await expect(page.getByTestId("output-lane-output-1")).toHaveClass(/active/);
  expect(
    Number(
      await page.getByTestId("preview-state").getAttribute("data-elapsed-ms"),
    ),
  ).toBeGreaterThanOrEqual(parentTime);
  expect(
    Number(
      await page
        .getByTestId("preview-audio-foreground-0")
        .getAttribute("data-position-ms"),
    ),
  ).toBeGreaterThanOrEqual(audioTime);
  await selectState(page, "Ankle pulse");
  await page.clock.runFor(100);
  await expect(page.getByTestId("playhead-time")).toHaveText("00:00.10");
  await expect(
    page.getByRole("heading", { name: "Ankle pulse", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page.screenshot({
    path: testInfo.outputPath("parallel-child-preview.png"),
    fullPage: true,
  });
  await page.clock.runFor(200);
  await expect(reservedLane).not.toHaveClass(/active/);
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveAttribute(
    "data-phase",
    "cooldown",
  );
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Scare", exact: true })
    .click();
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveAttribute(
    "data-phase",
    "cooldown",
  );
  await page.clock.runFor(2000);
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveCount(0);
  expect(
    Number(
      await page.getByTestId("preview-state").getAttribute("data-elapsed-ms"),
    ),
  ).toBeGreaterThan(parentTime + 2200);
  expect(
    Number(
      await page
        .getByTestId("preview-audio-foreground-0")
        .getAttribute("data-position-ms"),
    ),
  ).toBeGreaterThan(audioTime + 2200);
  await page
    .locator(".preview-buttons")
    .getByRole("button", { name: "Scare", exact: true })
    .click();
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveAttribute(
    "data-phase",
    "running",
  );
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect(page.getByTestId(`preview-child-${childId}`)).toHaveCount(0);
  await expect(reservedLane).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test("child creation explains when all outputs already belong to timelines", async ({
  page,
}) => {
  const project = createDefaultProject();
  project.outputs = project.outputs.slice(0, 4);
  await page.goto("/");
  await openProject(page, project);
  await page
    .getByRole("button", { name: "Add child sequence", exact: true })
    .click();
  await expect(
    page.getByText(/A child needs an output that is off at idle/),
  ).toBeVisible();
  expect((await saveProject(page)).states).toHaveLength(3);
});
