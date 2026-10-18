import {
  applyWiringConfiguration,
  BUILT_IN_WIRING_CONFIGURATIONS,
  type SceneProject,
} from "../../src/shared";
import { standardHarnessProject } from "./standard-harness-fixture";

/** Host-only scene: both physical beam contacts run the same parallel pulse. */
export function dualBeamConfigurationProject(): SceneProject {
  const configuration = BUILT_IN_WIRING_CONFIGURATIONS.find(
    (item) => item.id === "uno-dual-beam",
  )!;
  const project = applyWiringConfiguration(
    standardHarnessProject("sparse"),
    configuration,
  );
  project.name = "Fixed dual-beam host fixture";
  const secondBeam = project.triggers.find((trigger) => trigger.pin === 19)!;
  secondBeam.enabled = true;
  secondBeam.debounceMs = 0;
  for (const state of project.states)
    if (state.kind !== "child")
      state.transitions.push({
        triggerId: secondBeam.id,
        targetStateId: "child",
      });
  return project;
}
