import { SerialPort } from "serialport";
import { EventEmitter } from "node:events";
import type { DeviceReply, DeviceStatus } from "../desktop-api";
import { verifySceneChecksum } from "../shared/compiler";
import type { IrCommand, IrSignal } from "../shared/model";
import {
  learnIrSignal,
  validateIrCommand,
  validateIrSignal,
} from "../shared/ir";

type Waiter = {
  command: string;
  resolve: (reply: DeviceReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ignoreUnscopedErrors: boolean;
};
/** A parsed controller refusal, distinct from an uncertain transport failure. */
class ControllerRejectionError extends Error {}
export class SerialService extends EventEmitter {
  private port?: SerialPort;
  private buffer = "";
  private waiter?: Waiter;
  private tail: Promise<unknown> = Promise.resolve();
  private controlTail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private outputTestRequested = false;
  hello?: DeviceReply;

  get path() {
    return this.port?.isOpen ? this.port.path : undefined;
  }
  getDeviceStatus(): DeviceStatus {
    return this.path
      ? { connected: true, port: this.path, hello: this.hello }
      : { connected: false };
  }
  list() {
    return SerialPort.list();
  }
  private ensureCurrent(generation: number) {
    if (generation !== this.generation)
      throw new Error("Operation cancelled by STOP or disconnect");
  }
  private requireOutputTestStopped() {
    if (this.outputTestRequested)
      throw new Error("Send STOP to exit output test before this operation.");
  }
  private exclusive<T>(work: (generation: number) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const run = async () => {
      this.ensureCurrent(generation);
      await this.controlTail;
      this.ensureCurrent(generation);
      return work(generation);
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }
  /** Cancel current/queued work before priority control; new work waits for it. */
  private priority<T>(work: () => Promise<T>): Promise<T> {
    const generation = ++this.generation;
    this.fail(new Error("Operation cancelled by STOP or disconnect"));
    const run = () => {
      this.ensureCurrent(generation);
      return work();
    };
    const next = this.controlTail.then(run, run);
    this.controlTail = next.catch(() => undefined);
    return next;
  }
  private receive(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > 16384) this.buffer = this.buffer.slice(-4096);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.emit("log", line);
      try {
        const reply = JSON.parse(line) as DeviceReply;
        if (!reply || typeof reply.type !== "string") continue;
        if (reply.type === "hello") {
          this.hello = reply;
          this.emit("status", this.getDeviceStatus());
        }
        this.emit("message", reply);
        const expected = this.waiter?.command;
        const matches =
          (reply.type === "error" && !this.waiter?.ignoreUnscopedErrors) ||
          (reply.type === "ack" &&
            reply.command === expected &&
            expected !== "IRLEARN") ||
          (reply.type === "hello" && expected === "HELLO") ||
          (reply.type === "status" && expected === "STATUS") ||
          (reply.type === "ir-capture" && expected === "IRLEARN");
        if (this.waiter && matches) {
          const waiter = this.waiter;
          this.waiter = undefined;
          clearTimeout(waiter.timer);
          if (reply.type === "error")
            waiter.reject(
              new ControllerRejectionError(
                String(reply.message ?? "Controller rejected command"),
              ),
            );
          else waiter.resolve(reply);
        }
      } catch {
        /* Legacy boot reports and diagnostics remain visible in the log. */
      }
    }
  }
  private fail(error: Error) {
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(error);
      this.waiter = undefined;
    }
  }
  private async close() {
    this.fail(new Error("Controller disconnected"));
    const port = this.port;
    this.port = undefined;
    this.hello = undefined;
    this.buffer = "";
    this.outputTestRequested = false;
    if (port?.isOpen)
      await new Promise<void>((resolve) => port.close(() => resolve()));
    this.emit("status", { connected: false });
  }
  disconnect() {
    return this.priority(async () => {
      if (this.outputTestRequested && this.port?.isOpen) {
        try {
          await this.request("STOP", 500, true);
        } catch {
          // The controller's 1500 ms lease also covers an unplugged device.
        }
      }
      await this.close();
    });
  }
  connect(path: string): Promise<DeviceReply> {
    return this.exclusive(async (generation) => {
      this.requireOutputTestStopped();
      if (typeof path !== "string" || !path || path.length > 256)
        throw new Error("Choose a serial port");
      await this.close();
      this.ensureCurrent(generation);
      const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      this.port = port;
      port.on("data", (data) => {
        if (this.port === port) this.receive(data);
      });
      port.on("error", (error) => {
        if (this.port === port) {
          this.fail(error);
          this.emit("log", error.message);
        }
      });
      port.on("close", () => {
        if (this.port === port) {
          this.port = undefined;
          this.hello = undefined;
          this.outputTestRequested = false;
          this.fail(new Error("USB connection closed"));
          this.emit("status", { connected: false });
        }
      });
      try {
        await new Promise<void>((resolve, reject) =>
          port.open((error) => (error ? reject(error) : resolve())),
        );
        this.ensureCurrent(generation);
        // Opening an AVR USB serial connection normally resets its bootloader.
        await new Promise((resolve) => setTimeout(resolve, 1800));
        this.ensureCurrent(generation);
        const hello = await this.request("HELLO", 3500);
        this.ensureCurrent(generation);
        if (hello.type !== "hello" || hello.protocol !== 1)
          throw new Error(
            "Install Cheap Prop Controller firmware before connecting",
          );
        this.hello = hello;
        this.emit("status", this.getDeviceStatus());
        return hello;
      } catch (error) {
        // An opening port may complete after disconnect. Close that old handle,
        // and never let an obsolete connection close a newer session's port.
        if (generation !== this.generation) await this.controlTail;
        if (this.port === port) await this.close();
        else if (port.isOpen)
          await new Promise<void>((resolve) => port.close(() => resolve()));
        throw new Error(
          `Connection failed: ${error instanceof Error ? error.message : error}. Use Install firmware if this board still has OctoBanger.`,
        );
      }
    });
  }
  private request(
    command: string,
    timeout = 2500,
    ignoreUnscopedErrors = false,
  ): Promise<DeviceReply> {
    const port = this.port;
    if (!port?.isOpen)
      return Promise.reject(new Error("Connect to a controller first"));
    if (this.waiter)
      return Promise.reject(
        new Error("A controller request is already pending"),
      );
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        command: command.split(" ")[0],
        resolve,
        reject,
        ignoreUnscopedErrors,
        timer: setTimeout(() => {
          if (this.waiter !== waiter) return;
          this.waiter = undefined;
          reject(new Error(`Controller did not respond to ${waiter.command}`));
        }, timeout),
      };
      this.waiter = waiter;
      port.write(`${command}\n`, (error) => {
        if (error && this.waiter === waiter) this.fail(error);
      });
    });
  }
  command(command: string): Promise<DeviceReply> {
    if (!/^(HELLO|STATUS|RESET|STOP|RUN|TRIGGER [0-7])$/.test(command))
      return Promise.reject(new Error("Unsupported controller command"));
    // An abandoned DATA/STATUS reply can arrive first. It cannot satisfy STOP;
    // old firmware error frames lack command IDs, so wait for STOP's own ACK.
    if (command === "STOP") {
      this.outputTestRequested = false;
      return this.priority(() => this.request("STOP", 2500, true));
    }
    return this.exclusive(() => {
      if (command !== "HELLO" && command !== "STATUS")
        this.requireOutputTestStopped();
      return this.request(command);
    });
  }
  cancelIr(): Promise<DeviceReply> {
    return this.command("STOP");
  }
  beginOutputTest(expectedScene: number[]): Promise<DeviceReply> {
    return this.exclusive(async (generation) => {
      this.requireOutputTestStopped();
      if (
        !Array.isArray(expectedScene) ||
        expectedScene.length < 32 ||
        expectedScene.length > 4096 ||
        expectedScene.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255,
        )
      )
        throw new Error("Invalid compiled scene");
      const bytes = Buffer.from(expectedScene);
      if (
        !/^CPC[12]$/.test(bytes.toString("ascii", 0, 4)) ||
        bytes.readUInt16LE(4) !== bytes.length ||
        !verifySceneChecksum(bytes)
      )
        throw new Error("Invalid compiled scene");
      const hello = await this.request("HELLO");
      this.ensureCurrent(generation);
      if (hello.protocol !== 1 || hello.outputTest !== true)
        throw new Error(
          "Install the updated firmware to test individual outputs.",
        );
      const boardIds: Record<string, number> = {
        uno: 1,
        nano: 2,
        "pro-mini": 3,
        mega: 4,
      };
      if (boardIds[String(hello.board)] !== bytes[8])
        throw new Error("Project board does not match connected firmware.");
      try {
        this.outputTestRequested = true;
        const result = await this.request(
          `TESTBEGIN ${bytes.length} ${bytes.readUInt16LE(6)}`,
        );
        this.ensureCurrent(generation);
        return result;
      } catch (error) {
        // Firmware checks scene identity before stopping anything. An explicit
        // refusal leaves that running scene intact; only an uncertain outcome
        // needs STOP in case TESTBEGIN reached the controller without its ACK.
        if (!(error instanceof ControllerRejectionError))
          await this.cleanupIr(generation);
        if (generation === this.generation) this.outputTestRequested = false;
        throw error;
      }
    });
  }
  setTestOutputs(mask: number): Promise<DeviceReply> {
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)
      return Promise.reject(new Error("Invalid output test control"));
    return this.exclusive(() => this.request(`TEST ${mask}`));
  }
  endOutputTest(): Promise<DeviceReply> {
    return this.command("STOP");
  }
  private async requireIrCapability(
    capability: "irLearning" | "irReplay",
    generation: number,
  ): Promise<void> {
    const hello = await this.request("HELLO");
    this.ensureCurrent(generation);
    if (hello.protocol !== 1 || hello[capability] !== true)
      throw new Error(
        "Install the updated firmware to learn and send IR commands. The saved controller scene has not been changed.",
      );
  }
  private async cleanupIr(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      await this.request("STOP", 2500, true);
    } catch {
      // Preserve the original error; STOP/disconnect cancellation owns cleanup
      // when a newer generation has already taken over this serial connection.
    }
  }
  learnIr(): Promise<IrSignal> {
    return this.exclusive(async (generation) => {
      this.requireOutputTestStopped();
      await this.requireIrCapability("irLearning", generation);
      try {
        const capture = await this.request("IRLEARN", 16000);
        this.ensureCurrent(generation);
        if (!Array.isArray(capture.pulsesUs))
          throw new Error("Controller returned an invalid IR capture");
        const signal = learnIrSignal(capture.pulsesUs);
        if (!validateIrSignal(signal))
          throw new Error("Controller returned an invalid IR capture");
        return signal;
      } catch (error) {
        await this.cleanupIr(generation);
        throw error;
      }
    });
  }
  testIr(command: IrCommand): Promise<DeviceReply> {
    return this.exclusive(async (generation) => {
      this.requireOutputTestStopped();
      if (!validateIrCommand(command)) throw new Error("Invalid IR command");
      const signal = command.signal;
      let payload = Buffer.alloc(0);
      if (signal.kind === "raw") {
        payload = Buffer.from(signal.pulsesUs.map((pulse) => pulse / 50));
      }
      await this.requireIrCapability("irReplay", generation);
      try {
        await this.request(
          `IRBEGIN ${signal.kind === "nec" ? 0 : 1} ${signal.kind === "raw" ? signal.pulsesUs.length : 0} ${command.sendCount} ${command.gapMs} ${signal.kind === "nec" ? signal.code : 0}`,
        );
        this.ensureCurrent(generation);
        for (let offset = 0; offset < payload.length; offset += 32) {
          const acknowledgement = await this.request(
            `IRDATA ${offset} ${payload.subarray(offset, offset + 32).toString("hex")}`,
          );
          this.ensureCurrent(generation);
          if (acknowledgement.offset !== Math.min(offset + 32, payload.length))
            throw new Error(
              "Controller acknowledged an unexpected IR data offset",
            );
        }
        const result = await this.request("IRPLAY");
        this.ensureCurrent(generation);
        return result;
      } catch (error) {
        await this.cleanupIr(generation);
        throw error;
      }
    });
  }
  upload(values: number[]): Promise<DeviceReply> {
    return this.exclusive(async (generation) => {
      this.requireOutputTestStopped();
      if (
        !Array.isArray(values) ||
        values.length < 32 ||
        values.length > 4096 ||
        values.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255,
        )
      )
        throw new Error("Invalid compiled scene");
      const bytes = Buffer.from(values);
      if (
        !/^CPC[12]$/.test(bytes.toString("ascii", 0, 4)) ||
        bytes.readUInt16LE(4) !== bytes.length
      )
        throw new Error("Invalid scene image header");
      if (!verifySceneChecksum(bytes))
        throw new Error("Scene checksum is invalid");
      const hello = await this.request("HELLO");
      this.ensureCurrent(generation);
      if (hello.type !== "hello" || hello.protocol !== 1)
        throw new Error("Incompatible controller firmware");
      if (bytes[3] === 0x32 && hello.sceneControls !== true)
        throw new Error(
          "Install the updated firmware to use advanced scene controls. The saved controller scene has not been changed.",
        );
      const boardIds: Record<string, number> = {
        uno: 1,
        nano: 2,
        "pro-mini": 3,
        mega: 4,
      };
      if (boardIds[String(hello.board)] !== bytes[8])
        throw new Error(
          "Project board does not match connected firmware. Select the matching board or install its firmware.",
        );
      if (
        !Number.isInteger(hello.capacity) ||
        Number(hello.capacity) < 32 ||
        Number(hello.capacity) > 4096
      )
        throw new Error("Controller reported an invalid storage capacity");
      if (bytes.length > Number(hello.capacity))
        throw new Error("Scene exceeds controller storage");
      if ((bytes[16] & 2) !== 0 && hello.audioFadeThrough !== true)
        throw new Error(
          "Install the updated firmware to use fade out / fade in. The saved controller scene has not been changed.",
        );
      if ((bytes[16] & 0x7c) !== 0 && hello.audioAmbientMix !== true)
        throw new Error(
          "Install the updated firmware to mix ambient with foreground audio. The saved controller scene has not been changed.",
        );
      if ((bytes[16] & 0x80) !== 0) {
        const extensionVersion = bytes[bytes.length - 6];
        const zoneCount = bytes[bytes.length - 5];
        if (
          bytes.length < 40 ||
          bytes[bytes.length - 8] !== 0x5a ||
          bytes[bytes.length - 7] !== 0x4e ||
          (extensionVersion !== 1 && extensionVersion !== 2) ||
          (extensionVersion === 2 && bytes.length < 48)
        )
          throw new Error("Unsupported scene extension");
        if (extensionVersion === 2 && hello.irReplay !== true)
          throw new Error(
            "Install the updated firmware to use IR commands. The saved controller scene has not been changed.",
          );
        if (zoneCount > 0 && hello.distanceZones !== true)
          throw new Error(
            "Install the updated firmware to use ultrasonic distance zones. The saved controller scene has not been changed.",
          );
      }
      await this.request(`BEGIN ${bytes.length} ${bytes.readUInt16LE(6)}`);
      try {
        for (let offset = 0; offset < bytes.length; offset += 32) {
          this.ensureCurrent(generation);
          const acknowledgement = await this.request(
            `DATA ${offset} ${bytes.subarray(offset, offset + 32).toString("hex")}`,
            4000,
          );
          this.ensureCurrent(generation);
          if (acknowledgement.offset !== Math.min(offset + 32, bytes.length))
            throw new Error(
              "Controller acknowledged an unexpected upload offset",
            );
          this.emit(
            "log",
            `Upload ${Math.min(offset + 32, bytes.length)} / ${bytes.length} bytes`,
          );
        }
        this.ensureCurrent(generation);
        const result = await this.request("COMMIT", 4000);
        this.ensureCurrent(generation);
        this.emit("log", "Scene committed to onboard storage");
        return result;
      } catch (error) {
        if (generation === this.generation) {
          try {
            await this.request("STOP");
          } catch {
            /* Preserve the original upload error. */
          }
        }
        throw error;
      }
    });
  }
}
