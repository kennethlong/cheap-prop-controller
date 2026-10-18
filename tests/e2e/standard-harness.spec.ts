import { expect, test, type Page } from "@playwright/test";
import {
  createDefaultProject,
  createTrigger,
  synchronizeAudioPlayers,
  type SceneProject,
} from "../../src/shared";
import {
  applyStandardHarness,
  toRuntimeProject,
} from "../../src/shared/standard-harness";

function legacyFixture(): SceneProject {
  const project = createDefaultProject();
  project.name = "Standard harness bench";
  project.outputs = project.outputs.slice(0, 6);
  project.outputs[4].name = "Solenoid";
  project.outputs[5].name = "Strobe";
  project.triggers = [
    { ...createTrigger("beam", "Beam"), debounceMs: 0 },
    {
      ...createTrigger("pir", "Motion"),
      kind: "pir",
      pullup: false,
      activeLow: false,
    },
    {
      ...createTrigger("sonar", "Near"),
      kind: "ultrasonic",
      pullup: false,
      activeLow: false,
    },
    {
      ...createTrigger("next", "Next state"),
      kind: "manual",
      debounceMs: 0,
      pin: null,
      echoPin: null,
    },
  ];
  project.audio.transitionMode = "fade-through";
  project.audio.fadeOutMs = 250;
  project.audio.fadeInMs = 250;
  project.audio.ambientTrack = 1;
  project.audio.tracks = [{ number: 1, name: "Ambient" }];
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
  return synchronizeAudioPlayers(project);
}

// Every operation stays in the browser's explicit mock transport.
async function installTransport(page: Page, initial: SceneProject) {
  await page.addInitScript((project) => {
    let saved = project;
    const calls: Array<{ method: string; value?: unknown }> = [];
    const statusListeners = new Set<(value: unknown) => void>();
    Object.assign(window, {
      cpc: {
        getDeviceStatus: async () => ({
          connected: true,
          port: "MOCK-STANDARD",
          hello: {
            board: "uno",
            outputTest: true,
            irLearning: true,
            irReplay: true,
          },
        }),
        listPorts: async () => [{ path: "MOCK-STANDARD" }],
        onDeviceStatus: (listener: (value: unknown) => void) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        onDeviceLog: () => () => {},
        openProject: async () => ({
          project: structuredClone(saved),
          path: "test/standard.cpc.json",
        }),
        saveProject: async (value: SceneProject) => {
          saved = structuredClone(value);
          return {
            project: structuredClone(saved),
            path: "test/standard.cpc.json",
          };
        },
        deviceCommand: async (value: string) => {
          calls.push({ method: "command", value });
          return { type: "ack" };
        },
        cancelIr: async () => ({ type: "ack" }),
        beginOutputTest: async (value: number[]) => {
          calls.push({ method: "beginOutputs", value });
          return { type: "ack" };
        },
        setTestOutputs: async (value: number) => {
          calls.push({ method: "outputs", value });
          return { type: "ack" };
        },
        endOutputTest: async () => ({ type: "ack" }),
        uploadScene: async () => ({ type: "ack" }),
      },
      __standardHarness: {
        emitStatus(value: unknown) {
          for (const listener of statusListeners) listener(value);
        },
        get saved() {
          return saved;
        },
        get calls() {
          return calls;
        },
      },
    });
  }, initial);
}

async function open(page: Page) {
  await page.getByRole("button", { name: "Open", exact: true }).click();
}
async function hardware(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Hardware", exact: true })
    .click();
}
async function save(page: Page): Promise<SceneProject> {
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  return page.evaluate("window.__standardHarness.saved");
}
function connectionMap(project: SceneProject) {
  return {
    outputs: project.outputs.map(({ id, pin, standardSlot }) => ({
      id,
      pin,
      standardSlot,
    })),
    triggers: project.triggers.map(({ id, pin, echoPin, standardSlot }) => ({
      id,
      pin,
      echoPin,
      standardSlot,
    })),
    audio: project.audio.players,
  };
}

test("standard slots survive backup installation, IR toggles, save and reload", async ({
  page,
}) => {
  const original = legacyFixture();
  await installTransport(page, original);
  await page.goto("/");
  await open(page);
  await hardware(page);
  await page.getByLabel("Wiring preset").selectOption("standard-uno");
  const map = page.getByRole("region", { name: "Standard harness wiring map" });
  await expect(map).toBeVisible();
  await expect(map.locator('[data-slot="primary-ultrasonic"]')).toContainText(
    "TRIG D12 · ECHO D13",
  );
  await expect(map.locator('[data-slot="backup-ultrasonic"]')).toContainText(
    "TRIG A1 / D15 · ECHO A2 / D16",
  );
  await expect(map.locator('[data-slot="dc-ssr"]')).toContainText("A3 / D17");
  await expect(map.locator('[data-slot="ac-ssr"]')).toContainText("A4 / D18");
  await expect(map).toContainText("GX12");
  const converted = await save(page);
  expect(converted.states).toEqual(original.states);
  expect(converted.audio).toEqual({
    ...original.audio,
    players: [{ ...original.audio.players[0], txPin: 3, rxPin: 8 }],
  });
  const backupPir = page.getByRole("checkbox", { name: /Enable Backup PIR/i });
  const backupSonar = page.getByRole("checkbox", {
    name: /Enable Backup ultrasonic/i,
  });
  await expect(backupPir).not.toBeChecked();
  await expect(backupSonar).not.toBeChecked();
  await backupPir.check();
  await backupSonar.check();
  await page
    .getByRole("checkbox", { name: "Enable IR remote control", exact: true })
    .check();
  const installed = await save(page);
  expect(connectionMap(installed)).toEqual(connectionMap(converted));
  await backupPir.uncheck();
  await backupSonar.uncheck();
  await page
    .getByRole("checkbox", { name: "Enable IR remote control", exact: true })
    .uncheck();
  const disabled = await save(page);
  expect(connectionMap(disabled)).toEqual(connectionMap(converted));
  await open(page);
  await hardware(page);
  await expect(page.getByLabel("Wiring preset")).toHaveValue("standard-uno");
  await expect(backupPir).not.toBeChecked();
  await expect(backupSonar).not.toBeChecked();
  await expect(map.locator('[data-slot="backup-pir"]')).toContainText(
    "Disabled · reserved",
  );
  await expect(
    page.getByRole("button", { name: "Delete trigger Motion", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete output Solenoid", exact: true }),
  ).toHaveCount(0);
});

test("disabled slots cannot be injected or tested and physical indices match compiled order", async ({
  page,
}) => {
  const project = applyStandardHarness(legacyFixture());
  project.triggers.find((trigger) => trigger.id === "beam")!.enabled = false;
  project.triggers.find((trigger) => trigger.id === "pir")!.enabled = false;
  project.outputs[0].enabled = false;
  project.outputs[4].enabled = false;
  const runtime = toRuntimeProject(project);
  await installTransport(page, project);
  await page.goto("/");
  await open(page);
  await page.getByRole("button", { name: "Show device console" }).click();
  const selector = page.getByLabel("Controller trigger");
  await expect(selector.locator('option[value="beam"]')).toHaveCount(0);
  await expect(selector.locator('option[value="pir"]')).toHaveCount(0);
  await selector.selectOption("next");
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Upload this scene on this connection before sending triggers.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await hardware(page);
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Scene", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send trigger", exact: true }).click();
  const triggerCalls = await page.evaluate("window.__standardHarness.calls");
  expect(triggerCalls).toContainEqual({
    method: "command",
    value: `TRIGGER ${runtime.triggers.findIndex((trigger) => trigger.id === "next")}`,
  });
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(
    page
      .locator(".preview-buttons")
      .getByRole("button", { name: "Beam", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".preview-buttons")
      .getByRole("button", { name: "Motion", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await page.getByRole("button", { name: "Test outputs", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Latch physical Entrance light",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Latch physical Solenoid", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enter output test", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Latch physical Strobe", exact: true })
    .click();
  const outputCalls = await page.evaluate("window.__standardHarness.calls");
  expect(outputCalls).toContainEqual({
    method: "outputs",
    value: 1 << runtime.outputs.findIndex((output) => output.name === "Strobe"),
  });
  await page
    .getByRole("button", { name: "Exit output test", exact: true })
    .click();
  await hardware(page);
  await page
    .getByRole("checkbox", { name: "Enable Backup PIR", exact: true })
    .check();
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Wiring preset").selectOption("custom");
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Upload scene", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeEnabled();
  await page.evaluate(
    "window.__standardHarness.emitStatus({ connected: false })",
  );
  await page.evaluate(
    "window.__standardHarness.emitStatus({ connected: true, port: 'MOCK-STANDARD', hello: { board: 'uno', outputTest: true } })",
  );
  await expect(
    page.getByRole("button", { name: "Send trigger", exact: true }),
  ).toBeDisabled();
});

test("incompatible migration keeps the existing project and explains the restriction", async ({
  page,
}) => {
  const project = legacyFixture();
  project.board = "mega";
  await installTransport(page, synchronizeAudioPlayers(project));
  await page.goto("/");
  await open(page);
  await hardware(page);
  await page.getByLabel("Wiring preset").selectOption("standard-uno");
  await expect(page.getByLabel("Wiring preset")).toHaveValue("relay-shield");
  await expect(page.locator(".toast")).toContainText(
    /Uno|Nano|Pro Mini|ATmega328P/i,
  );
  const saved = await save(page);
  expect(saved.board).toBe("mega");
  expect(saved.wiring).toBe("relay-shield");
  expect(saved.outputs).toHaveLength(6);
});

test("missing slot restoration preserves every existing connection and disabled settings remain editable", async ({
  page,
}) => {
  const project = applyStandardHarness(legacyFixture());
  project.triggers = project.triggers.filter(
    (trigger) => trigger.standardSlot !== "backup-ultrasonic",
  );
  await installTransport(page, project);
  await page.goto("/");
  await open(page);
  await hardware(page);
  await page
    .getByRole("button", {
      name: "Restore missing hardware slots",
      exact: true,
    })
    .click();
  const restored = await save(page);
  expect(restored.outputs).toEqual(project.outputs);
  for (const trigger of project.triggers)
    expect(
      restored.triggers.find((candidate) => candidate.id === trigger.id),
    ).toEqual(trigger);
  const backupIndex = restored.triggers.findIndex(
    (trigger) => trigger.standardSlot === "backup-ultrasonic",
  );
  await page
    .getByLabel(`Trigger ${backupIndex + 1} name`, { exact: true })
    .fill("Backup at exit");
  await page
    .getByLabel(`Trigger ${backupIndex + 1} debounce`, { exact: true })
    .fill("250");
  await page
    .getByRole("checkbox", { name: "Enable Backup ultrasonic", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Enable Backup ultrasonic", exact: true })
    .uncheck();
  const configured = await save(page);
  expect(configured.triggers[backupIndex]).toMatchObject({
    name: "Backup at exit",
    debounceMs: 250,
    enabled: false,
    pin: 15,
    echoPin: 16,
  });
  await page.getByLabel("Wiring preset").selectOption("custom");
  await page
    .getByRole("checkbox", { name: "Enable Backup at exit", exact: true })
    .check();
  expect((await save(page)).triggers[backupIndex]).toMatchObject({
    name: "Backup at exit",
    debounceMs: 250,
    enabled: true,
  });
});
