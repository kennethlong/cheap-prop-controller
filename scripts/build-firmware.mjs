import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
const local = path.join(
  process.cwd(),
  ".tools",
  "pio",
  process.platform === "win32" ? "Scripts/platformio.exe" : "bin/platformio",
);
let command = local;
try {
  await access(local);
} catch {
  command = "pio";
}
const child = spawn(
  command,
  [
    "run",
    "-d",
    "firmware",
    "-e",
    "uno",
    "-e",
    "nano",
    "-e",
    "mega",
    "-e",
    "promini",
  ],
  { stdio: "inherit", windowsHide: true },
);
child.on("error", (error) => {
  console.error(
    `Install PlatformIO before building firmware: ${error.message}`,
  );
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
