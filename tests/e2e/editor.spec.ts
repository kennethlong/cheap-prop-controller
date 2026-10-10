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
