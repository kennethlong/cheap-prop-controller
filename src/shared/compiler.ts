import { BOARD_PROFILES } from "./boards";
import {
  resolveAmbientMixVolume,
  resolveAudioTransition,
} from "./audio-settings";
import type { BoardId, SceneProject, ValidationIssue } from "./model";
import { isZonedTrigger } from "./model";
import {
  estimateSceneBytes,
  validateProject,
  validateProjectStructure,
} from "./validation";

export const BINARY = {
  header: 32,
  output: 2,
  trigger: 8,
  player: 4,
  state: 16,
  event: 6,
  transition: 2,
  zone: 10,
  zoneAction: 6,
  zoneFooter: 8,
} as const;
export const BOARD_CODES: Record<BoardId, number> = {
  uno: 1,
  nano: 2,
  "pro-mini": 3,
  mega: 4,
};
export interface CompiledScene {
  bytes: Uint8Array;
  usedBytes: number;
  capacityBytes: number;
  issues: ValidationIssue[];
}

/** Standard CCITT-FALSE. The scene-image checksum treats its checksum field as zero. */
export function crc16(data: Uint8Array, zeroChecksumField = false): number {
  let crc = 0xffff;
  for (let index = 0; index < data.length; index++) {
    const byte =
      zeroChecksumField && (index === 6 || index === 7) ? 0 : data[index];
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function compileProject(project: SceneProject): CompiledScene {
  const structure = validateProjectStructure(project);
  if (structure.length)
    return {
      bytes: new Uint8Array(),
      usedBytes: 0,
      capacityBytes: 0,
      issues: structure,
    };
  const usedBytes = estimateSceneBytes(project);
  const capacityBytes = BOARD_PROFILES[project.board].eepromBytes;
  const issues = validateProject(project);
  if (issues.some((issue) => issue.severity === "error"))
    return { bytes: new Uint8Array(), usedBytes, capacityBytes, issues };
  const bytes = new Uint8Array(usedBytes);
  const view = new DataView(bytes.buffer);
  const u16 = (offset: number, value: number) =>
    view.setUint16(offset, value, true);
  const outputOffset = BINARY.header;
  const triggerOffset = outputOffset + project.outputs.length * BINARY.output;
  const playerOffset = triggerOffset + project.triggers.length * BINARY.trigger;
  const stateOffset =
    playerOffset + project.audio.players.length * BINARY.player;
  const eventOffset = stateOffset + project.states.length * BINARY.state;
  const eventCount = project.states.reduce(
    (sum, state) => sum + state.events.length,
    0,
  );
  const transitionOffset = eventOffset + eventCount * BINARY.event;
  const zones = project.triggers.flatMap((trigger, triggerIndex) =>
    isZonedTrigger(trigger)
      ? (trigger.zones ?? []).map((zone) => ({ triggerIndex, zone }))
      : [],
  );
  bytes.set([0x43, 0x50, 0x43, 0x31]);
  u16(4, usedBytes);
  bytes[8] = BOARD_CODES[project.board];
  bytes[9] = project.outputs.length;
  bytes[10] = project.triggers.length;
  bytes[11] = project.audio.players.length;
  bytes[12] = project.states.length;
  bytes[13] = project.states.findIndex(
    (state) => state.id === project.initialStateId,
  );
  u16(14, project.audio.ambientTrack ?? 0);
  const transition = resolveAudioTransition(project.audio);
  const sequential = transition.mode === "fade-through";
  bytes[16] =
    (project.audio.keepAmbient ? 1 : 0) |
    (sequential ? 2 : 0) |
    (resolveAmbientMixVolume(project.audio) << 2) |
    (zones.length ? 0x80 : 0);
  bytes[17] = (sequential ? transition.fadeInMs : transition.crossfadeMs) / 50;
  bytes[18] = project.audio.ambientVolume;
  bytes[19] = sequential ? transition.fadeOutMs / 50 : 0;
  u16(20, outputOffset);
  u16(22, triggerOffset);
  u16(24, playerOffset);
  u16(26, stateOffset);
  u16(28, eventOffset);
  u16(30, transitionOffset);
  project.outputs.forEach((output, index) => {
    const offset = outputOffset + index * BINARY.output;
    bytes[offset] = output.pin!;
    bytes[offset + 1] =
      (output.activeLow ? 1 : 0) | (output.idleActive ? 2 : 0);
  });
  project.triggers.forEach((trigger, index) => {
    const offset = triggerOffset + index * BINARY.trigger;
    bytes[offset] = ({ button: 0, pir: 1, ultrasonic: 2 } as const)[
      trigger.kind
    ];
    bytes[offset + 1] = trigger.pin!;
    bytes[offset + 2] = trigger.echoPin ?? 255;
    bytes[offset + 3] = (trigger.activeLow ? 1 : 0) | (trigger.pullup ? 2 : 0);
    u16(offset + 4, trigger.thresholdCm);
    bytes[offset + 6] = trigger.hysteresisCm;
    bytes[offset + 7] = trigger.debounceMs / 50;
  });
  project.audio.players.forEach((player, index) => {
    const offset = playerOffset + index * BINARY.player;
    bytes[offset] = player.kind === "dfplayer" ? 0 : 1;
    bytes[offset + 1] = player.txPin!;
    bytes[offset + 2] = player.rxPin!;
  });
  let eventIndex = 0;
  let transitionIndex = 0;
  project.states.forEach((state, index) => {
    const offset = stateOffset + index * BINARY.state;
    u16(offset, state.durationMs / 50);
    u16(offset + 2, state.foregroundTrack ?? 0);
    u16(offset + 4, eventIndex);
    u16(offset + 6, state.events.length);
    u16(offset + 8, transitionIndex);
    bytes[offset + 10] = state.transitions.length;
    bytes[offset + 11] = state.volume;
    bytes[offset + 12] =
      (state.loopTimeline ? 1 : 0) | (state.loopAudio ? 2 : 0);
    const sortedEvents = [...state.events].sort(
      (a, b) =>
        a.startMs - b.startMs ||
        project.outputs.findIndex((output) => output.id === a.outputId) -
          project.outputs.findIndex((output) => output.id === b.outputId),
    );
    sortedEvents.forEach((event) => {
      const eventRecord = eventOffset + eventIndex++ * BINARY.event;
      u16(eventRecord, event.startMs / 50);
      u16(eventRecord + 2, event.endMs / 50);
      bytes[eventRecord + 4] = project.outputs.findIndex(
        (output) => output.id === event.outputId,
      );
    });
    state.transitions.forEach((transition) => {
      const transitionRecord =
        transitionOffset + transitionIndex++ * BINARY.transition;
      bytes[transitionRecord] = project.triggers.findIndex(
        (trigger) => trigger.id === transition.triggerId,
      );
      bytes[transitionRecord + 1] = project.states.findIndex(
        (target) => target.id === transition.targetStateId,
      );
    });
  });
  if (zones.length) {
    const zoneOffset = transitionOffset + transitionIndex * BINARY.transition;
    const actionOffset = zoneOffset + zones.length * BINARY.zone;
    let actionIndex = 0;
    zones.forEach(({ triggerIndex, zone }, zoneIndex) => {
      const offset = zoneOffset + zoneIndex * BINARY.zone;
      bytes[offset] = triggerIndex;
      u16(offset + 1, zone.minCm);
      u16(offset + 3, zone.maxCm);
      bytes[offset + 5] = zone.hysteresisCm;
      for (const [edgeIndex, edge] of (
        ["onEnter", "onExit"] as const
      ).entries()) {
        bytes[offset + 6 + edgeIndex * 2] = actionIndex;
        bytes[offset + 7 + edgeIndex * 2] = zone[edge].length;
        for (const action of zone[edge]) {
          const record = actionOffset + actionIndex++ * BINARY.zoneAction;
          bytes[record] = action.kind === "state" ? 0 : 1;
          if (action.kind === "state") {
            bytes[record + 1] = project.states.findIndex(
              (state) => state.id === action.stateId,
            );
          } else {
            bytes[record + 1] = action.target === "ambient" ? 0 : 1;
            u16(record + 2, action.volume);
            u16(record + 4, action.fadeMs / 50);
          }
        }
      }
    });
    const footer = usedBytes - BINARY.zoneFooter;
    bytes.set([0x5a, 0x4e, 1, zones.length], footer);
    u16(footer + 4, actionIndex);
    u16(footer + 6, zoneOffset);
  }
  u16(6, crc16(bytes, true));
  return { bytes, usedBytes, capacityBytes, issues };
}

/** Basic envelope check; firmware additionally validates every record before execution. */
export function verifySceneChecksum(bytes: Uint8Array): boolean {
  if (
    bytes.length < BINARY.header ||
    bytes[0] !== 0x43 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x43 ||
    bytes[3] !== 0x31
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint16(4, true) === bytes.length &&
    view.getUint16(6, true) === crc16(bytes, true)
  );
}
