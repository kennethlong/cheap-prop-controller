import {
  childOutputOwners,
  isChildState,
  type SceneProject,
  type SceneState,
} from "../shared";

/** Explain why a lane cannot be assigned to this timeline. */
export function outputUnavailableReason(
  project: SceneProject,
  state: SceneState,
  outputId: string,
): string | undefined {
  if (
    project.outputs.find((output) => output.id === outputId)?.enabled === false
  )
    return "Disabled in Hardware; events are retained but will not run";
  const owner = childOutputOwners(project).get(outputId);
  if (owner && owner.id !== state.id)
    return `Reserved for child: ${owner.name}`;
  if (isChildState(state)) {
    if (project.outputs.find((output) => output.id === outputId)?.idleActive)
      return "Child outputs must be off at idle";
    const main = project.states.find(
      (item) =>
        !isChildState(item) &&
        item.events.some((event) => event.outputId === outputId),
    );
    if (main) return `Used by main state: ${main.name}`;
  }
  return undefined;
}
