import { build } from "esbuild";
await build({
  entryPoints: ["scripts/compile-fixtures.ts"],
  outfile: "artifacts/compile-fixtures.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
await import("../artifacts/compile-fixtures.mjs");
