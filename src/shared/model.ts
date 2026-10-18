export type BoardId = "uno" | "nano" | "pro-mini" | "mega";
export type WiringPreset = "custom" | "relay-shield" | "standard-uno" | "fixed";
export type StandardOutputSlot =
  "relay-1" | "relay-2" | "relay-3" | "relay-4" | "dc-ssr" | "ac-ssr" | "spare";
export type StandardTriggerSlot =
  | "beam"
  | "primary-pir"
  | "primary-ultrasonic"
  | "backup-pir"
  | "backup-ultrasonic";
export type TriggerKind = "button" | "pir" | "ultrasonic" | "timer" | "manual";
export type PlayerKind = "dfplayer" | "yx5300";
export type AudioTransitionMode = "cut" | "crossfade" | "fade-through";

/** NEC stores the complete 32-bit frame, least-significant bit transmitted first. */
export type IrSignal =
  { kind: "nec"; code: number } | { kind: "raw"; pulsesUs: number[] };
export interface IrCommand {
  id: string;
  name: string;
  signal: IrSignal;
  /** Complete button presses, not a protocol-specific held-button repeat. */
  sendCount: number;
  gapMs: number;
}
export interface IrMacroStep {
  id: string;
  /** Offset from the timeline entry, aligned to a scene tick. */
  atMs: number;
  commandId: string;
}
export interface IrMacro {
  id: string;
  name: string;
  steps: IrMacroStep[];
}
export interface IrConfig {
  enabled: boolean;
  txPin: number | null;
  rxPin: number | null;
  commands: IrCommand[];
  macros?: IrMacro[];
}
export interface IrTimelineEvent {
  id: string;
  atMs: number;
  /** Exactly one target: a learned command or a reusable macro. */
  commandId?: string;
  macroId?: string;
}

export type ZoneAction =
  | { id: string; kind: "state"; stateId: string }
  | { id: string; kind: "ir"; commandId: string }
  | {
      id: string;
      kind: "volume";
      target: "ambient" | "foreground";
      volume: number;
      fadeMs: number;
    };
export interface DistanceZone {
  id: string;
  name: string;
  /** Inclusive whole-centimeter bounds within the HC-SR04 measurement range. */
  minCm: number;
  maxCm: number;
  hysteresisCm: number;
  onEnter: ZoneAction[];
  onExit: ZoneAction[];
}

export interface OutputConfig {
  id: string;
  name: string;
  pin: number | null;
  activeLow: boolean;
  idleActive: boolean;
  color: string;
  /** Omitted in older projects means enabled. Disabled devices stay editable. */
  enabled?: boolean;
  /** Physical connector identity, independent of array order and display name. */
  standardSlot?: StandardOutputSlot;
  /** Stable slot identity in a reusable wiring configuration. */
  configurationSlot?: string;
}
export interface TriggerConfig {
  id: string;
  name: string;
  kind: TriggerKind;
  pin: number | null;
  echoPin: number | null;
  activeLow: boolean;
  pullup: boolean;
  debounceMs: number;
  thresholdCm: number;
  hysteresisCm: number;
  /** Omitted in existing projects: use the original single threshold. */
  distanceMode?: "threshold" | "zones";
  zones?: DistanceZone[];
  /** Timer triggers use no GPIO and restart on RUN/RESET. */
  timerIntervalMs?: number;
  timerResetOnTrigger?: boolean;
  enabled?: boolean;
  standardSlot?: StandardTriggerSlot;
  configurationSlot?: string;
}
export interface AudioPlayer {
  id: string;
  kind: PlayerKind;
  txPin: number | null;
  rxPin: number | null;
  /** Optional active-low/high BUSY wire; not a UART acknowledgement. */
  feedback?: { pin: number | null; activeLow: boolean };
}
/** Hardware only: no media files, scene actions, or learned IR commands. */
export interface WiringConfiguration {
  version: 1;
  id: string;
  name: string;
  board: BoardId;
  outputs: OutputConfig[];
  triggers: TriggerConfig[];
  players: AudioPlayer[];
  ir?: Pick<IrConfig, "enabled" | "txPin" | "rxPin">;
}
export interface MediaTrack {
  number: number;
  name: string;
  path?: string;
  /** Project-local rendered copy of the applied trim; path stays the original. */
  trimmedPath?: string;
  /** Source duration for editing; exports verify the actual audio file. */
  durationMs?: number;
  /** Non-destructive source range. Omitted/null end means end of file. */
  trimStartMs?: number;
  trimEndMs?: number | null;
}
export interface TimelineEvent {
  id: string;
  outputId: string;
  startMs: number;
  endMs: number;
  /** Omitted means ON. OFF overrides idleActive for this interval. */
  active?: boolean;
}
export interface StateTransition {
  triggerId: string;
  targetStateId: string;
  edge?: "activate" | "release";
  /** Additional destinations, cycled after targetStateId; resets on RUN/RESET. */
  alternateStateIds?: string[];
}
export interface SceneState {
  id: string;
  name: string;
  /** Omitted in existing projects means a main scene state. */
  kind?: "main" | "child";
  /** Child rearm delay after its one-shot timeline finishes. */
  cooldownMs?: number;
  durationMs: number;
  loopTimeline: boolean;
  foregroundTrack: number | null;
  volume: number;
  loopAudio: boolean;
  events: TimelineEvent[];
  irEvents?: IrTimelineEvent[];
  transitions: StateTransition[];
  /** Optional transition after confirmed nonlooping foreground completion. */
  audioEndStateId?: string | null;
}
export interface SceneProject {
  version: 1;
  name: string;
  board: BoardId;
  wiring: WiringPreset;
  wiringConfiguration?: { id: string; name: string };
  initialStateId: string;
  outputs: OutputConfig[];
  triggers: TriggerConfig[];
  ir?: IrConfig;
  audio: {
    players: AudioPlayer[];
    ambientTrack: number | null;
    ambientVolume: number;
    keepAmbient: boolean;
    /** Level under foreground audio when retained; omitted/zero keeps it silent. */
    ambientMixVolume?: number;
    fadeMs: number;
    /** Omitted in older projects: infer crossfade/cut from fadeMs. */
    transitionMode?: AudioTransitionMode;
    fadeOutMs?: number;
    fadeInMs?: number;
    tracks: MediaTrack[];
  };
  states: SceneState[];
}

export const LIMITS = {
  outputs: 32,
  triggers: 8,
  states: 8,
  players: 3,
  tickMs: 50,
  maxDurationMs: 65535 * 50,
  maxTrack: 255,
  zones: 32,
  zoneActions: 64,
  irCommands: 32,
  irMacros: 32,
  irMacroSteps: 32,
  irEvents: 128,
  irPulses: 127,
  expandedTransitions: 128,
} as const;

export function isZonedTrigger(trigger: TriggerConfig): boolean {
  return trigger.kind === "ultrasonic" && trigger.distanceMode === "zones";
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}
export interface BoardProfile {
  id: BoardId;
  name: string;
  eepromBytes: number;
  digitalPins: number[];
  reservedPins: number[];
  uartPairs: Array<{ tx: number; rx: number }>;
}
