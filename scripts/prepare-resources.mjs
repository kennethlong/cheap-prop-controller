import { cp, mkdir, access, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
await import("./prepare-audio-resources.mjs");
const root = process.cwd();
const profiles = {
  uno: "uno",
  nano: "nano",
  mega: "mega",
  "pro-mini": "promini",
};
await mkdir(path.join(root, "resources", "firmware"), { recursive: true });
for (const [name, environment] of Object.entries(profiles)) {
  const source = path.join(
    root,
    "firmware",
    ".pio",
    "build",
    environment,
    "firmware.hex",
  );
  await access(source);
  await copyFile(
    source,
    path.join(root, "resources", "firmware", `${name}.hex`),
  );
}
const pioHome =
  process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), ".platformio");
const uploader = path.join(pioHome, "packages", "tool-avrdude");
const destination = path.join(root, "resources", "avrdude");
await cp(uploader, destination, { recursive: true });
// PlatformIO distributes Unix tools under bin/ and etc/; Windows uses the root.
const executable = process.platform === "win32" ? "avrdude.exe" : "avrdude";
try {
  await access(path.join(destination, executable));
} catch {
  await copyFile(
    path.join(uploader, "bin", executable),
    path.join(destination, executable),
  );
}
try {
  await access(path.join(destination, "avrdude.conf"));
} catch {
  await copyFile(
    path.join(uploader, "etc", "avrdude.conf"),
    path.join(destination, "avrdude.conf"),
  );
}
console.log("Firmware, uploader, and audio encoder prepared in resources/.");
