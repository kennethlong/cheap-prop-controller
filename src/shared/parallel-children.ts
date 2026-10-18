import type { SceneProject, SceneState } from "./model";

export function isChildState(state: SceneState): boolean {
  return state.kind === "child";
}

export function usesParallelChildren(project: SceneProject): boolean {
  return project.states.some(isChildState);
}

/** Child event channels are reserved globally; validation reports conflicting owners. */
export function childOutputOwners(
  project: SceneProject,
): Map<string, SceneState> {
  const owners = new Map<string, SceneState>();
  for (const state of project.states.filter(isChildState))
    for (const event of state.events)
      if (!owners.has(event.outputId)) owners.set(event.outputId, state);
  return owners;
}
