import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceReply } from "../../src/desktop-api";
import { createDelayedArm } from "../../src/renderer/delayed-arm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const stop = vi.fn(async (): Promise<DeviceReply> => ({
    type: "ack",
    command: "STOP",
  }));
  const reset = vi.fn(async (): Promise<DeviceReply> => ({
    type: "ack",
    command: "RESET",
  }));
  const progress = vi.fn();
  return {
    stop,
    reset,
    progress,
    arm: createDelayedArm({ stop, reset, progress }),
  };
}

describe("delayed controller arming", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => vi.useRealTimers());

  it("waits a full 15 seconds after STOP is acknowledged, then sends one RESET", async () => {
    const { arm, stop, reset, progress } = setup();
    const reply = deferred<DeviceReply>();
    stop.mockReturnValue(reply.promise);
    const result = arm.run();
    expect(progress).toHaveBeenLastCalledWith({ phase: "stopping" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reset).not.toHaveBeenCalled();
    reply.resolve({ type: "ack", command: "STOP" });
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenLastCalledWith({
      phase: "countdown",
      seconds: 15,
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(true);
    expect(reset).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("cancels a countdown and releases its wait without ever sending RESET", async () => {
    const { arm, reset } = setup();
    const result = arm.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(arm.cancel()).toBe(false);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reset).not.toHaveBeenCalled();
  });

  it("does not revive a canceled attempt when a delayed STOP acknowledgement arrives", async () => {
    const { arm, stop, reset, progress } = setup();
    const reply = deferred<DeviceReply>();
    stop.mockReturnValue(reply.promise);
    const result = arm.run();
    arm.cancel();
    reply.resolve({ type: "ack", command: "STOP" });
    expect(await result).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reset).not.toHaveBeenCalled();
    expect(
      progress.mock.calls.some(([value]) => value?.phase === "countdown"),
    ).toBe(false);
  });

  it.each([
    { type: "error", error: "STOP unavailable" },
    { type: "ack", command: "STATUS" },
  ])(
    "requires STOP's own acknowledgement before counting down: %j",
    async (reply) => {
      const { arm, stop, reset, progress } = setup();
      stop.mockResolvedValue(reply);
      await expect(arm.run()).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
      expect(reset).not.toHaveBeenCalled();
      expect(progress).toHaveBeenLastCalledWith(null);
    },
  );

  it("reports transport failures while stopping", async () => {
    const { arm, stop, reset } = setup();
    stop.mockRejectedValue(new Error("USB disconnected"));
    await expect(arm.run()).rejects.toThrow("USB disconnected");
    expect(reset).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a rejected RESET and ends its countdown", async () => {
    const { arm, reset, progress } = setup();
    reset.mockResolvedValue({ type: "error", error: "Scene invalid" });
    const result = expect(arm.run()).rejects.toThrow("Scene invalid");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(progress).toHaveBeenLastCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells the caller to STOP if cancellation races an in-flight RESET", async () => {
    const { arm, reset } = setup();
    const reply = deferred<DeviceReply>();
    reset.mockReturnValue(reply.promise);
    const result = arm.run();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reset).toHaveBeenCalledOnce();
    expect(arm.cancel()).toBe(true);
    reply.resolve({ type: "ack", command: "RESET" });
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks cancellation before issuing RESET at the deadline", async () => {
    const { arm, progress, reset } = setup();
    progress.mockImplementation((value) => {
      if (value?.phase === "arming") arm.cancel();
    });
    const result = arm.run();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });
});
