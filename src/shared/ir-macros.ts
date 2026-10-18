import { irCommandDurationMs, validateIrCommand } from "./ir";
import { LIMITS } from "./model";
import type {
  IrCommand,
  IrMacro,
  IrTimelineEvent,
  SceneProject,
  SceneState,
} from "./model";

export interface ExpandedIrEvent {
  id: string;
  atMs: number;
  commandId: string;
  sourceEventIndex: number;
  sourceStepIndex?: number;
}

/** Compile-time expansion only: firmware still receives ordinary timed commands.
 * Invalid targets throw rather than silently dropping an authored cue. Callers
 * executing a project must validate it first; editable drafts may be incomplete.
 */
export function expandIrEvents(
  project: SceneProject,
  state: SceneState,
): ExpandedIrEvent[] {
  const commands = new Set(project.ir?.commands.map((command) => command.id));
  const macros = new Map(project.ir?.macros?.map((macro) => [macro.id, macro]));
  const expanded: ExpandedIrEvent[] = [];
  const append = (event: ExpandedIrEvent) => {
    if (expanded.length >= LIMITS.irEvents)
      throw new Error(
        `At most ${LIMITS.irEvents} expanded IR commands are supported.`,
      );
    expanded.push(event);
  };
  (state.irEvents ?? []).forEach((event, sourceEventIndex) => {
    if ((event.commandId !== undefined) === (event.macroId !== undefined))
      throw new Error(
        "An IR timeline entry must select exactly one command or macro.",
      );
    if (event.commandId !== undefined) {
      if (!commands.has(event.commandId))
        throw new Error("IR command does not exist in the project library.");
      append({
        id: event.id,
        atMs: event.atMs,
        commandId: event.commandId,
        sourceEventIndex,
      });
      return;
    }
    const macro = macros.get(event.macroId!);
    if (!macro)
      throw new Error("IR macro does not exist in the project library.");
    if (!macro.steps.length)
      throw new Error("An IR macro needs at least one step.");
    macro.steps.forEach((step, sourceStepIndex) => {
      if (!commands.has(step.commandId))
        throw new Error(
          "IR macro step command does not exist in the project library.",
        );
      append({
        id: `${event.id}:${step.id}`,
        atMs: event.atMs + step.atMs,
        commandId: step.commandId,
        sourceEventIndex,
        sourceStepIndex,
      });
    });
  });
  return expanded.sort(
    (a, b) =>
      a.atMs - b.atMs ||
      a.sourceEventIndex - b.sourceEventIndex ||
      (a.sourceStepIndex ?? -1) - (b.sourceStepIndex ?? -1),
  );
}

export function irEventName(
  project: SceneProject,
  event: IrTimelineEvent,
): string {
  if (event.macroId !== undefined)
    return (
      project.ir?.macros?.find((macro) => macro.id === event.macroId)?.name ??
      "Missing IR macro"
    );
  return (
    project.ir?.commands.find((command) => command.id === event.commandId)
      ?.name ?? "Missing IR command"
  );
}

/** Approximate end including repeated presses, quiet gaps, and waiting for
 * earlier macro steps to finish on the shared transmitter.
 */
export function irMacroDurationMs(
  macro: IrMacro,
  commands: IrCommand[],
): number {
  return [...macro.steps]
    .sort((a, b) => a.atMs - b.atMs)
    .reduce((end, step) => {
      const command = commands.find(
        (candidate) => candidate.id === step.commandId,
      );
      return (
        Math.max(end, step.atMs) +
        (command && validateIrCommand(command)
          ? irCommandDurationMs(command)
          : 0)
      );
    }, 0);
}
