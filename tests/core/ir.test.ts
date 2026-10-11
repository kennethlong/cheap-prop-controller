import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  compileProject,
  createDefaultProject,
  encodeIrPulses,
  estimateSceneBytes,
  irPins,
  learnIrSignal,
  parseProject,
  validateIrCommand,
  validateIrSignal,
  validateProject,
  verifySceneChecksum,
  type BoardId,
  type IrCommand,
  type SceneProject,
} from "../../src/shared";

const command = (id = "on"): IrCommand => ({
  id,
  name: "Candles on",
  signal: { kind: "nec", code: 0xef10df20 },
  sendCount: 1,
  gapMs: 100,
});
const raw: IrCommand = {
  id: "raw",
  name: "Raw test",
  signal: { kind: "raw", pulsesUs: [1000, 500, 1000, 500, 550] },
  sendCount: 2,
  gapMs: 150,
};
function project(board: BoardId = "uno"): SceneProject {
  const value = createDefaultProject();
  value.board = board;
  value.ir = {
    enabled: true,
    txPin: null,
    rxPin: null,
    commands: [command(), structuredClone(raw)],
  };
  value.states[1].irEvents = [
    { id: "ir1", atMs: 1000, commandId: "on" },
    { id: "ir2", atMs: 2000, commandId: "raw" },
  ];
  return allocatePins(value).project;
}
const errors = (value: unknown) =>
  validateProject(value).filter((issue) => issue.severity === "error");

describe("learned IR signals", () => {
  it.each([0, 1, 0x80000000, 0xffffffff, 0xef10df20])(
    "round-trips every NEC bit including unsigned high bits: %i",
    (code) => {
      const signal = { kind: "nec" as const, code };
      expect(learnIrSignal(encodeIrPulses(signal))).toEqual(signal);
    },
  );
  it("recognizes measured NEC timing tolerance and keeps unrecognized complete frames raw", () => {
    const pulses = encodeIrPulses(command().signal).map(
      (pulse, index) => pulse + (index % 2 ? 40 : -35),
    );
    expect(learnIrSignal(pulses)).toEqual(command().signal);
    expect(learnIrSignal([997, 512, 1001, 496, 558])).toEqual(raw.signal);
  });
  it("rejects held-button repeat frames, overflow, fractional codes and oversized raw frames", () => {
    expect(() => learnIrSignal([9000, 2250, 550])).toThrow();
    for (const signal of [
      null,
      { kind: "nec", code: -1 },
      { kind: "nec", code: 0x100000000 },
      { kind: "nec", code: 1.5 },
      { kind: "raw", pulsesUs: [100, 100, 100, 100] },
      { kind: "raw", pulsesUs: [100, 100, 100, 100, 125] },
      { kind: "raw", pulsesUs: Array(129).fill(550) },
      { kind: "raw", pulsesUs: Array(127).fill(12750) },
    ])
      expect(validateIrSignal(signal)).toBe(false);
    expect(() => learnIrSignal([1000, NaN, 1000, 500, 550])).toThrow();
    expect(validateIrCommand(command())).toBe(true);
    expect(validateIrCommand({ ...command(), sendCount: 11 })).toBe(false);
    expect(validateIrCommand({ ...command(), gapMs: 75 })).toBe(false);
  });
});

describe("IR project and compiled extension", () => {
  it.each(["uno", "nano", "pro-mini", "mega"] as const)(
    "reserves receiver and timer output before all other roles on %s",
    (board) => {
      const value = project(board);
      expect(errors(value)).toEqual([]);
      expect(value.ir).toMatchObject(irPins(board));
      const assigned = [
        ...value.outputs.map((item) => item.pin),
        ...value.triggers.flatMap((item) => [item.pin, item.echoPin]),
        ...value.audio.players.flatMap((item) => [item.txPin, item.rxPin]),
      ];
      expect(assigned).not.toContain(value.ir!.txPin);
      expect(assigned).not.toContain(value.ir!.rxPin);
      const without = structuredClone(value);
      without.ir!.enabled = false;
      expect(allocatePins(value).availableOutputPins.length).toBe(
        allocatePins(without).availableOutputPins.length - 2,
      );
      expect(allocatePins(value).maxOutputs).toBe(
        board === "mega" ? 32 : allocatePins(without).maxOutputs - 2,
      );
    },
  );
  it("preserves old bytes with no IR or an inactive unused library", () => {
    const legacy = createDefaultProject();
    const original = compileProject(legacy).bytes;
    expect(Buffer.from(original)).toEqual(
      readFileSync("tests/core/default-scene.bin"),
    );
    legacy.ir = {
      enabled: false,
      txPin: null,
      rxPin: null,
      commands: [command()],
    };
    expect(compileProject(legacy).bytes).toEqual(original);
    const zones = parseProject(
      readFileSync("examples/ultrasonic-zones-uno.cpc.json", "utf8"),
    );
    expect(Buffer.from(compileProject(zones).bytes)).toEqual(
      readFileSync("tests/core/zones-scene.bin"),
    );
  });
  it("packs exact v2 offsets, complete NEC32 data, raw pulse ticks, timed cues and capacity", () => {
    const value = project();
    expect(parseProject(JSON.stringify(value))).toEqual(value);
    const compiled = compileProject(value);
    expect(compiled.bytes.length).toBe(estimateSceneBytes(value));
    expect(verifySceneChecksum(compiled.bytes)).toBe(true);
    const bytes = compiled.bytes;
    const view = new DataView(bytes.buffer);
    const tail = bytes.length - 8,
      descriptor = tail - 8;
    expect([...bytes.subarray(tail, tail + 4)]).toEqual([90, 78, 2, 0]);
    expect([...bytes.subarray(descriptor, descriptor + 4)]).toEqual([
      9, 2, 2, 0,
    ]);
    expect(view.getUint16(descriptor + 4, true)).toBe(2);
    expect(view.getUint16(descriptor + 6, true)).toBe(5);
    const table = view.getUint16(tail + 6, true);
    expect([...bytes.subarray(table, table + 8)]).toEqual([
      1, 0, 20, 0, 1, 1, 40, 0,
    ]);
    expect([...bytes.subarray(table + 8, table + 20)]).toEqual([
      0, 38, 1, 0, 32, 223, 16, 239, 100, 0, 0, 0,
    ]);
    expect([...bytes.subarray(descriptor - 5, descriptor)]).toEqual([
      20, 10, 20, 10, 11,
    ]);
    expect(
      estimateSceneBytes(value) - estimateSceneBytes(createDefaultProject()),
    ).toBe(16 + 24 + 8 + 5);
  });
  it("allows enabling and uploading IR before any button is trained", () => {
    const value = project();
    value.ir!.commands = [];
    value.states.forEach((state) => {
      state.irEvents = [];
    });
    expect(errors(value)).toEqual([]);
    const bytes = compileProject(value).bytes;
    expect(bytes[bytes.length - 6]).toBe(2);
    expect(bytes[bytes.length - 14]).toBe(0);
  });
  it("validates pins, references, clock alignment, library limits and repairable imports", () => {
    const value = project();
    value.ir!.txPin = 8;
    expect(errors(value).some((issue) => issue.path === "ir")).toBe(true);
    value.ir!.txPin = 9;
    value.states[1].irEvents![0].commandId = "missing";
    value.states[1].irEvents![1].atMs = value.states[1].durationMs;
    expect(errors(value)).toHaveLength(2);
    value.ir!.enabled = false;
    expect(
      errors(value).some((issue) => issue.message.includes("Enable IR")),
    ).toBe(true);
    const malformed = JSON.parse(JSON.stringify(project()));
    malformed.ir.commands[0].signal = { kind: "raw", pulsesUs: "invalid" };
    expect(() => parseProject(malformed)).toThrow("Expected an array");
    const many = project();
    many.ir!.commands = Array.from({ length: 33 }, (_, index) =>
      command(`c${index}`),
    );
    expect(errors(many).some((issue) => issue.path === "ir.commands")).toBe(
      true,
    );
  });
  it("uses named commands in zones without consuming another pin and accounts for raw EEPROM limits", () => {
    let value = project();
    Object.assign(value.triggers[0], {
      kind: "ultrasonic",
      activeLow: false,
      pullup: false,
      distanceMode: "zones",
      zones: [
        {
          id: "near",
          name: "Near",
          minCm: 2,
          maxCm: 100,
          hysteresisCm: 5,
          onEnter: [{ id: "ir", kind: "ir", commandId: "on" }],
          onExit: [],
        },
      ],
    });
    value = allocatePins(value).project;
    expect(errors(value)).toEqual([]);
    const bytes = compileProject(value).bytes,
      view = new DataView(bytes.buffer);
    const start = view.getUint16(bytes.length - 2, true);
    expect([...bytes.subarray(start + 10, start + 16)]).toEqual([
      2, 0, 0, 0, 0, 0,
    ]);
    value.ir!.commands = Array.from({ length: 10 }, (_, index) => ({
      ...raw,
      id: index ? `r${index}` : "on",
      signal: { kind: "raw", pulsesUs: Array(127).fill(550) },
    }));
    expect(compileProject(value).usedBytes).toBeGreaterThan(1024);
    expect(errors(value).some((issue) => issue.path === "capacity")).toBe(true);
  });
  it("rejects guaranteed queue overflow and warns when scheduled presses overlap", () => {
    const value = project();
    value.states[1].irEvents = Array.from({ length: 9 }, (_, i) => ({
      id: `i${i}`,
      atMs: 0,
      commandId: "on",
    }));
    expect(
      errors(value).some((issue) => issue.message.includes("eight IR")),
    ).toBe(true);
    value.states[1].irEvents.pop();
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" && issue.message.includes("send queue"),
      ),
    ).toBe(true);
  });
  it("includes the final quiet gap when warning about delayed commands", () => {
    const value = project();
    value.ir!.commands[0].gapMs = 2000;
    value.states[1].irEvents = [
      { id: "first", atMs: 0, commandId: "on" },
      { id: "second", atMs: 100, commandId: "on" },
    ];
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" && issue.message.includes("send queue"),
      ),
    ).toBe(true);
  });
});
