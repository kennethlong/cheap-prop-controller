import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { BoardId } from "../shared/model";

export async function flashFirmware(
  root: string,
  board: BoardId,
  port: string,
  variant = "default",
  log: (line: string) => void = () => {},
): Promise<{ success: boolean; log: string }> {
  const profiles: Record<
    BoardId,
    { chip: string; programmer: string; baud: string; file: string }
  > = {
    uno: {
      chip: "atmega328p",
      programmer: "arduino",
      baud: "115200",
      file: "uno.hex",
    },
    nano: {
      chip: "atmega328p",
      programmer: "arduino",
      baud: variant === "old-bootloader" ? "57600" : "115200",
      file: "nano.hex",
    },
    "pro-mini": {
      chip: "atmega328p",
      programmer: "arduino",
      baud: "57600",
      file: "pro-mini.hex",
    },
    mega: {
      chip: "atmega2560",
      programmer: "wiring",
      baud: "115200",
      file: "mega.hex",
    },
  };
  const profile = profiles[board];
  if (!profile || typeof port !== "string" || !port || port.startsWith("-"))
    throw new Error("Invalid board or serial port");
  const binary = path.join(
    root,
    "avrdude",
    process.platform === "win32" ? "avrdude.exe" : "avrdude",
  );
  const config = path.join(root, "avrdude", "avrdude.conf");
  const firmware = path.join(root, "firmware", profile.file);
  try {
    await Promise.all([access(binary), access(config), access(firmware)]);
  } catch {
    throw new Error(
      "Firmware tools are not bundled for this platform. Run the firmware build and resource preparation scripts first.",
    );
  }
  const args = [
    "-C",
    config,
    "-p",
    profile.chip,
    "-c",
    profile.programmer,
    "-P",
    port,
    "-b",
    profile.baud,
    "-D",
    "-U",
    `flash:w:${firmware}:i`,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      cwd: path.dirname(binary),
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      const value = chunk.toString();
      output = (output + value).slice(-120000);
      log(value);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut,
        log: timedOut ? `${output}\nUploader timed out` : output,
      });
    });
  });
}
