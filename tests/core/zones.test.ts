import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocatePins,
  compileProject,
  estimateSceneBytes,
  parseProject,
  validateProject,
  verifySceneChecksum,
  type DistanceZone,
} from "../../src/shared/index";

function project() {
  return parseProject(
    readFileSync("examples/ultrasonic-zones-uno.cpc.json", "utf8"),
  );
}
function zone(id: string, minCm: number, maxCm = minCm): DistanceZone {
  return {
    id,
    name: id,
    minCm,
    maxCm,
    hysteresisCm: 1,
    onEnter: [],
    onExit: [],
  };
}
function errors(value: unknown) {
  return validateProject(value).filter((issue) => issue.severity === "error");
}

describe("distance zone project and image contract", () => {
  it("round-trips editable zones and matches the image consumed by native firmware tests", () => {
    const value = project();
    expect(errors(value)).toEqual([]);
    expect(parseProject(JSON.stringify(value))).toEqual(value);
    const compiled = compileProject(value);
    expect(Buffer.from(compiled.bytes)).toEqual(
      readFileSync("tests/core/zones-scene.bin"),
    );
    expect(verifySceneChecksum(compiled.bytes)).toBe(true);
    expect(compiled.usedBytes).toBe(estimateSceneBytes(value));
    expect(compiled.bytes[16] & 0x80).toBe(0x80);
    const footer = compiled.bytes.length - 8;
    const view = new DataView(compiled.bytes.buffer);
    expect([...compiled.bytes.subarray(footer, footer + 4)]).toEqual([
      0x5a, 0x4e, 1, 4,
    ]);
    expect(view.getUint16(footer + 4, true)).toBe(7);
    const zoneStart = view.getUint16(footer + 6, true);
    expect(zoneStart + 4 * 10 + 7 * 6 + 8).toBe(compiled.bytes.length);
    const firstAction = zoneStart + 4 * 10;
    expect([...compiled.bytes.subarray(firstAction, firstAction + 6)]).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    const approachVolume = firstAction + 2 * 6;
    expect([
      ...compiled.bytes.subarray(approachVolume, approachVolume + 6),
    ]).toEqual([1, 1, 12, 0, 6, 0]);
  });

  it("keeps legacy images byte-identical when zone presets are inactive", () => {
    const preset = project();
    preset.triggers[0].distanceMode = "threshold";
    const legacy = structuredClone(preset);
    delete legacy.triggers[0].zones;
    delete legacy.triggers[0].distanceMode;
    expect(compileProject(preset).bytes).toEqual(compileProject(legacy).bytes);
    expect(compileProject(preset).bytes[16] & 0x80).toBe(0);
    expect(estimateSceneBytes(project()) - estimateSceneBytes(legacy)).toBe(90);
  });

  it("uses one sensor pin pair regardless of zone/action count", () => {
    const one = project();
    one.triggers[0].zones = [zone("one", 2, 400)];
    const many = project();
    const first = allocatePins(one);
    const second = allocatePins(many);
    expect(second.maxOutputs).toBe(first.maxOutputs);
    expect(second.availableOutputPins).toEqual(first.availableOutputPins);
    expect(second.project.outputs).toEqual(first.project.outputs);
    expect(second.project.audio.players).toEqual(first.project.audio.players);
    expect(
      second.project.triggers.map(({ pin, echoPin }) => [pin, echoPin]),
    ).toEqual(first.project.triggers.map(({ pin, echoPin }) => [pin, echoPin]));
  });

  it("allows gaps and adjacent inclusive ranges but rejects shared endpoints", () => {
    const value = project();
    value.triggers[0].zones = [
      zone("a", 2, 40),
      zone("b", 41, 100),
      zone("c", 200, 400),
    ];
    expect(errors(value)).toEqual([]);
    value.triggers[0].zones[1].minCm = 40;
    expect(
      errors(value).some((issue) => issue.message.includes("cannot overlap")),
    ).toBe(true);
    expect(compileProject(value).bytes).toHaveLength(0);
  });

  it.each([
    { minCm: 0 },
    { minCm: 2.5 },
    { maxCm: 401 },
    { minCm: 80, maxCm: 20 },
    { hysteresisCm: 0 },
    { hysteresisCm: 256 },
    { name: " " },
  ])("rejects invalid active zone settings %j", (settings) => {
    const value = project();
    value.triggers[0].zones = [{ ...zone("a", 2, 400), ...settings }];
    expect(errors(value).length).toBeGreaterThan(0);
    expect(compileProject(value).bytes).toHaveLength(0);
  });

  it("requires zones in zone mode and unique zone/action IDs", () => {
    const value = project();
    value.triggers[0].zones = [];
    expect(errors(value).length).toBeGreaterThan(0);
    value.triggers[0].zones = [zone("a", 2, 40), zone("a", 41, 400)];
    expect(
      errors(value).some((issue) => issue.message.includes("Duplicate ID")),
    ).toBe(true);
    value.triggers[0].zones = [zone("a", 2, 400)];
    value.triggers[0].zones[0].onEnter = [
      { id: "same", kind: "state", stateId: "idle" },
      { id: "same", kind: "state", stateId: "approach" },
    ];
    expect(
      errors(value).some((issue) => issue.message.includes("Duplicate ID")),
    ).toBe(true);
  });

  it("validates action state references, volumes, fades and malformed imports", () => {
    const value = project();
    const target = value.triggers[0].zones![0];
    target.onEnter = [{ id: "a", kind: "state", stateId: "missing" }];
    expect(
      errors(value).some((issue) => issue.message.includes("Target state")),
    ).toBe(true);
    for (const volume of [-1, 31, 0.5]) {
      target.onEnter = [
        { id: "a", kind: "volume", target: "ambient", volume, fadeMs: 0 },
      ];
      expect(errors(value).length).toBeGreaterThan(0);
    }
    for (const fadeMs of [-50, 25, 12800]) {
      target.onEnter = [
        { id: "a", kind: "volume", target: "ambient", volume: 0, fadeMs },
      ];
      expect(errors(value).length).toBeGreaterThan(0);
    }
    target.onEnter = [
      { id: "a", kind: "volume", target: "ambient", volume: 0, fadeMs: 12750 },
    ];
    expect(errors(value)).toEqual([]);
    const malformed = JSON.parse(JSON.stringify(value));
    malformed.triggers[0].zones[0].onEnter[0].target = "output-1";
    expect(() => parseProject(malformed)).toThrow("Expected one of");
    malformed.triggers[0].zones[0].onEnter[0] = { id: "a", kind: "ir" };
    expect(() => parseProject(malformed)).toThrow("Expected one of");
  });

  it("enforces total zone/action limits across sensors and includes them in EEPROM capacity", () => {
    const value = project();
    value.triggers[0].zones = Array.from({ length: 33 }, (_, index) =>
      zone(`z${index}`, index + 2),
    );
    expect(errors(value).some((issue) => issue.path === "distanceZones")).toBe(
      true,
    );
    value.triggers[0].zones = [zone("all", 2, 400)];
    value.triggers[0].zones[0].onEnter = Array.from(
      { length: 65 },
      (_, index) => ({
        id: `a${index}`,
        kind: "volume" as const,
        target: "ambient" as const,
        volume: 10,
        fadeMs: 0,
      }),
    );
    expect(errors(value).some((issue) => issue.path === "zoneActions")).toBe(
      true,
    );
    value.triggers[0].zones[0].onEnter.pop();
    value.states[2].durationMs = 100_000;
    value.states[2].events = Array.from({ length: 100 }, (_, index) => ({
      id: `event-${index}`,
      outputId: "output-1",
      startMs: index * 500,
      endMs: index * 500 + 100,
    }));
    const compiled = compileProject(value);
    expect(compiled.usedBytes).toBeGreaterThan(1024);
    expect(compiled.bytes).toHaveLength(0);
    expect(compiled.issues.some((issue) => issue.path === "capacity")).toBe(
      true,
    );
  });

  it("retains but warns about legacy transition mappings while their sensor uses zones", () => {
    const value = project();
    value.states[0].transitions.push({
      triggerId: value.triggers[0].id,
      targetStateId: "approach",
    });
    expect(errors(value)).toEqual([]);
    expect(
      validateProject(value).some(
        (issue) =>
          issue.severity === "warning" &&
          issue.message.includes("single-threshold transition"),
      ),
    ).toBe(true);
    expect(compileProject(value).bytes.length).toBeGreaterThan(0);
  });
});
