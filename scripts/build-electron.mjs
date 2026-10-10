import { build } from "esbuild";
await import("./prepare-audio-resources.mjs");
await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "serialport"],
});
await build({
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
