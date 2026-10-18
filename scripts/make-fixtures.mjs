import { build } from "esbuild";
await build({
  entryPoints: ["scripts/compile-fixtures.ts"],
  outfile: "artifacts/compile-fixtures.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
await import("../artifacts/compile-fixtures.mjs");
await build({
  stdin: {
    contents: `
      import { writeFile } from "node:fs/promises";
      import { compileProject } from "./src/shared/index";
      import { parallelChildrenProject } from "./tests/core/parallel-children-fixture";
      const project = parallelChildrenProject();
      const compiled = compileProject(project);
      if (!compiled.bytes.length) throw new Error(JSON.stringify(compiled.issues));
      await writeFile("artifacts/scenes/parallel-children.bin", compiled.bytes);
      if (process.argv.includes("--golden"))
        await writeFile("tests/core/parallel-children-scene.bin", compiled.bytes);
    `,
    resolveDir: process.cwd(),
  },
  outfile: "artifacts/compile-parallel-children.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
});
await import("../artifacts/compile-parallel-children.mjs");
await import("./compile-standard-harness-fixtures.mjs");
