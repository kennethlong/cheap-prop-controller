import type { DeviceReply } from "../desktop-api";

export type ArmingProgress =
  | { phase: "stopping" }
  | { phase: "countdown"; seconds: number }
  | { phase: "arming" };

interface Options {
  stop(): Promise<DeviceReply>;
  reset(): Promise<DeviceReply>;
  progress(value: ArmingProgress | null): void;
}

function requireAck(reply: DeviceReply, command: "STOP" | "RESET") {
  if (reply.type !== "ack" || reply.command !== command)
    throw new Error(
      String(
        reply.message ??
          reply.error ??
          `Controller did not acknowledge ${command}`,
      ),
    );
}

/** One attempt, canceled permanently even when a device reply is still pending. */
export function createDelayedArm(options: Options) {
  let canceled = false;
  let started = false;
  let resetPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishCountdown: ((completed: boolean) => void) | undefined;
  return {
    cancel() {
      canceled = true;
      clearTimeout(timer);
      finishCountdown?.(false);
      options.progress(null);
      return resetPending;
    },
    async run(): Promise<boolean> {
      if (started) throw new Error("Delayed arming has already started");
      started = true;
      if (canceled) return false;
      try {
        options.progress({ phase: "stopping" });
        const stopped = await options.stop();
        if (canceled) return false;
        requireAck(stopped, "STOP");
        // Start the full exit delay only once the physical STOP is confirmed.
        // Recheck a monotonic deadline on every tick so timer drift cannot arm early.
        const deadline = performance.now() + 15_000;
        const completed = await new Promise<boolean>((resolve) => {
          finishCountdown = resolve;
          const tick = () => {
            if (canceled) return resolve(false);
            const remaining = deadline - performance.now();
            if (remaining <= 0) return resolve(true);
            options.progress({
              phase: "countdown",
              seconds: Math.ceil(remaining / 1000),
            });
            if (!canceled) timer = setTimeout(tick, Math.min(remaining, 100));
          };
          tick();
        });
        if (!completed || canceled) return false;
        options.progress({ phase: "arming" });
        if (canceled) return false;
        resetPending = true;
        const armed = await options.reset();
        if (canceled) return false;
        requireAck(armed, "RESET");
        return true;
      } catch (error) {
        // STOP can interrupt an in-flight command. Cancellation is intentional;
        // actual STOP/RESET failures are reported by the owning UI operation.
        if (canceled) return false;
        throw error;
      } finally {
        resetPending = false;
        clearTimeout(timer);
        finishCountdown = undefined;
        options.progress(null);
      }
    },
  };
}
