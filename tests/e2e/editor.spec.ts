import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("distance zones edit and persist without consuming more pins, and state deletion cleans their actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await page.getByLabel("Trigger 1 type").selectOption("ultrasonic");
  const outputs = page
    .locator(".resource-stat")
    .filter({ hasText: "Outputs available" })
    .locator("strong");
  await expect(outputs).toHaveText("14");
  await page.getByLabel("Trigger 1 distance behavior").selectOption("zones");
  const near = page.getByRole("region", {
    name: "Approach zone 1",
    exact: true,
  });
  await near.getByLabel("Zone 1 minimum distance").fill("40");
  await near.getByLabel("Zone 1 maximum distance").fill("150");
  await near.getByLabel("Zone 1 release margin").fill("8");
  await near
    .getByRole("button", { name: "Add on exit action", exact: true })
    .click();
  await near.getByLabel("On exit action 1 state").selectOption("idle");
  await page
    .getByRole("button", { name: "Add distance zone", exact: true })
    .click();
  const close = page.getByRole("region", {
    name: "Approach zone 2",
    exact: true,
  });
  await close.getByLabel("Zone 2 name").fill("Close");
  await expect(close.getByLabel("Zone 2 minimum distance")).toHaveValue("2");
  await expect(close.getByLabel("Zone 2 maximum distance")).toHaveValue("39");
  await close
    .getByRole("button", { name: "Add on enter action", exact: true })
    .click();
  await close.getByLabel("On enter action 1 state").selectOption("scare");
  await close
    .getByRole("button", { name: "Add on enter action", exact: true })
    .click();
  await close.getByLabel("On enter action 2 type").selectOption("volume");
  await close
    .getByLabel("On enter action 2 audio target")
    .selectOption("foreground");
  await close.getByLabel("On enter action 2 volume").fill("9");
  await close.getByLabel("On enter action 2 fade").fill("150");
  await close
    .getByRole("button", { name: "Move on enter action 2 up", exact: true })
    .click();
  await expect(close.getByLabel("On enter action 1 type")).toHaveValue(
    "volume",
  );
  await close
    .getByRole("button", { name: "Move on enter action 1 down", exact: true })
    .click();
  await expect(close.getByLabel("On enter action 2 volume")).toHaveValue("9");
  await expect(outputs).toHaveText("14");
  await page
    .getByLabel("Trigger 1 distance behavior")
    .selectOption("threshold");
  await expect(near).toHaveCount(0);
  await page.getByLabel("Trigger 1 distance behavior").selectOption("zones");
  await expect(close.getByLabel("On enter action 2 volume")).toHaveValue("9");
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Idle/ })
    .click();
  await expect(
    page.getByLabel("Transition 2 trigger").locator("option:checked"),
  ).toContainText("inactive: distance zones");
  await expect(
    page.getByText("Inactive while this sensor uses distance zones.", {
      exact: false,
    }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = JSON.parse(
    await readFile((await (await downloadPromise).path())!, "utf8"),
  );
  expect(saved.triggers[0].zones[1].onEnter).toEqual([
    expect.objectContaining({ kind: "state", stateId: "scare" }),
    expect.objectContaining({
      kind: "volume",
      target: "foreground",
      volume: 9,
      fadeMs: 150,
    }),
  ]);
  expect(saved.triggers[0]).toMatchObject({
    pin: expect.any(Number),
    echoPin: expect.any(Number),
    distanceMode: "zones",
  });
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "zones.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await expect(close.getByLabel("On enter action 2 volume")).toHaveValue("9");
  await expect(near.getByLabel("Zone 1 release margin")).toHaveValue("8");
  await close.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/distance-zone-editor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Scare/ })
    .click();
  await page.getByRole("button", { name: "Delete state", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await expect(close.getByLabel("On enter action 1 type")).toHaveValue(
    "volume",
  );
  await expect(close.getByLabel("On enter action 1 volume")).toHaveValue("9");
  await expect(close.getByLabel("On enter action 2 type")).toHaveCount(0);
});

test("distance preview follows zones with dwell and deadband, holds on no echo, and changes volume without restarting", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sample = JSON.parse(
    await readFile("examples/three-state-starter.cpc.json", "utf8"),
  );
  sample.audio.tracks = [
    { number: 1, name: "Ambient" },
    { number: 2, name: "Approach sound" },
  ];
  sample.audio.ambientTrack = 1;
  sample.audio.ambientVolume = 20;
  sample.audio.keepAmbient = true;
  sample.audio.ambientMixVolume = 8;
  sample.audio.transitionMode = "cut";
  sample.states.find(
    (state: { id: string }) => state.id === "approach",
  ).foregroundTrack = 2;
  sample.triggers[0] = {
    ...sample.triggers[0],
    name: "Visitor",
    kind: "ultrasonic",
    activeLow: false,
    pullup: false,
    distanceMode: "zones",
    debounceMs: 150,
    zones: [
      {
        id: "close",
        name: "Close",
        minCm: 2,
        maxCm: 39,
        hysteresisCm: 10,
        onEnter: [
          {
            id: "quiet",
            kind: "volume",
            target: "foreground",
            volume: 9,
            fadeMs: 150,
          },
        ],
        onExit: [],
      },
      {
        id: "near",
        name: "Approaching",
        minCm: 40,
        maxCm: 149,
        hysteresisCm: 10,
        onEnter: [{ id: "approach", kind: "state", stateId: "approach" }],
        onExit: [],
      },
      {
        id: "far",
        name: "Far",
        minCm: 150,
        maxCm: 400,
        hysteresisCm: 10,
        onEnter: [{ id: "idle", kind: "state", stateId: "idle" }],
        onExit: [],
      },
    ],
  };
  await page.goto("/");
  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "distance-preview.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  // Reallocate the imported sample's original one-pin wiring and audio modules.
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await page.getByLabel("Trigger 1 debounce").fill("200");
  await page.getByLabel("Trigger 1 debounce").fill("150");
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  const distance = page.getByLabel("Visitor preview distance", { exact: true });
  const activeZone = page.getByTestId(`distance-zone-${sample.triggers[0].id}`);
  await expect(
    page
      .locator(".preview-buttons")
      .getByRole("button", { name: "Visitor", exact: true }),
  ).toHaveCount(0);
  await distance.fill("300");
  await expect(activeZone).toHaveText("Zone: Far");
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await distance.fill("145");
  // Still in the far zone's 10 cm release margin.
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await distance.fill("");
  await distance.pressSequentially("100");
  await expect(distance).toHaveValue("100");
  await expect(activeZone).toHaveText("Zone: Approaching");
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await expect(page.getByLabel("State name", { exact: true })).toHaveValue(
    "Approach",
  );
  const foreground = page.locator('[data-testid^="preview-audio-foreground-"]');
  await expect
    .poll(async () => Number(await foreground.getAttribute("data-position-ms")))
    .toBeGreaterThan(1000);
  const beforeClose = Number(await foreground.getAttribute("data-position-ms"));
  await distance.fill("20");
  await expect(activeZone).toHaveText("Zone: Close");
  await expect(foreground).toHaveAttribute("data-volume", "9");
  expect(
    Number(await foreground.getAttribute("data-position-ms")),
  ).toBeGreaterThan(beforeClose);
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await page
    .getByRole("button", { name: "Visitor no echo", exact: true })
    .click();
  await expect(distance).toHaveValue("");
  await expect(activeZone).toHaveText("Zone: Close");
  await expect(foreground).toHaveAttribute("data-volume", "9");
  await distance.fill("45");
  await expect(activeZone).toHaveText("Zone: Close");
  // Manually inspecting another timeline must remain possible while preview runs.
  await page
    .locator(".state-list")
    .getByRole("button", { name: /Scare/ })
    .click();
  await expect(page.getByLabel("State name", { exact: true })).toHaveValue(
    "Scare",
  );
  await expect
    .poll(async () => Number(await foreground.getAttribute("data-position-ms")))
    .toBeGreaterThan(beforeClose + 1000);
  await expect(page.getByLabel("State name", { exact: true })).toHaveValue(
    "Scare",
  );
  await distance.fill("300");
  await expect(activeZone).toHaveText("Zone: Far");
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await expect(page.getByLabel("State name", { exact: true })).toHaveValue(
    "Idle",
  );
  await page.screenshot({
    path: "artifacts/distance-zone-preview.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Reset preview", exact: true })
    .click();
  await distance.fill("100");
  await expect(activeZone).toHaveText("Zone: Approaching");
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  expect(errors).toEqual([]);
});

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
  await page.getByLabel("Ambient during foreground").selectOption("silent");
  await expect(playerCount).toHaveText("2");
  await page.getByLabel("Ambient during foreground").selectOption("stop");
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

test("ambient mixing preserves settings, player allocation, and preview state transitions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sample = JSON.parse(
    await readFile("examples/three-state-starter.cpc.json", "utf8"),
  );
  sample.audio.tracks = [1, 2, 3].map((number) => ({
    number,
    name: `Track ${number}`,
  }));
  sample.audio.ambientTrack = 1;
  sample.audio.ambientVolume = 20;
  sample.audio.keepAmbient = true;
  delete sample.audio.ambientMixVolume;
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
    name: "legacy-silent-ambient.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(sample)),
  });
  const mediaTab = page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true });
  await mediaTab.click();
  const behavior = page.getByLabel("Ambient during foreground");
  const mixVolume = page.getByLabel("Ambient mixed volume (1–30)");
  const playerCount = page
    .locator(".resource-stat")
    .filter({ hasText: "Players required by these settings" })
    .locator("strong");
  await expect(behavior).toHaveValue("silent");
  await expect(mixVolume).toHaveCount(0);
  await expect(playerCount).toHaveText("3");
  await behavior.selectOption("mix");
  await expect(mixVolume).toHaveValue("10");
  await mixVolume.fill("0");
  await expect(mixVolume).toHaveValue("1");
  await expect(behavior).toHaveValue("mix");
  await mixVolume.fill("9");
  await expect(
    page.getByLabel("Ambient volume (0–30)", { exact: true }),
  ).toHaveValue("20");
  await expect(playerCount).toHaveText("3");

  await behavior.selectOption("stop");
  await expect(mixVolume).toHaveCount(0);
  await expect(playerCount).toHaveText("2");
  await behavior.selectOption("mix");
  await expect(mixVolume).toHaveValue("9");
  await page.getByLabel("Audio transition").selectOption("cut");
  await expect(playerCount).toHaveText("2");
  await page.getByLabel("Audio transition").selectOption("fade-through");
  await page.getByLabel("Fade-out milliseconds").fill("200");
  await page.getByLabel("Fade-in milliseconds").fill("400");
  await expect(playerCount).toHaveText("2");
  await behavior.selectOption("silent");
  await expect(mixVolume).toHaveCount(0);
  await expect(playerCount).toHaveText("2");
  await behavior.selectOption("mix");
  await expect(mixVolume).toHaveValue("10");
  await mixVolume.fill("9");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(saved.audio).toMatchObject({
    keepAmbient: true,
    ambientMixVolume: 9,
    ambientVolume: 20,
    transitionMode: "fade-through",
    fadeOutMs: 200,
    fadeInMs: 400,
  });
  expect(saved.audio.players).toHaveLength(2);
  await behavior.selectOption("stop");
  await projectInput.setInputFiles({
    name: "saved-ambient-mix.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await mediaTab.click();
  await expect(behavior).toHaveValue("mix");
  await expect(mixVolume).toHaveValue("9");
  await expect(page.getByLabel("Audio transition")).toHaveValue("fade-through");
  await expect(playerCount).toHaveText("2");
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await expect(page.getByLabel("Player 2 type")).toBeVisible();
  await expect(page.getByLabel("Player 3 type")).toHaveCount(0);
  await page.getByRole("button", { name: "Scene", exact: true }).click();
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  const triggers = page.locator(".preview-buttons");
  await triggers.getByRole("button", { name: "Approach", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Approach");
  await triggers.getByRole("button", { name: "Scare", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Scare");
  await triggers.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("preview-state")).toHaveText("Idle");
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  expect(errors).toEqual([]);
});

test("media trim editor previews a selection, validates bounds, and persists it without replacing the source", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A small generated WAV exercises the actual browser decoder without
  // depending on a copyrighted recording or an external conversion tool.
  const sampleRate = 8000;
  const samples = sampleRate * 8;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(Math.sin(i * 0.12) * 1800), 44 + i * 2);
  }
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  await page.getByTestId("audio-file-input").setInputFiles({
    name: "trim-fixture.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await expect(page.getByText("Preview ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Trim audio for track 1" }).click();
  const editor = page.getByRole("region", {
    name: "Audio editor for trim-fixture.wav",
  });
  await expect(editor.getByLabel("Trim end seconds")).toHaveValue("8.000");
  await expect(editor.locator(".trim-waveform svg path")).toBeVisible();
  await expect(editor.getByTestId("trim-duration")).toHaveText("8.000 s");

  await editor.getByTestId("trim-waveform-1").scrollIntoViewIfNeeded();
  const waveform = await editor.getByTestId("trim-waveform-1").boundingBox();
  const handle = await editor
    .getByRole("slider", { name: "Trim start handle" })
    .boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 60);
  await page.mouse.down();
  await page.mouse.move(waveform!.x + waveform!.width / 4, waveform!.y + 60, {
    steps: 6,
  });
  await page.mouse.up();
  expect(
    Number(await editor.getByLabel("Trim start seconds").inputValue()),
  ).toBeCloseTo(2, 1);
  await editor.getByLabel("Trim start seconds").fill("2.125");
  await editor.getByLabel("Trim end seconds").fill("3.250");
  await editor
    .getByRole("slider", { name: "Trim start handle" })
    .press("ArrowLeft");
  await expect(editor.getByLabel("Trim start seconds")).toHaveValue("2.115");
  await expect(editor.getByTestId("trim-duration")).toHaveText("1.135 s");
  await editor
    .getByRole("button", { name: "Preview selection", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Stop selection", exact: true })
    .click();
  await editor.getByRole("button", { name: "Apply trim", exact: true }).click();
  await expect(
    page.getByText("Trim: 2.115 s → 3.250 s", { exact: true }),
  ).toBeVisible();

  await editor.getByLabel("Trim end seconds").fill("8.001");
  await expect(editor.getByRole("alert")).toContainText(
    "no later than 8.000 seconds",
  );
  await expect(
    editor.getByRole("button", { name: "Apply trim", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Preview selection", exact: true }),
  ).toBeDisabled();
  await editor.getByLabel("Trim start seconds").fill("");
  await expect(
    editor.getByRole("button", { name: "Apply trim", exact: true }),
  ).toBeDisabled();
  await editor.getByLabel("Trim start seconds").fill("2.115");
  await editor.getByLabel("Trim end seconds").fill("3.250");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(saved.audio.tracks[0]).toMatchObject({
    number: 1,
    name: "trim-fixture.wav",
    durationMs: 8000,
    trimStartMs: 2115,
    trimEndMs: 3250,
  });
  await page.screenshot({
    path: "artifacts/media-trim-editor.png",
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Full track", exact: true }).click();
  await expect(editor.getByLabel("Trim start seconds")).toHaveValue("0.000");
  await expect(editor.getByLabel("Trim end seconds")).toHaveValue("8.000");
  await expect(page.locator(".track-trim-summary")).toHaveCount(0);

  await page.locator('input[type=file][accept=".json,.cpc"]').setInputFiles({
    name: "saved-trim.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Media", exact: true })
    .click();
  const trimToggle = page.getByRole("button", {
    name: "Trim audio for track 1",
  });
  if ((await trimToggle.getAttribute("aria-expanded")) !== "true") {
    await trimToggle.click();
  }
  await expect(editor.getByLabel("Trim start seconds")).toHaveValue("2.115");
  await expect(editor.getByLabel("Trim end seconds")).toHaveValue("3.250");
  await expect(
    editor.getByRole("button", { name: "Preview selection", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
