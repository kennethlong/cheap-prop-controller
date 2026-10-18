import type { SceneProject, StateTransition, TriggerConfig } from "./model";
import { usesParallelChildren } from "./parallel-children";

export function transitionTargets(transition: StateTransition): string[] {
  return [transition.targetStateId, ...(transition.alternateStateIds ?? [])];
}

export function timerInterval(trigger: TriggerConfig): number {
  return trigger.timerIntervalMs ?? 30000;
}

/** CPC1 images remain byte-for-byte unchanged until a new control is used. */
export function usesSceneControls(project: SceneProject): boolean {
  return (
    usesParallelChildren(project) ||
    project.triggers.some(
      (trigger) => trigger.kind === "timer" || trigger.kind === "manual",
    ) ||
    project.audio.players.some((player) => player.feedback !== undefined) ||
    project.states.some(
      (state) =>
        !!state.audioEndStateId ||
        state.events.some((event) => event.active === false) ||
        state.transitions.some(
          (transition) =>
            transition.edge === "release" ||
            !!transition.alternateStateIds?.length,
        ),
    )
  );
}
