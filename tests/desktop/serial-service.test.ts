import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileProject,
  createDefaultProject,
  createState,
  encodeIrPulses,
  synchronizeAudioPlayers,
  type IrCommand,
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

const hello = { type: "hello", protocol: 1, board: "uno", capacity: 1024 };
const irHello = { ...hello, irLearning: true, irReplay: true };
const irCommand = (raw = false): IrCommand => ({
  id: "candle-on",
  name: "Candle on",
  signal: raw
    ? {
        kind: "raw",
        pulsesUs: Array.from({ length: 35 }, (_, index) =>
          index % 2 ? 1000 : 500,
        ),
      }
    : { kind: "nec", code: 0xff00aa55 },
  sendCount: 2,
  gapMs: 150,
});

describe("manual output testing", () => {
  it("tries STOP before disconnecting a live test session", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, outputTest: true });
      else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const begin = service.beginOutputTest(scene());
    await flush();
    await begin;
    const disconnect = service.disconnect();
    await flush();
    await disconnect;
    expect(port.writes.at(-1)).toBe("STOP");
    expect(port.isOpen).toBe(false);
  });

  it("closes a disconnected test device after a bounded STOP attempt", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, outputTest: true });
      else if (command.startsWith("TESTBEGIN"))
        port.reply({ type: "ack", command: "TESTBEGIN" });
    };
    const begin = service.beginOutputTest(scene());
    await flush();
    await begin;
    const disconnect = service.disconnect();
    await flush();
    expect(port.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await disconnect;
    expect(port.isOpen).toBe(false);
  });

  it("preflights capability and board before touching physical outputs", async () => {
    const { service, port } = await connected();
    for (const capability of [undefined, false, "true"]) {
      port.onWrite = () => port.reply({ ...hello, outputTest: capability });
      const result = failure(service.beginOutputTest(scene()));
      await flush();
      expect(String(await result)).toContain("updated firmware");
    }
    port.onWrite = () =>
      port.reply({ ...hello, outputTest: true, board: "mega" });
    const mismatch = failure(service.beginOutputTest(scene()));
    await flush();
    expect(String(await mismatch)).toContain("Project board");
    expect(port.writes.some((command) => command.startsWith("TESTBEGIN"))).toBe(
      false,
    );
    await service.disconnect();
  });

  it("binds test mode to the exact uploaded scene and serializes output/heartbeat commands", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, outputTest: true });
      else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const bytes = scene();
    const testing = service.beginOutputTest(bytes);
    const on = service.setTestOutputs(0x80000001);
    const heartbeat = service.setTestOutputs(0x80000001);
    const off = service.setTestOutputs(0);
    await flush();
    await Promise.all([testing, on, heartbeat, off]);
    expect(port.writes.slice(-4)).toEqual([
      `TESTBEGIN ${bytes.length} ${bytes[6] | (bytes[7] << 8)}`,
      "TEST 2147483649",
      "TEST 2147483649",
      "TEST 0",
    ]);
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    expect(port.writes).not.toContain("RUN");
    await service.disconnect();
  });

  it("rejects malformed images and indices before any serial write", async () => {
    const { service, port } = await connected();
    const count = port.writes.length;
    const bytes = scene();
    bytes[32] ^= 1;
    await expect(service.beginOutputTest(bytes)).rejects.toThrow(
      "Invalid compiled scene",
    );
    for (const mask of [-1, 0x100000000, 1.1, NaN, "1"])
      await expect(service.setTestOutputs(mask as number)).rejects.toThrow(
        "Invalid output test",
      );
    expect(port.writes).toHaveLength(count);
    await service.disconnect();
  });

  it("STOP cancels a pending output change and queued heartbeat without later reactivation", async () => {
    const { service, port } = await connected();
    port.onWrite = () => {};
    const changing = failure(service.setTestOutputs(4));
    const keep = failure(service.setTestOutputs(4));
    await flush();
    const stop = service.endOutputTest();
    await flush();
    expect(port.writes.at(-1)).toBe("STOP");
    port.reply({ type: "ack", command: "TEST" });
    port.reply({ type: "ack", command: "STOP" });
    await stop;
    expect(await changing).toBeInstanceOf(Error);
    expect(await keep).toBeInstanceOf(Error);
    expect(port.writes.filter((command) => command === "TEST 4")).toHaveLength(
      1,
    );
    await service.disconnect();
  });

  it("preserves the running scene after an explicit stale-scene rejection", async () => {
    const { service, port } = await connected();
    let running = true;
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, outputTest: true });
      else if (command.startsWith("TESTBEGIN"))
        port.reply({
          type: "error",
          message: "Upload this scene before testing outputs",
        });
      else if (command === "STOP") {
        running = false;
        port.reply({ type: "ack", command: "STOP" });
      }
    };
    const result = failure(service.beginOutputTest(scene()));
    await flush();
    expect(String(await result)).toContain("Upload this scene");
    expect(port.writes).not.toContain("STOP");
    expect(running).toBe(true);
    expect(port.writes).not.toContain("RUN");
    await service.disconnect();
    expect(port.writes).not.toContain("STOP");
  });

  it.each(["timeout", "write error"])(
    "uses STOP cleanup when TESTBEGIN outcome is uncertain (%s)",
    async (reason) => {
      const { service, port } = await connected();
      port.deferWriteCallbacks = true;
      port.onWrite = (command) => {
        if (command === "HELLO") port.reply({ ...hello, outputTest: true });
        else if (command === "STOP")
          port.reply({ type: "ack", command: "STOP" });
      };
      const result = failure(service.beginOutputTest(scene()));
      await flush();
      expect(port.writes.at(-1)).toMatch(/^TESTBEGIN /);
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(2500);
      else port.callbacks.at(-1)!(new Error("USB write failed"));
      await flush();
      expect(await result).toBeInstanceOf(Error);
      expect(port.writes.at(-1)).toBe("STOP");
      port.onWrite = (command) => port.reply({ type: "ack", command });
      const run = service.command("RUN");
      await flush();
      expect(await run).toEqual({ type: "ack", command: "RUN" });
      await service.disconnect();
    },
  );

  it("guards conflicting operations when they execute after a queued test begin", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...irHello, outputTest: true });
      else if (command === "STATUS")
        port.reply({ type: "status", testingOutputs: true });
      else if (!command.startsWith("TESTBEGIN"))
        port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const beginning = service.beginOutputTest(scene());
    const conflicts = [
      service.command("RUN"),
      service.command("RESET"),
      service.command("TRIGGER 0"),
      service.learnIr(),
      service.testIr(irCommand()),
      service.upload(scene()),
      service.beginOutputTest(scene()),
      service.connect("OTHER"),
    ].map((promise) => failure<unknown>(promise));
    const mask = service.setTestOutputs(1);
    const status = service.command("STATUS");
    const greeting = service.command("HELLO");
    await flush();
    expect(port.writes.at(-1)).toMatch(/^TESTBEGIN /);
    port.reply({ type: "ack", command: "TESTBEGIN" });
    await flush();
    await beginning;
    for (const result of await Promise.all(conflicts))
      expect(String(result)).toContain("Send STOP to exit output test");
    expect(await mask).toEqual({ type: "ack", command: "TEST" });
    expect(await status).toMatchObject({ type: "status" });
    expect(await greeting).toMatchObject({ type: "hello" });
    expect(port.writes.slice(-3)).toEqual(["TEST 1", "STATUS", "HELLO"]);
    expect(
      port.writes.some((command) =>
        /^(RUN|RESET|TRIGGER|IRLEARN|IRBEGIN|BEGIN|STOP)( |$)/.test(command),
      ),
    ).toBe(false);
    expect(port.isOpen).toBe(true);
    expect(mock.ports).toHaveLength(1);
    const stop = service.endOutputTest();
    await flush();
    await stop;
    const run = service.command("RUN");
    await flush();
    expect(await run).toEqual({ type: "ack", command: "RUN" });
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply({ ...hello, outputTest: true });
      else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const restarted = service.beginOutputTest(scene());
    await flush();
    expect(await restarted).toEqual({ type: "ack", command: "TESTBEGIN" });
    await service.disconnect();
  });
});

describe("IR learning and RAM tests", () => {
  it("reports the current connection and capability snapshot without serial traffic", async () => {
    const { service, port } = await connected();
    expect(service.getDeviceStatus()).toEqual({
      connected: true,
      port: "MOCK",
      hello,
    });
    const writes = port.writes.length;
    const updates: unknown[] = [];
    service.on("status", (status) => updates.push(status));
    port.reply(irHello);
    expect(service.getDeviceStatus()).toEqual({
      connected: true,
      port: "MOCK",
      hello: irHello,
    });
    expect(updates.at(-1)).toEqual(service.getDeviceStatus());
    expect(port.writes).toHaveLength(writes);
    await service.disconnect();
    expect(service.getDeviceStatus()).toEqual({ connected: false });
  });

  it("waits for a complete capture, decodes NEC, and leaves the controller stopped", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      if (command === "IRLEARN")
        port.reply({ type: "ack", command: "IRLEARN" });
    };
    let finished = false;
    const learning = service.learnIr().then((signal) => {
      finished = true;
      return signal;
    });
    await flush();
    expect(port.writes.at(-1)).toBe("IRLEARN");
    expect(finished).toBe(false);
    const signal = { kind: "nec" as const, code: 0xff00aa55 };
    port.reply({ type: "ir-capture", pulsesUs: encodeIrPulses(signal) });
    expect(await learning).toEqual(signal);
    expect(port.writes).not.toContain("RUN");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    await service.disconnect();
  });

  it("normalizes supported raw captures without assuming they are NEC", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      if (command === "IRLEARN")
        port.reply({
          type: "ir-capture",
          pulsesUs: [2010, 920, 470, 610, 510],
        });
    };
    const learning = service.learnIr();
    await flush();
    expect(await learning).toEqual({
      kind: "raw",
      pulsesUs: [2000, 900, 450, 600, 500],
    });
    await service.disconnect();
  });

  it.each([
    undefined,
    [],
    [500, 500],
    [100000, 500, 500, 500, 500],
    [500, "500", 500, 500, 500],
  ])(
    "rejects malformed capture %s and performs STOP cleanup",
    async (pulsesUs) => {
      const { service, port } = await connected();
      port.onWrite = (command) => {
        if (command === "HELLO") port.reply(irHello);
        if (command === "IRLEARN") port.reply({ type: "ir-capture", pulsesUs });
        if (command === "STOP") port.reply({ type: "ack", command: "STOP" });
      };
      const learning = failure(service.learnIr());
      await flush();
      expect(await learning).toBeInstanceOf(Error);
      expect(port.writes.at(-1)).toBe("STOP");
      expect(port.writes).not.toContain("RUN");
      await service.disconnect();
    },
  );

  it("cleans up a timed-out learning request and never implicitly runs the scene", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      if (command === "STOP") port.reply({ type: "ack", command: "STOP" });
    };
    const learning = failure(service.learnIr());
    await flush();
    await vi.advanceTimersByTimeAsync(15999);
    expect(port.writes.at(-1)).toBe("IRLEARN");
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await learning)).toContain("did not respond to IRLEARN");
    expect(port.writes.at(-1)).toBe("STOP");
    expect(port.writes).not.toContain("RUN");
    await service.disconnect();
  });

  it("cancels learning and queued work immediately, ignoring late captures while STOP waits", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
    };
    const learning = failure(service.learnIr());
    const queued = failure(service.command("RESET"));
    await flush();
    const stopping = service.cancelIr();
    await flush();
    expect(await learning).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(port.writes.at(-1)).toBe("STOP");
    let finished = false;
    void stopping.then(() => {
      finished = true;
    });
    port.reply({
      type: "ir-capture",
      pulsesUs: encodeIrPulses(irCommand().signal),
    });
    port.reply({ type: "error", message: "late capture failure" });
    await flush();
    expect(finished).toBe(false);
    port.reply({ type: "ack", command: "STOP" });
    await stopping;
    expect(port.writes.filter((command) => command === "STOP")).toHaveLength(1);
    expect(port.writes).not.toContain("RESET");
    await service.disconnect();
  });

  it("cancels learning on disconnect without sending cleanup to a closed session", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
    };
    const learning = failure(service.learnIr());
    await flush();
    await service.disconnect();
    expect(await learning).toBeInstanceOf(Error);
    expect(port.writes.at(-1)).toBe("IRLEARN");
    expect(port.isOpen).toBe(false);
  });

  it.each([undefined, false, "true"])(
    "requires explicit capabilities for learning and RAM tests (%s)",
    async (value) => {
      const { service, port } = await connected();
      port.onWrite = () =>
        port.reply({ ...hello, irLearning: value, irReplay: value });
      const learning = failure(service.learnIr());
      await flush();
      expect(String(await learning)).toContain("updated firmware");
      const testing = failure(service.testIr(irCommand()));
      await flush();
      expect(String(await testing)).toContain("updated firmware");
      expect(port.writes.every((command) => command === "HELLO")).toBe(true);
      await service.disconnect();
    },
  );

  it("sends a NEC RAM command without any EEPROM writes or raw payload", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const testing = service.testIr(irCommand());
    await flush();
    expect(await testing).toEqual({ type: "ack", command: "IRPLAY" });
    expect(port.writes.slice(-2)).toEqual([
      "IRBEGIN 0 0 2 150 4278233685",
      "IRPLAY",
    ]);
    expect(
      port.writes.some((command) =>
        /^(BEGIN|DATA|COMMIT|RUN)( |$)/.test(command),
      ),
    ).toBe(false);
    await service.disconnect();
  });

  it("sends raw 50us bytes in bounded contiguous acknowledged chunks", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      else if (command.startsWith("IRDATA ")) {
        const [, offset, hex] = command.split(" ");
        port.reply({
          type: "ack",
          command: "IRDATA",
          offset: Number(offset) + hex.length / 2,
        });
      } else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const testing = service.testIr(irCommand(true));
    await flush();
    expect(await testing).toEqual({ type: "ack", command: "IRPLAY" });
    expect(port.writes).toContain("IRBEGIN 1 35 2 150 0");
    const chunks = port.writes.filter((command) =>
      command.startsWith("IRDATA "),
    );
    expect(chunks).toEqual([
      `IRDATA 0 ${"0a14".repeat(16)}`,
      "IRDATA 32 0a140a",
    ]);
    expect(port.writes.at(-1)).toBe("IRPLAY");
    await service.disconnect();
  });

  it("stops a rejected raw transfer without transmitting or continuing it", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      else if (command.startsWith("IRDATA "))
        port.reply({ type: "ack", command: "IRDATA", offset: 99 });
      else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const testing = failure(service.testIr(irCommand(true)));
    await flush();
    expect(String(await testing)).toContain("unexpected IR data offset");
    expect(port.writes.at(-1)).toBe("STOP");
    expect(port.writes).not.toContain("IRPLAY");
    expect(port.writes.some((command) => command.startsWith("IRDATA 32"))).toBe(
      false,
    );
    await service.disconnect();
  });

  it("keeps STOP immediate during RAM transfer and prevents later IRPLAY", async () => {
    const { service, port } = await connected();
    port.onWrite = (command) => {
      if (command === "HELLO") port.reply(irHello);
      if (command.startsWith("IRBEGIN "))
        port.reply({ type: "ack", command: "IRBEGIN" });
      if (command === "STOP") port.reply({ type: "ack", command: "STOP" });
    };
    const testing = failure(service.testIr(irCommand(true)));
    await flush();
    expect(port.writes.at(-1)?.startsWith("IRDATA 0 ")).toBe(true);
    const stopping = service.cancelIr();
    await flush();
    await stopping;
    expect(await testing).toBeInstanceOf(Error);
    expect(port.writes.at(-1)).toBe("STOP");
    expect(port.writes).not.toContain("IRPLAY");
    await service.disconnect();
  });

  it.each([
    null,
    { ...irCommand(), sendCount: 0 },
    { ...irCommand(), gapMs: 51 },
    { ...irCommand(), signal: { kind: "nec", code: -1 } },
    {
      ...irCommand(),
      signal: { kind: "raw", pulsesUs: [101, 100, 100, 100, 100] },
    },
  ])(
    "rejects invalid RAM commands before serial mutation (%s)",
    async (value) => {
      const { service, port } = await connected();
      const writes = port.writes.length;
      const testing = failure(service.testIr(value as IrCommand));
      await flush();
      expect(String(await testing)).toContain("Invalid IR command");
      expect(port.writes).toHaveLength(writes);
      await service.disconnect();
    },
  );

  it("preserves the generic command allowlist", async () => {
    const { service, port } = await connected();
    for (const command of ["IRLEARN", "IRPLAY", "IRBEGIN 0 0 1 100 1"])
      await expect(service.command(command)).rejects.toThrow(
        "Unsupported controller command",
      );
    expect(port.writes).toEqual(["HELLO"]);
    await service.disconnect();
  });

  it("requires IR replay for v2 before BEGIN and permits an IR-only image without zone capability", async () => {
    const { service, port } = await connected();
    const project = createDefaultProject();
    project.ir = {
      enabled: true,
      txPin: null,
      rxPin: null,
      commands: [irCommand()],
    };
    project.states[0].irEvents = [
      { id: "candle-start", atMs: 0, commandId: "candle-on" },
    ];
    const values = [...compileProject(synchronizeAudioPlayers(project)).bytes];
    expect(values.at(-6)).toBe(2);
    expect(values.at(-5)).toBe(0);
    for (const irReplay of [undefined, false, "true"]) {
      port.onWrite = () => port.reply({ ...hello, irReplay });
      const denied = failure(service.upload(values));
      await flush();
      expect(String(await denied)).toContain("use IR commands");
      expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
        false,
      );
    }
    port.onWrite = (command) => {
      if (command === "HELLO")
        port.reply({ ...hello, irReplay: true, distanceZones: false });
      else if (command.startsWith("DATA ")) {
        const [, offset, data] = command.split(" ");
        port.reply({
          type: "ack",
          command: "DATA",
          offset: Number(offset) + data.length / 2,
        });
      } else port.reply({ type: "ack", command: command.split(" ")[0] });
    };
    const uploaded = service.upload(values);
    await flush();
    expect(await uploaded).toEqual({ type: "ack", command: "COMMIT" });
    await service.disconnect();
  });

  it("requires both capabilities when a v2 image combines IR and distance zones", async () => {
    const { service, port } = await connected();
    const project = createDefaultProject();
    project.ir = {
      enabled: true,
      txPin: null,
      rxPin: null,
      commands: [irCommand()],
    };
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
          onEnter: [{ id: "on", kind: "ir", commandId: "candle-on" }],
          onExit: [],
        },
      ],
    });
    const values = [...compileProject(synchronizeAudioPlayers(project)).bytes];
    expect(values.at(-6)).toBe(2);
    expect(values.at(-5)).toBe(1);
    port.onWrite = () => port.reply({ ...hello, irReplay: true });
    const denied = failure(service.upload(values));
    await flush();
    expect(String(await denied)).toContain("ultrasonic distance zones");
    expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
      false,
    );
    await service.disconnect();
  });
});

import { SerialService } from "../../src/main/serial-service";

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
    "requires explicit manual-trigger support before any storage writes (%s)",
    async (manualTriggers) => {
      const { service, port } = await connected();
      const project = createDefaultProject();
      Object.assign(project.triggers[0], {
        kind: "manual",
        pin: null,
        echoPin: null,
      });
      const compiled = compileProject(project);
      expect(
        compiled.issues.filter((issue) => issue.severity === "error"),
      ).toEqual([]);
      const values = [...compiled.bytes];
      port.onWrite = () =>
        port.reply({ ...hello, sceneControls: true, manualTriggers });
      const rejected = failure(service.upload(values));
      await flush();
      expect(String(await rejected)).toContain("app / manual triggers");
      expect(port.writes.every((command) => command === "HELLO")).toBe(true);
      port.onWrite = (command) => {
        if (command === "HELLO")
          port.reply({ ...hello, sceneControls: true, manualTriggers: true });
        else if (command.startsWith("DATA ")) {
          const [, offset, data] = command.split(" ");
          port.reply({
            type: "ack",
            command: "DATA",
            offset: Number(offset) + data.length / 2,
          });
        } else port.reply({ type: "ack", command: command.split(" ")[0] });
      };
      const uploaded = service.upload(values);
      await flush();
      expect(await uploaded).toEqual({ type: "ack", command: "COMMIT" });
      await service.disconnect();
    },
  );

  it.each([
    [undefined, true],
    [false, true],
    ["true", true],
    [true, undefined],
    [true, false],
    [true, "true"],
  ])(
    "requires explicit child and scene-controls capabilities before CPC3 writes (%s, %s)",
    async (parallelChildren, sceneControls) => {
      const { service, port } = await connected();
      const project = createDefaultProject();
      const child = createState("blast", "Ankle blaster");
      child.kind = "child";
      child.durationMs = 250;
      child.cooldownMs = 2000;
      child.events = [
        { id: "pulse", outputId: "output-8", startMs: 0, endMs: 250 },
      ];
      project.states.push(child);
      project.states[1].transitions = [
        { triggerId: project.triggers[1].id, targetStateId: child.id },
      ];
      const compiled = compileProject(project);
      expect(
        compiled.issues.filter((issue) => issue.severity === "error"),
      ).toEqual([]);
      const values = [...compiled.bytes];
      expect(String.fromCharCode(...values.slice(0, 4))).toBe("CPC3");
      port.onWrite = () =>
        port.reply({ ...hello, parallelChildren, sceneControls });
      const rejected = failure(service.upload(values));
      await flush();
      expect(String(await rejected)).toContain(
        parallelChildren === true
          ? "advanced scene controls"
          : "parallel child sequences",
      );
      expect(port.writes.every((command) => command === "HELLO")).toBe(true);
      port.onWrite = (command) => {
        if (command === "HELLO")
          port.reply({ ...hello, parallelChildren: true, sceneControls: true });
        else if (command.startsWith("DATA ")) {
          const [, offset, data] = command.split(" ");
          port.reply({
            type: "ack",
            command: "DATA",
            offset: Number(offset) + data.length / 2,
          });
        } else port.reply({ type: "ack", command: command.split(" ")[0] });
      };
      const uploaded = service.upload(values);
      await flush();
      expect(await uploaded).toEqual({ type: "ack", command: "COMMIT" });
      await service.disconnect();
    },
  );

  it.each([undefined, false, "true"])(
    "requires explicit CPC2 scene-controls support before changing saved storage (%s)",
    async (capability) => {
      const { service, port } = await connected();
      const project = createDefaultProject();
      project.states[1].events[0].active = false;
      const values = [...compileProject(project).bytes];
      expect(String.fromCharCode(...values.slice(0, 4))).toBe("CPC2");
      port.onWrite = () => port.reply({ ...hello, sceneControls: capability });
      const rejected = failure(service.upload(values));
      await flush();
      expect(String(await rejected)).toContain("advanced scene controls");
      expect(port.writes.some((command) => command.startsWith("BEGIN "))).toBe(
        false,
      );
      port.onWrite = (command) => {
        if (command === "HELLO") port.reply({ ...hello, sceneControls: true });
        else if (command.startsWith("DATA ")) {
          const [, offset, data] = command.split(" ");
          port.reply({
            type: "ack",
            command: "DATA",
            offset: Number(offset) + data.length / 2,
          });
        } else port.reply({ type: "ack", command: command.split(" ")[0] });
      };
      const upload = service.upload(values);
      await flush();
      expect(await upload).toEqual({ type: "ack", command: "COMMIT" });
      await service.disconnect();
    },
  );

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
