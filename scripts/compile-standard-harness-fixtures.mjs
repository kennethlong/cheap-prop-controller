import { build } from "esbuild";

await build({
  stdin: {
    contents: `
      import { mkdir, writeFile } from "node:fs/promises";
      import { compileProject } from "./src/shared/index";
      import { standardHarnessProject } from "./tests/core/standard-harness-fixture";
      await mkdir("artifacts/scenes", { recursive: true });
      for (const variant of ["full", "sparse", "inactive"]) {
        const project = standardHarnessProject(variant);
        const compiled = compileProject(project);
        if (!compiled.bytes.length) throw new Error(JSON.stringify(compiled.issues));
        await writeFile("artifacts/scenes/standard-harness-" + variant + ".bin", compiled.bytes);
        if (process.argv.includes("--golden"))
          await writeFile("tests/core/standard-harness-" + variant + ".bin", compiled.bytes);
        console.log("Standard harness " + variant + ": " + compiled.usedBytes + " bytes");
      }
    `,
    resolveDir: process.cwd(),
  },
  outfile: "artifacts/compile-standard-harness.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
await import("../artifacts/compile-standard-harness.mjs");
