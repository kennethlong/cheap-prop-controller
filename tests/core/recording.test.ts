import { describe, expect, it } from "vitest";
import {
  applyRecording,
  quantizeRecordedInterval,
} from "../../src/shared/recording";
import type { TimelineEvent } from "../../src/shared/model";

const event = (
  id: string,
  outputId: string,
  startMs: number,
  endMs: number,
  active = true,
): TimelineEvent => ({ id, outputId, startMs, endMs, active });
let sequence = 0;
const nextId = () => `split-${++sequence}`;

describe("performance recording", () => {
  it("snaps edges to 20 FPS and keeps a short tap as one frame", () => {
    expect(
      quantizeRecordedInterval("lamp", false, 74, 77, 1000, "tap"),
    ).toEqual(event("tap", "lamp", 50, 100, false));
    expect(
      quantizeRecordedInterval("lamp", true, 976, 1500, 1000, "last"),
    ).toEqual(event("last", "lamp", 950, 1000));
    expect(
      quantizeRecordedInterval("lamp", true, -20, 200, 1000, "first"),
    ).toEqual(event("first", "lamp", 0, 200));
  });

  it("discards holds outside the take or malformed timestamps", () => {
    for (const [start, end, duration] of [
      [1000, 1100, 1000],
      [100, 50, 1000],
      [0, Infinity, 1000],
      [0, 50, NaN],
      [-100, -50, 1000],
      [0, 20, 20],
    ])
      expect(
        quantizeRecordedInterval("lamp", true, start, end, duration, "bad"),
      ).toBeNull();
  });

  it("overdubs OFF within ON without erasing the rest of the performance", () => {
    const original = [
      event("old", "lamp", 0, 1000),
      event("other", "relay", 0, 500),
    ];
    const result = applyRecording(
      original,
      [event("dark", "lamp", 200, 300, false)],
      ["lamp"],
      "overdub",
      nextId,
    );
    expect(
      result
        .filter((item) => item.outputId === "lamp")
        .map(({ startMs, endMs, active }) => [startMs, endMs, active]),
    ).toEqual([
      [0, 200, true],
      [200, 300, false],
      [300, 1000, true],
    ]);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
    expect(result.find((item) => item.id === "other")).toEqual(original[1]);
    expect(original[0].endMs).toBe(1000);
  });

  it("lets a later captured hold replace an earlier hold in the same range", () => {
    const result = applyRecording(
      [],
      [
        event("on", "lamp", 0, 500),
        event("off", "lamp", 100, 400, false),
        event("on-again", "lamp", 200, 300),
      ],
      ["lamp"],
      "overdub",
      nextId,
    );
    expect(
      result.map(({ startMs, endMs, active }) => [startMs, endMs, active]),
    ).toEqual([
      [0, 100, true],
      [100, 200, false],
      [200, 300, true],
      [300, 400, false],
      [400, 500, true],
    ]);
  });

  it("combines touching and overlapping same-value holds into compact events", () => {
    const original = [
      { id: "legacy", outputId: "lamp", startMs: 0, endMs: 100 },
    ];
    const result = applyRecording(
      original,
      [event("new", "lamp", 100, 200), event("overlap", "lamp", 150, 300)],
      ["lamp"],
      "overdub",
      nextId,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "legacy", startMs: 0, endMs: 300 });
  });

  it("replace clears every armed lane including a silent one and retains unarmed lanes", () => {
    const result = applyRecording(
      [
        event("old", "lamp", 0, 1000),
        event("silent", "relay", 0, 1000),
        event("keep", "other", 0, 1000),
      ],
      [event("take", "lamp", 200, 300), event("ignored", "other", 100, 200)],
      ["lamp", "relay"],
      "replace",
      nextId,
    );
    expect(result).toEqual([
      event("keep", "other", 0, 1000),
      event("take", "lamp", 200, 300),
    ]);
  });

  it("an empty overdub changes nothing, and an empty replacement clears only armed lanes", () => {
    const original = [event("a", "lamp", 0, 100), event("b", "other", 0, 100)];
    expect(applyRecording(original, [], ["lamp"], "overdub", nextId)).toEqual(
      original,
    );
    expect(applyRecording(original, [], ["lamp"], "replace", nextId)).toEqual([
      original[1],
    ]);
  });
});
