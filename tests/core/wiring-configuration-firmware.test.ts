import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileProject, toRuntimeProject } from "../../src/shared";
import { dualBeamConfigurationProject } from "./wiring-configuration-fixture";

it("matches the dual-beam scene exercised by the real firmware host harness", () => {
  const project = dualBeamConfigurationProject();
  const compiled = compileProject(project);
  expect(compiled.issues.filter((issue) => issue.severity === "error")).toEqual(
    [],
  );
  expect(Buffer.from(compiled.bytes)).toEqual(
    readFileSync("tests/core/fixed-dual-beam.bin"),
  );
  const runtime = toRuntimeProject(project);
  expect(
    runtime.triggers
      .filter((trigger) => trigger.kind === "button")
      .map((trigger) => trigger.pin),
  ).toEqual([10, 19]);
});
