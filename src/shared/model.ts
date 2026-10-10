export type BoardId = "uno" | "nano" | "pro-mini" | "mega";
export type WiringPreset = "custom" | "relay-shield";
export type TriggerKind = "button" | "pir" | "ultrasonic";
export type PlayerKind = "dfplayer" | "yx5300";
export type AudioTransitionMode = "cut" | "crossfade" | "fade-through";

export interface OutputConfig {
  id: string;
  name: string;
  pin: number | null;
  activeLow: boolean;
  idleActive: boolean;
  color: string;
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
}
export interface AudioPlayer {
  id: string;
  kind: PlayerKind;
  txPin: number | null;
  rxPin: number | null;
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
}
export interface StateTransition {
  triggerId: string;
  targetStateId: string;
}
export interface SceneState {
  id: string;
  name: string;
  durationMs: number;
  loopTimeline: boolean;
  foregroundTrack: number | null;
  volume: number;
  loopAudio: boolean;
  events: TimelineEvent[];
  transitions: StateTransition[];
}
export interface SceneProject {
  version: 1;
  name: string;
  board: BoardId;
  wiring: WiringPreset;
  initialStateId: string;
  outputs: OutputConfig[];
  triggers: TriggerConfig[];
  audio: {
    players: AudioPlayer[];
    ambientTrack: number | null;
    ambientVolume: number;
    keepAmbient: boolean;
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
} as const;

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
