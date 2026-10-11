import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileProject,
  createDefaultProject,
  synchronizeAudioPlayers,
} from "../../src/shared";

interface FakePort {
  path: string;
  isOpen: boolean;
  writes: string[];
  callbacks: Array<(error?: Error) => void>;
  deferWriteCallbacks: boolean;
  onWrite: (command: string) => void;
  reply(value: unknown): void;
  bytes(value: string): void;
  completeOpen(): void;
}
const mock = vi.hoisted(() => ({ ports: [] as FakePort[], deferOpen: false }));
vi.mock("serialport", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    SerialPort: class extends EventEmitter {
      path: string;
      isOpen = false;
      writes: string[] = [];
      callbacks: Array<(error?: Error) => void> = [];
      deferWriteCallbacks = false;
      private opening?: (error?: Error) => void;
      onWrite = (command: string) => {
        if (command === "HELLO")
          this.reply({
            type: "hello",
            protocol: 1,
            board: "uno",
            capacity: 1024,
          });
      };
      constructor(options: { path: string }) {
        super();
        this.path = options.path;
        mock.ports.push(this);
      }
      static list() {
        return Promise.resolve([{ path: "MOCK" }]);
      }
      open(callback: (error?: Error) => void) {
        this.opening = callback;
        if (!mock.deferOpen) this.completeOpen();
      }
      completeOpen() {
        this.isOpen = true;
        this.opening?.();
        this.opening = undefined;
      }
      close(callback: () => void) {
        this.isOpen = false;
        this.emit("close");
        callback();
      }
      write(value: string, callback: (error?: Error) => void) {
        const command = value.trim();
        this.writes.push(command);
        this.callbacks.push(callback);
        if (!this.deferWriteCallbacks) callback();
        void Promise.resolve().then(() => this.onWrite(command));
      }
      reply(value: unknown) {
        this.bytes(`${JSON.stringify(value)}\n`);
      }
      bytes(value: string) {
        this.emit("data", Buffer.from(value));
      }
    },
  };
});

import { SerialService } from "../../src/main/serial-service";

const hello = { type: "hello", protocol: 1, board: "uno", capacity: 1024 };
const flush = () => vi.advanceTimersByTimeAsync(0);
const scene = () => Array.from(compileProject(createDefaultProject()).bytes);
const failure = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => value,
    (error) => error as Error,
  );

async function connected(): Promise<{
  service: SerialService;
  port: FakePort;
}> {
  const service = new SerialService();
  const connection = service.connect("MOCK");
  await flush();
  await vi.advanceTimersByTimeAsync(1800);
  await connection;
  return { service, port: mock.ports[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  mock.ports.length = 0;
  mock.deferOpen = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("serial upload and priority controls", () => {
  it.each([undefined, false, "true"])(
    "requires ambient mixing capability before modifying controller storage (%s)",
    async (capability) => {
      const { service, port } = await connected();
      const project = createDefaultProject();
      project.audio.transitionMode = "cut";
      project.audio.ambientTrack = 1;
      project.audio.tracks = [1, 2].map((number) => ({
        number,
        name: `Track ${number}`,
      }));
      project.states[1].foregroundTrack = 2;
      project.audio.keepAmbient = true;
      project.audio.ambientMixVolume = 8;
      const values = Array.from(
        compileProject(synchronizeAudioPlayers(project)).bytes,
      );
      port.onWrite = () =>
        port.reply({ ...hello, audioAmbientMix: capability });
      const rejected = failure(service.upload(values));
      await flush();
      expect(String(await rejected)).toContain("mix ambient with foreground");
      expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
        false,
      );
      port.onWrite = (command) => {
        if (command === "HELLO")
          port.reply({ ...hello, audioAmbientMix: true });
        else if (command.startsWith("DATA ")) {
          const [, offset, data] = command.split(" ");
          port.reply({
            type: "ack",
            command: "DATA",
            offset: Number(offset) + data.length / 2,
          });
        } else port.reply({ type: "ack", command: command.split(" ")[0] });
      };
      const accepted = service.upload(values);
      await flush();
      expect(await accepted).toEqual({ type: "ack", command: "COMMIT" });
      await service.disconnect();
    },
  );

  it("requires fade-through capability before invalidating existing controller storage", async () => {
    const { service, port } = await connected();
    const project = createDefaultProject();
    project.audio.transitionMode = "fade-through";
    const values = Array.from(
      compileProject(synchronizeAudioPlayers(project)).bytes,
    );
    port.onWrite = () => port.reply(hello);
    const rejected = failure(service.upload(values));
    await flush();
    expect(String(await rejected)).toContain("Install the updated firmware");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );

    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, audioFadeThrough: true });
      else if (command.startsWith("DATA ")) {
        const [, offset, data] = command.split(" ");
        port.reply({
          type: "ack",
          command: "DATA",
          offset: Number(offset) + data.length / 2,
        });
      } else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const accepted = service.upload(values);
    await flush();
    expect(await accepted).toEqual({ type: "ack", command: "COMMIT" });
    await service.disconnect();
  });

  it("requires explicit distance-zone support before changing controller storage", async () => {
    const { service, port } = await connected();
    const project = createDefaultProject();
    Object.assign(project.triggers[0], {
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
          hysteresisCm: 10,
          onEnter: [{ id: "approach", kind: "state", stateId: "approach" }],
          onExit: [],
        },
      ],
    });
    const values = [...compileProject(synchronizeAudioPlayers(project)).bytes];
    expect(values.length).toBeGreaterThan(32);
    for (const distanceZones of [undefined, false, "true"]) {
      port.onWrite = () => port.reply({ ...hello, distanceZones });
      const denied = failure(service.upload(values));
      await flush();
      expect(String(await denied)).toContain("ultrasonic distance zones");
      expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
        false,
      );
    }
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, distanceZones: true });
      else if (command.startsWith("DATA ")) {
        const [, offset, data] = command.split(" ");
        port.reply({
          type: "ack",
          command: "DATA",
          offset: Number(offset) + data.length / 2,
        });
      } else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const accepted = service.upload(values);
    await flush();
    expect(await accepted).toEqual({ type: "ack", command: "COMMIT" });
    await service.disconnect();
  });

  it("uploads valid images in acknowledged chunks and commits only after the last chunk", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(hello);
      else if (command.startsWith("DATA ")) {
        const [, offset, data] = command.split(" ");
        port.reply({
          type: "ack",
          command: "DATA",
          offset: Number(offset) + data.length / 2,
        });
      } else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const result = service.upload(scene());
    await flush();
    expect(await result).toEqual({ type: "ack", command: "COMMIT" });
    expect(
      port.writes.filter((command) => command.startsWith("DATA ")),
    ).toHaveLength(6);
    expect(port.writes.at(-1)).toBe("COMMIT");
    await service.disconnect();
  });

  it("sends STOP immediately during upload, ignores late DATA replies and never commits", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(hello);
      else if (command.startsWith("BEGIN "))
        port.reply({ type: "ack", command: "BEGIN" });
    };
    const uploading = failure(service.upload(scene()));
    await flush();
    expect(port.writes.at(-1)?.startsWith("DATA 0 ")).toBe(true);
    const stopping = service.command("STOP");
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await flush();
    expect(port.writes.at(-1)).toBe("STOP");
    expect(await uploading).toBeInstanceOf(Error);
    // A reply to the abandoned DATA request must not complete the new STOP.
    port.reply({ type: "ack", command: "DATA", offset: 32 });
    port.reply({ type: "error", message: "Late abandoned DATA error" });
    await flush();
    expect(stopped).toBe(false);
    port.reply({ type: "ack", command: "STOP" });
    expect(await stopping).toEqual({ type: "ack", command: "STOP" });
    expect(port.writes.some((command) => command.startsWith("DATA 32 "))).toBe(
      false,
    );
    expect(port.writes).not.toContain("COMMIT");
    await service.disconnect();
  });

  it("cancels previously queued actions and holds new commands until priority STOP completes", async () => {
    const { service, port } = await connected();
    port.onWrite = () => {};
    const oldStatus = failure(service.command("STATUS"));
    const oldReset = failure(service.command("RESET"));
    await flush();
    const stopping = service.command("STOP");
    const newStatus = service.command("STATUS");
    await flush();
    expect(port.writes.slice(-2)).toEqual(["STATUS", "STOP"]);
    expect(await oldStatus).toBeInstanceOf(Error);
    expect(await oldReset).toBeInstanceOf(Error);
    expect(port.writes).not.toContain("RESET");
    port.reply({ type: "ack", command: "STOP" });
    await stopping;
    await flush();
    expect(port.writes.at(-1)).toBe("STATUS");
    port.reply({ type: "status", running: false });
    expect(await newStatus).toEqual({ type: "status", running: false });
    await service.disconnect();
  });

  it("does not allow a cancelled request timer or write callback to fail the new STOP waiter", async () => {
    const { service, port } = await connected();
    port.onWrite = () => {};
    port.deferWriteCallbacks = true;
    const status = failure(service.command("STATUS"));
    await flush();
    const oldWriteCallback = port.callbacks.at(-1)!;
    await vi.advanceTimersByTimeAsync(2000);
    const stopping = service.command("STOP");
    await flush();
    expect(await status).toBeInstanceOf(Error);
    oldWriteCallback(new Error("Late error from cancelled write"));
    // The original STATUS timer would expire after another 500 ms.
    await vi.advanceTimersByTimeAsync(600);
    port.reply({ type: "ack", command: "STOP" });
    expect(await stopping).toEqual({ type: "ack", command: "STOP" });
    await service.disconnect();
  });

  it("disconnects immediately while a request is unresponsive", async () => {
    const { service, port } = await connected();
    port.onWrite = () => {};
    const status = failure(service.command("STATUS"));
    await flush();
    await service.disconnect();
    expect(port.isOpen).toBe(false);
    expect(service.path).toBeUndefined();
    expect(await status).toBeInstanceOf(Error);
  });

  it("closes a port that finishes opening after disconnect", async () => {
    mock.deferOpen = true;
    const service = new SerialService();
    const connection = failure(service.connect("MOCK"));
    await flush();
    const port = mock.ports[0];
    await service.disconnect();
    port.completeOpen();
    await flush();
    expect(await connection).toBeInstanceOf(Error);
    expect(port.isOpen).toBe(false);
    expect(port.writes).toEqual([]);
    expect(service.path).toBeUndefined();
  });

  it("validates board identity and CRC before invalidating controller storage", async () => {
    const { service, port } = await connected();
    port.onWrite = () => port.reply({ ...hello, board: "mega" });
    const mismatch = failure(service.upload(scene()));
    await flush();
    expect(String(await mismatch)).toContain("does not match");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    const corrupt = scene();
    corrupt[40] ^= 1;
    const badCrc = failure(service.upload(corrupt));
    await flush();
    expect(String(await badCrc)).toContain("checksum");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    await service.disconnect();
  });

  it("rejects malformed capability reports before beginning an upload", async () => {
    const { service, port } = await connected();
    port.onWrite = () => port.reply({ ...hello, capacity: null });
    const uploading = failure(service.upload(scene()));
    await flush();
    expect(String(await uploading)).toContain("invalid storage capacity");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    await service.disconnect();
  });

  it("parses fragmented lines and accepts only the requested reply kind", async () => {
    const { service, port } = await connected();
    port.onWrite = () => {};
    let resolved = false;
    const status = service.command("STATUS").then((reply) => {
      resolved = true;
      return reply;
    });
    await flush();
    port.bytes(
      'legacy boot report\n{"type":"ack","command":"RESET"}\n{"type":"sta',
    );
    await flush();
    expect(resolved).toBe(false);
    port.bytes('tus","running":false}\r\n');
    expect(await status).toEqual({ type: "status", running: false });
    await service.disconnect();
  });
});
