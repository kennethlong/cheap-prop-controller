import { build } from "esbuild";

await build({
  stdin: {
    contents: `
      import { mkdir, writeFile } from "node:fs/promises";
      import { compileProject } from "./src/shared/index";
      import { dualBeamConfigurationProject } from "./tests/core/wiring-configuration-fixture";
      await mkdir("artifacts/scenes", { recursive: true });
      const compiled = compileProject(dualBeamConfigurationProject());
      if (!compiled.bytes.length) throw new Error(JSON.stringify(compiled.issues));
      await writeFile("artifacts/scenes/fixed-dual-beam.bin", compiled.bytes);
      if (process.argv.includes("--golden"))
        await writeFile("tests/core/fixed-dual-beam.bin", compiled.bytes);
      console.log("Fixed dual beam: " + compiled.usedBytes + " bytes");
    `,
    resolveDir: process.cwd(),
  },
  outfile: "artifacts/compile-wiring-configurations.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
await import("../artifacts/compile-wiring-configurations.mjs");
