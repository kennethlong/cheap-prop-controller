import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createDefaultProject,
  createTrigger,
  synchronizeAudioPlayers,
  type SceneProject,
} from "../../src/shared";

function fixture(): SceneProject {
  const project = createDefaultProject();
  project.name = "Reusable wiring bench";
  project.outputs = project.outputs.slice(0, 6);
  project.triggers = [
    { ...createTrigger("beam", "IR beam"), debounceMs: 0 },
    {
      ...createTrigger("pir", "Entry motion"),
      kind: "pir",
      activeLow: false,
      pullup: false,
    },
    {
      ...createTrigger("sonar", "Near sensor"),
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
    },
    {
      ...createTrigger("next", "Next audio state"),
      kind: "manual",
      pin: null,
      echoPin: null,
      debounceMs: 0,
    },
  ];
  project.states.forEach((state, index) => {
    state.transitions = [
      {
        triggerId: "next",
        targetStateId: project.states[(index + 1) % project.states.length].id,
      },
    ];
  });
  project.states[0].transitions.push({
    triggerId: "pir",
    targetStateId: "approach",
  });
  project.audio.ambientTrack = 1;
  project.audio.tracks = [{ number: 1, name: "Ambient" }];
  project.audio.transitionMode = "fade-through";
  return synchronizeAudioPlayers(project);
}
async function open(page: Page, project: SceneProject) {
  await page.locator('input[type="file"][accept=".json,.cpc"]').setInputFiles({
    name: "wiring.cpc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
}
async function hardware(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Hardware", exact: true })
    .click();
}
async function save(page: Page): Promise<SceneProject> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  return JSON.parse(await readFile((await (await download).path())!, "utf8"));
}
async function select(page: Page, id: string) {
  await page
    .getByLabel("Wiring configuration", { exact: true })
    .selectOption(id);
}

test("built-in selection previews changes, cancellation is inert, and applying dual beam preserves scene identities", async ({
  page,
}) => {
  const original = fixture();
  await page.goto("/");
  await open(page, original);
  await hardware(page);
  const before = await save(page);
  await select(page, "builtin:uno-dual-beam");
  const preview = page.getByRole("region", {
    name: "Wiring configuration preview",
    exact: true,
  });
  await expect(preview).toContainText("Second beam contact");
  await expect(preview).toContainText("A5 / D19");
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "relay-shield",
  );
  expect(await save(page)).toEqual(before);
  await page
    .getByRole("button", { name: "Cancel configuration preview", exact: true })
    .click();
  await expect(preview).toHaveCount(0);
  expect(await save(page)).toEqual(before);
  await select(page, "builtin:uno-dual-beam");
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await expect(page.getByLabel("Wiring preset", { exact: true })).toHaveValue(
    "fixed",
  );
  const applied = await save(page);
  expect(applied.wiringConfiguration?.id).toBe("uno-dual-beam");
  expect(applied.states).toEqual(before.states);
  expect(applied.outputs.slice(0, 6).map((output) => output.id)).toEqual(
    before.outputs.map((output) => output.id),
  );
  expect(applied.outputs.slice(0, 6).map((output) => output.pin)).toEqual([
    7, 6, 5, 4, 17, 18,
  ]);
  expect(
    applied.triggers.find(
      (trigger) => trigger.configurationSlot === "second-beam",
    ),
  ).toMatchObject({ pin: 19, kind: "button", activeLow: true, pullup: true });
  expect(applied.audio.players[0]).toMatchObject({ txPin: 3, rxPin: 8 });
  await expect(
    page.getByLabel("Microcontroller", { exact: true }),
  ).toBeDisabled();
});

for (const kind of ["manual", "timer"] as const)
  test(`a physical trigger converted to ${kind} releases its slot when reapplying a configuration`, async ({
    page,
  }) => {
    await page.goto("/");
    await open(page, fixture());
    await hardware(page);
    await select(page, "builtin:uno-dual-beam");
    await page
      .getByRole("button", { name: "Apply configuration", exact: true })
      .click();
    await page.getByLabel("Trigger 1 type", { exact: true }).selectOption(kind);
    const converted = await save(page);
    expect(converted.triggers[0]).toMatchObject({
      id: "beam",
      kind,
      pin: null,
      echoPin: null,
    });
    expect(converted.triggers[0].configurationSlot).toBeUndefined();
    expect(converted.triggers[0].standardSlot).toBeUndefined();
    await select(page, "builtin:uno-dual-beam");
    const apply = page.getByRole("button", {
      name: "Apply configuration",
      exact: true,
    });
    await expect(apply).toBeEnabled();
    await apply.click();
    const reapplied = await save(page);
    expect(
      reapplied.triggers.find((trigger) => trigger.id === "beam")?.kind,
    ).toBe(kind);
    expect(
      reapplied.triggers.find(
        (trigger) => trigger.configurationSlot === "beam",
      ),
    ).toMatchObject({ kind: "button", pin: 10 });
    expect(reapplied.states).toEqual(converted.states);
  });

test("saved configurations persist across reload, import and export without changing project wiring", async ({
  page,
}) => {
  await page.goto("/");
  await open(page, fixture());
  await hardware(page);
  await page.getByLabel("Wiring preset", { exact: true }).selectOption("fixed");
  await page
    .getByLabel("New wiring configuration name", { exact: true })
    .fill("Workshop box");
  await page
    .getByRole("button", { name: "Save as configuration", exact: true })
    .click();
  const savedId = await page
    .getByLabel("Wiring configuration", { exact: true })
    .inputValue();
  expect(savedId).toMatch(/^saved:/);
  await page
    .getByRole("button", { name: "Cancel configuration preview", exact: true })
    .click();
  await page.getByLabel("Output 1 pin", { exact: true }).selectOption("19");
  const editedProject = await save(page);
  await page.reload();
  await open(page, editedProject);
  await hardware(page);
  await select(page, savedId);
  await expect(
    page.getByRole("region", { name: "Wiring configuration preview" }),
  ).toContainText("D7");
  expect((await save(page)).outputs[0].pin).toBe(19);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export configuration", exact: true })
    .click();
  const exported = JSON.parse(
    await readFile((await (await download).path())!, "utf8"),
  );
  expect(exported.name).toBe("Workshop box");
  expect(exported.outputs[0].pin).toBe(7);
  expect(exported).not.toHaveProperty("states");
  expect(exported).not.toHaveProperty("audio");
  await page
    .getByLabel("Import wiring configuration file", { exact: true })
    .setInputFiles({
      name: "import.wiring.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
  await expect(
    page.getByLabel("Wiring configuration", { exact: true }),
  ).not.toHaveValue(savedId);
  await expect(
    page
      .getByLabel("Wiring configuration", { exact: true })
      .locator('optgroup[label="Saved"] option'),
  ).toHaveCount(2);
  expect((await save(page)).outputs[0].pin).toBe(19);
  await page
    .getByRole("button", { name: "Delete saved configuration", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Wiring configuration", { exact: true })
      .locator('optgroup[label="Saved"] option'),
  ).toHaveCount(1);
  expect((await save(page)).outputs[0].pin).toBe(19);
});

test("fixed pin editing and disabled devices retain assignments, while conflicts and missing pins are visible", async ({
  page,
}) => {
  await page.goto("/");
  await open(page, fixture());
  await hardware(page);
  await page.getByLabel("Wiring preset", { exact: true }).selectOption("fixed");
  await page.getByLabel("Output 1 pin", { exact: true }).selectOption("19");
  await page.getByLabel("Output 1 name", { exact: true }).fill("Main prop");
  await page
    .getByRole("checkbox", { name: "Enable Main prop", exact: true })
    .uncheck();
  await expect(page.getByLabel("Output 1 pin", { exact: true })).toHaveValue(
    "19",
  );
  await page.getByLabel("Output 2 pin", { exact: true }).selectOption("19");
  await expect(
    page.getByText("Resolve before deploying", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".validation-box")).toContainText(
    /already|reserved|claimed|assigned/i,
  );
  await page.getByLabel("Output 2 pin", { exact: true }).selectOption("6");
  await page.getByRole("button", { name: "Add trigger", exact: true }).click();
  await expect(page.getByLabel("Trigger 5 pin", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Output 1 pin", { exact: true })).toHaveValue(
    "19",
  );
  await page.getByLabel("Trigger 5 pin", { exact: true }).selectOption("18");
  await page
    .getByLabel("Trigger 5 type", { exact: true })
    .selectOption("ultrasonic");
  await expect(
    page.getByLabel("Trigger 5 echo pin", { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel("Trigger 5 echo pin", { exact: true })
    .selectOption("17");
  const after = await save(page);
  expect(after.outputs[0]).toMatchObject({
    name: "Main prop",
    pin: 19,
    enabled: false,
  });
  expect(after.triggers[4]).toMatchObject({ pin: 18, echoPin: 17 });
  expect(after.audio.players[0]).toEqual(fixture().audio.players[0]);
  await page
    .getByLabel("Trigger 5 type", { exact: true })
    .selectOption("timer");
  const timer = (await save(page)).triggers[4];
  expect(timer).toMatchObject({ kind: "timer", pin: null, echoPin: null });
});

test("a malformed browser library stays intact and disables library mutations", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("cpc.wiring-configurations.v1", "not JSON"),
  );
  await page.goto("/");
  await hardware(page);
  await expect(page.getByRole("alert")).toContainText(
    "Could not load saved configurations",
  );
  await expect(
    page.getByRole("button", { name: "Save as configuration", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Import configuration", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Delete saved configuration",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("cpc.wiring-configurations.v1"),
    ),
  ).toBe("not JSON");
});

test("no-IR and Mega configurations preview their board and IR changes, and malformed imports do not alter the project", async ({
  page,
}) => {
  await page.goto("/");
  await open(page, fixture());
  await hardware(page);
  await select(page, "builtin:uno-motion");
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  const motion = await save(page);
  expect(motion.ir?.enabled).toBe(false);
  expect(
    motion.triggers.find(
      (trigger) => trigger.configurationSlot === "extra-pir-1",
    )?.pin,
  ).toBe(2);
  expect(
    motion.triggers.find(
      (trigger) => trigger.configurationSlot === "extra-pir-2",
    )?.pin,
  ).toBe(9);
  await page
    .getByRole("checkbox", { name: "Enable IR remote control", exact: true })
    .check();
  await expect(
    page.getByText("Resolve before deploying", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Enable IR remote control", exact: true })
    .uncheck();
  const stable = await save(page);
  await page
    .getByLabel("Import wiring configuration file", { exact: true })
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"version":99}'),
    });
  await expect(page.locator(".toast")).toContainText(
    /invalid|unsupported|version|expected/i,
  );
  expect(await save(page)).toEqual(stable);
  await open(page, fixture());
  await hardware(page);
  await select(page, "builtin:mega-standard");
  await expect(
    page.getByRole("region", { name: "Wiring configuration preview" }),
  ).toContainText("Board change:");
  await expect(page.getByLabel("Microcontroller", { exact: true })).toHaveValue(
    "uno",
  );
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  const mega = await save(page);
  expect(mega.board).toBe("mega");
  expect(mega.ir).toMatchObject({ enabled: true, rxPin: 2, txPin: 11 });
  expect(
    mega.audio.players.map((player) => [player.txPin, player.rxPin]),
  ).toEqual([
    [18, 19],
    [16, 17],
    [14, 15],
  ]);
});
