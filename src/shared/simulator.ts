import {
  isZonedTrigger,
  type SceneProject,
  type SceneState,
  type TriggerConfig,
  type ZoneAction,
} from "./model";
import { parseProject, validateProject } from "./validation";
import { toRuntimeProject } from "./standard-harness";
import { getMediaClip } from "./media-clip";
import { expandIrEvents } from "./ir-macros";
import { childOutputOwners, isChildState } from "./parallel-children";
import {
  resolveAmbientMixVolume,
  resolveAudioTransition,
} from "./audio-settings";

export interface AudioVoice {
  role: "ambient" | "foreground";
  track: number;
  volume: number;
  playerIndex: number;
  positionMs: number;
  loop: boolean;
}
/** Logical command invocation; desktop preview never transmits physical IR. */
export interface IrActivity {
  sequence: number;
  commandId: string;
  name: string;
  atMs: number;
  stateId: string;
  source: "timeline" | "zone";
}
export interface SimulatorSnapshot {
  stateId: string;
  stateName: string;
  elapsedMs: number;
  totalElapsedMs: number;
  outputs: Record<string, boolean>;
  physicalOutputs: Record<string, boolean>;
  foregroundTrack: number | null;
  ambientTrack: number | null;
  audio: AudioVoice[];
  irActivity: IrActivity[];
  children: Array<{
    id: string;
    name: string;
    phase: "running" | "cooldown";
    elapsedMs: number;
    remainingMs: number;
  }>;
  distances: Record<
    string,
    {
      distanceCm: number | null;
      zoneId: string | null;
      zoneName: string | null;
    }
  >;
  running: boolean;
}
interface Voice extends AudioVoice {
  stateEpoch: number;
  startedAt: number;
  fadeStartedAt: number;
  fadeDurationMs: number;
  fadeFrom: number;
  targetVolume: number;
  stopWhenSilent: boolean;
}
type DesiredVoice = Pick<AudioVoice, "role" | "track" | "volume" | "loop"> & {
  /** A zone action can replace the incoming voice's normal transition envelope. */
  fadeMs?: number;
};
interface PendingAudio {
  desired: DesiredVoice[];
  /** Foreground/nonpersistent retirement; retained ambient readiness is separate. */
  readyAt: number;
  preserveAmbientFade?: boolean;
}
interface InputState {
  raw: boolean;
  stable: boolean;
  changedAt: number;
  armed: boolean;
  activated: boolean;
}
interface DistanceState {
  distanceCm: number | null;
  zoneId: string | null;
  baselined: boolean;
  candidateId: string | null;
  candidateSince: number | null;
}
interface ZoneCrossing {
  onExit: ZoneAction[];
  onEnter: ZoneAction[];
  entered: boolean;
}

/** Deterministic logical preview. Audio decoder startup/latency remain hardware measurements. */
export class SceneSimulator {
  private readonly project: SceneProject;
  private current: SceneState;
  private elapsed = 0;
  private total = 0;
  private remainder = 0;
  private running = true;
  private voices: Voice[] = [];
  private pendingAudio: PendingAudio | null = null;
  private irActivity: IrActivity[] = [];
  private irSequence = 0;
  private stateEpoch = 0;
  private readonly timerStarted = new Map<string, number>();
  private readonly roundRobin = new Map<string, number>();
  private readonly inputs = new Map<string, InputState>();
  private readonly distances = new Map<string, DistanceState>();
  private readonly childStarted = new Map<string, number>();
  private readonly outputOwners: Map<string, SceneState>;

  constructor(project: SceneProject) {
    this.project = toRuntimeProject(parseProject(project));
    this.outputOwners = childOutputOwners(this.project);
    const errors = validateProject(project).filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length)
      throw new Error(
        `Fix project errors before simulation: ${errors[0].message}`,
      );
    this.current = this.project.states.find(
      (state) => state.id === this.project.initialStateId,
    )!;
    // Desktop switches begin released; firmware observes real inputs before arming them.
    this.project.triggers.forEach((trigger) =>
      this.inputs.set(trigger.id, {
        raw: false,
        stable: false,
        changedAt: 0,
        armed: true,
        activated: false,
      }),
    );
    this.restartTimers(false);
    this.project.triggers
      .filter((trigger) => trigger.kind === "ultrasonic")
      .forEach((trigger) => {
        this.distances.set(trigger.id, {
          distanceCm: null,
          zoneId: null,
          baselined: false,
          candidateId: null,
          candidateSince: null,
        });
      });
    this.updateAudio(true);
    this.fireTimelineIr(-1, 0);
  }

  advance(milliseconds: number): SimulatorSnapshot {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Advance time must be a finite nonnegative number.");
    if (!this.running) return this.snapshot();
    this.remainder += milliseconds;
    while (this.remainder >= 50) {
      this.remainder -= 50;
      this.total += 50;
      const previousElapsed = this.elapsed;
      const epoch = this.stateEpoch;
      const wraps =
        this.current.loopTimeline &&
        this.elapsed + 50 >= this.current.durationMs;
      this.elapsed += 50;
      if (this.current.loopTimeline) this.elapsed %= this.current.durationMs;
      else this.elapsed = Math.min(this.elapsed, this.current.durationMs);
      const rising = new Set<string>();
      const falling = new Set<string>();
      this.project.triggers.forEach((trigger) => {
        if (
          isZonedTrigger(trigger) ||
          trigger.kind === "timer" ||
          trigger.kind === "manual"
        )
          return;
        const input = this.inputs.get(trigger.id)!;
        if (
          input.raw !== input.stable &&
          this.total - input.changedAt >= trigger.debounceMs
        ) {
          input.stable = input.raw;
          if (!input.stable) {
            input.armed = true;
            if (input.activated) falling.add(trigger.id);
            input.activated = false;
          } else if (input.armed) {
            input.armed = false;
            input.activated = true;
            rising.add(trigger.id);
          }
        }
      });
      const crossings = this.project.triggers
        .filter(isZonedTrigger)
        .map((trigger) => this.sampleZones(trigger))
        .filter((crossing): crossing is ZoneCrossing => crossing !== null);
      if (rising.size || crossings.some((crossing) => crossing.entered))
        this.restartTimers(true);
      this.project.triggers.forEach((trigger) => {
        if (trigger.kind !== "timer") return;
        if (
          this.total - this.timerStarted.get(trigger.id)! >=
          (trigger.timerIntervalMs ?? 30000)
        ) {
          rising.add(trigger.id);
          this.timerStarted.set(trigger.id, this.total);
        }
      });
      this.applyTriggers(rising, falling);
      crossings.forEach((crossing) => {
        this.applyZoneActions(crossing.onExit);
        this.applyZoneActions(crossing.onEnter);
      });
      // Input/state actions take priority. Entering another state already fired
      // its tick-zero cues and cancels the previous state's due commands.
      if (epoch === this.stateEpoch) {
        if (wraps) {
          this.fireTimelineIr(previousElapsed, this.current.durationMs - 1);
          this.fireTimelineIr(-1, this.elapsed);
        } else this.fireTimelineIr(previousElapsed, this.elapsed);
      }
      this.refreshVoices();
      if (epoch === this.stateEpoch) this.finishKnownForeground();
    }
    return this.snapshot();
  }

  /** UI trigger button injects a clean edge, like the device's virtual-trigger command. */
  trigger(triggerId: string): boolean {
    const trigger = this.project.triggers.find((item) => item.id === triggerId);
    if (!this.running || !trigger || isZonedTrigger(trigger)) return false;
    this.restartTimers(true);
    return this.applyTriggers(new Set([triggerId]));
  }

  /** Inject a clean release edge for preview; physical inputs use setTrigger. */
  release(triggerId: string): boolean {
    const trigger = this.project.triggers.find((item) => item.id === triggerId);
    if (
      !trigger ||
      trigger.kind === "timer" ||
      trigger.kind === "manual" ||
      isZonedTrigger(trigger)
    )
      return false;
    return this.applyTriggers(new Set(), new Set([triggerId]));
  }

  /** Model a confirmed current foreground ending, without sending hardware commands. */
  audioFinished(playerIndex?: number): boolean {
    if (
      !this.running ||
      !this.current.audioEndStateId ||
      this.current.loopAudio
    )
      return false;
    this.refreshVoices();
    const voice = this.voices.find(
      (candidate) =>
        candidate.role === "foreground" &&
        !candidate.stopWhenSilent &&
        candidate.stateEpoch === this.stateEpoch &&
        !candidate.loop &&
        (playerIndex === undefined || candidate.playerIndex === playerIndex),
    );
    if (!voice || !this.project.audio.players[voice.playerIndex]?.feedback)
      return false;
    this.enter(this.current.audioEndStateId);
    return true;
  }

  /** Physical-input preview: debounce and release-before-rearm apply. */
  setTrigger(triggerId: string, active: boolean): void {
    const input = this.inputs.get(triggerId);
    if (!input) throw new Error(`Unknown trigger: ${triggerId}`);
    const trigger = this.project.triggers.find(
      (item) => item.id === triggerId,
    )!;
    if (trigger.kind === "timer")
      throw new Error("Timer inputs advance automatically.");
    if (trigger.kind === "manual")
      throw new Error(
        "Manual triggers use the preview trigger button, not a physical input.",
      );
    if (isZonedTrigger(trigger))
      throw new Error("Use a distance reading to preview an ultrasonic zone.");
    if (input.raw !== active) {
      input.raw = active;
      input.changedAt = this.total;
    }
  }

  /** Ultrasonic preview applies the same enter/release hysteresis as the firmware. */
  setDistance(triggerId: string, centimeters: number | null): void {
    const trigger = this.project.triggers.find(
      (candidate) => candidate.id === triggerId,
    );
    if (!trigger || trigger.kind !== "ultrasonic")
      throw new Error("Distance requires an ultrasonic trigger.");
    if (
      centimeters !== null &&
      (!Number.isFinite(centimeters) ||
        (!isZonedTrigger(trigger) && centimeters < 0))
    )
      throw new Error("Distance must be a valid number or null for no echo.");
    const distance = this.distances.get(triggerId)!;
    distance.distanceCm =
      centimeters === null || centimeters < 2 || centimeters > 400
        ? null
        : centimeters;
    if (isZonedTrigger(trigger)) {
      // Invalid measurements break dwell immediately, even between preview ticks.
      if (distance.distanceCm === null) distance.candidateSince = null;
      return;
    }
    const input = this.inputs.get(triggerId)!;
    if (distance.distanceCm === null) return;
    if (centimeters! >= trigger.thresholdCm + trigger.hysteresisCm)
      this.setTrigger(triggerId, false);
    else if (centimeters! <= trigger.thresholdCm)
      this.setTrigger(triggerId, true);
    else this.setTrigger(triggerId, input.raw);
  }

  reset(): SimulatorSnapshot {
    this.running = true;
    this.remainder = 0;
    this.irActivity = [];
    this.roundRobin.clear();
    this.childStarted.clear();
    this.restartTimers(false);
    this.inputs.forEach((input) => {
      input.stable = input.raw;
      input.armed = !input.raw;
      input.changedAt = this.total;
      input.activated = false;
    });
    this.distances.forEach((distance) => {
      distance.baselined = false;
      distance.zoneId = null;
      distance.candidateId = null;
      distance.candidateSince = null;
    });
    this.enter(this.project.initialStateId);
    return this.snapshot();
  }

  start(): SimulatorSnapshot {
    return this.reset();
  }

  stop(): SimulatorSnapshot {
    this.running = false;
    this.pendingAudio = null;
    this.voices = [];
    this.childStarted.clear();
    this.distances.forEach((distance) => {
      distance.candidateSince = null;
    });
    return this.snapshot();
  }

  snapshot(): SimulatorSnapshot {
    this.refreshVoices();
    this.expireChildren();
    const outputs: Record<string, boolean> = Object.create(null) as Record<
      string,
      boolean
    >;
    const physicalOutputs: Record<string, boolean> = Object.create(
      null,
    ) as Record<string, boolean>;
    this.project.outputs.forEach((output) => {
      const owner = this.outputOwners.get(output.id);
      const startedAt = owner ? this.childStarted.get(owner.id) : undefined;
      const elapsed = owner
        ? this.total - (startedAt ?? this.total)
        : this.elapsed;
      const events = owner
        ? startedAt !== undefined && elapsed < owner.durationMs
          ? owner.events
          : []
        : this.current.events;
      const interval = events.find(
        (event) =>
          event.outputId === output.id &&
          elapsed >= event.startMs &&
          elapsed < event.endMs,
      );
      const active =
        this.running &&
        (interval ? interval.active !== false : output.idleActive);
      outputs[output.id] = active;
      physicalOutputs[output.id] = active !== output.activeLow;
    });
    const foregroundTrack =
      this.current.id === this.project.initialStateId
        ? null
        : this.current.foregroundTrack;
    return {
      stateId: this.current.id,
      stateName: this.current.name,
      elapsedMs: this.elapsed,
      totalElapsedMs: this.total,
      outputs,
      physicalOutputs,
      foregroundTrack: this.running ? foregroundTrack : null,
      ambientTrack: this.running ? this.project.audio.ambientTrack : null,
      audio: this.voices.map(
        ({ role, track, volume, playerIndex, startedAt, loop }) => ({
          role,
          track,
          volume,
          playerIndex,
          positionMs: this.total - startedAt,
          loop,
        }),
      ),
      irActivity: this.irActivity.map((entry) => ({ ...entry })),
      children: this.project.states.flatMap((state) => {
        const startedAt = this.childStarted.get(state.id);
        if (startedAt === undefined) return [];
        const elapsedMs = this.total - startedAt;
        const running = elapsedMs < state.durationMs;
        return [
          {
            id: state.id,
            name: state.name,
            phase: running ? ("running" as const) : ("cooldown" as const),
            elapsedMs,
            remainingMs:
              state.durationMs +
              (running ? 0 : (state.cooldownMs ?? 0)) -
              elapsedMs,
          },
        ];
      }),
      distances: Object.fromEntries(
        this.project.triggers
          .filter((trigger) => trigger.kind === "ultrasonic")
          .map((trigger) => {
            const distance = this.distances.get(trigger.id)!;
            const zone = trigger.zones?.find(
              (item) => item.id === distance.zoneId,
            );
            return [
              trigger.id,
              {
                distanceCm: distance.distanceCm,
                zoneId: distance.zoneId,
                zoneName: zone?.name ?? null,
              },
            ];
          }),
      ),
      running: this.running,
    };
  }

  private applyTriggers(
    rising: Set<string>,
    falling = new Set<string>(),
  ): boolean {
    if (!this.running || (rising.size === 0 && falling.size === 0))
      return false;
    this.expireChildren();
    // All edges use the mappings of the original parent, even when a main
    // transition appears before a child launch in the same polling iteration.
    let mainTarget: string | undefined;
    let launched = false;
    for (const transition of this.current.transitions) {
      if (
        !(transition.edge === "release" ? falling : rising).has(
          transition.triggerId,
        )
      )
        continue;
      const target = this.project.states.find(
        (state) => state.id === transition.targetStateId,
      )!;
      if (isChildState(target)) {
        if (!this.childStarted.has(target.id)) {
          this.childStarted.set(target.id, this.total);
          launched = true;
        }
      } else if (mainTarget === undefined) {
        const targets = [
          transition.targetStateId,
          ...(transition.alternateStateIds ?? []),
        ];
        const key = `${this.current.id}\0${transition.triggerId}\0${transition.edge ?? "activate"}`;
        const next = this.roundRobin.get(key) ?? 0;
        this.roundRobin.set(key, (next + 1) % targets.length);
        mainTarget = targets[next % targets.length];
      }
    }
    if (mainTarget !== undefined) this.enter(mainTarget);
    return launched || mainTarget !== undefined;
  }

  private expireChildren(): void {
    for (const state of this.project.states) {
      const startedAt = this.childStarted.get(state.id);
      if (
        startedAt !== undefined &&
        this.total - startedAt >= state.durationMs + (state.cooldownMs ?? 0)
      )
        this.childStarted.delete(state.id);
    }
  }

  private restartTimers(externalOnly: boolean): void {
    this.project.triggers.forEach((trigger) => {
      if (
        trigger.kind === "timer" &&
        (!externalOnly || trigger.timerResetOnTrigger)
      )
        this.timerStarted.set(trigger.id, this.total);
    });
  }

  private finishKnownForeground(): void {
    if (!this.current.audioEndStateId) return;
    const foreground = this.voices.find(
      (voice) =>
        voice.role === "foreground" &&
        !voice.stopWhenSilent &&
        voice.stateEpoch === this.stateEpoch &&
        !voice.loop,
    );
    if (!foreground) return;
    const track = this.project.audio.tracks.find(
      (item) => item.number === foreground.track,
    );
    const duration = track ? getMediaClip(track).durationMs : 0;
    if (duration > 0 && this.total - foreground.startedAt >= duration)
      this.audioFinished(foreground.playerIndex);
  }

  private enter(stateId: string): void {
    this.stateEpoch++;
    this.current = this.project.states.find((state) => state.id === stateId)!;
    this.elapsed = 0;
    this.updateAudio(false);
    this.fireTimelineIr(-1, 0);
  }

  private recordIr(commandId: string, source: IrActivity["source"]): void {
    if (!this.running || !this.project.ir?.enabled) return;
    const command = this.project.ir.commands.find(
      (item) => item.id === commandId,
    );
    if (!command) return;
    this.irActivity.push({
      sequence: ++this.irSequence,
      commandId,
      name: command.name,
      atMs: this.total,
      stateId: this.current.id,
      source,
    });
    if (this.irActivity.length > 32)
      this.irActivity.splice(0, this.irActivity.length - 32);
  }

  private fireTimelineIr(afterMs: number, throughMs: number): void {
    for (const event of expandIrEvents(this.project, this.current))
      if (event.atMs > afterMs && event.atMs <= throughMs)
        this.recordIr(event.commandId, "timeline");
  }

  private sampleZones(trigger: TriggerConfig): ZoneCrossing | null {
    const distance = this.distances.get(trigger.id)!;
    if (distance.distanceCm === null) {
      distance.candidateSince = null;
      return null;
    }
    const zones = trigger.zones ?? [];
    const current = zones.find((zone) => zone.id === distance.zoneId);
    const centimeters = distance.distanceCm;
    const next =
      current &&
      centimeters >= current.minCm - current.hysteresisCm &&
      centimeters <= current.maxCm + current.hysteresisCm
        ? current
        : zones.find(
            (zone) => centimeters >= zone.minCm && centimeters <= zone.maxCm,
          );
    const nextId = next?.id ?? null;
    if (!distance.baselined) {
      distance.baselined = true;
      distance.zoneId = nextId;
      distance.candidateSince = null;
      return null;
    }
    if (nextId === distance.zoneId) {
      distance.candidateSince = null;
      return null;
    }
    if (distance.candidateSince === null || distance.candidateId !== nextId) {
      distance.candidateId = nextId;
      distance.candidateSince = this.total;
    }
    if (this.total - distance.candidateSince < trigger.debounceMs) return null;
    distance.zoneId = nextId;
    distance.candidateSince = null;
    // Record the crossing before dispatch; entering a scene does not rearm sensors.
    return {
      onExit: current?.onExit ?? [],
      onEnter: next?.onEnter ?? [],
      entered: nextId !== null,
    };
  }

  private applyZoneActions(actions: ZoneAction[]): void {
    actions.forEach((action) => {
      if (action.kind === "state") this.enter(action.stateId);
      else if (action.kind === "ir") this.recordIr(action.commandId, "zone");
      else this.setRoleVolume(action.target, action.volume, action.fadeMs);
    });
  }

  private setRoleVolume(
    role: AudioVoice["role"],
    volume: number,
    fadeMs: number,
  ): void {
    this.refreshVoices();
    const pending = this.pendingAudio;
    if (pending) {
      const desired = pending.desired.find((voice) => voice.role === role);
      if (!desired) return;
      desired.volume = volume;
      desired.fadeMs = fadeMs;
      // Outgoing foreground and nonpersistent ambient keep retiring. Their
      // replacements receive the override when handoff starts playback.
      if (role === "foreground" || !this.project.audio.keepAmbient) return;
      pending.preserveAmbientFade = true;
      // Releasing an ambient-only wait starts incoming playback now, never at
      // an earlier foreground deadline. A future foreground deadline still holds.
      pending.readyAt = Math.max(pending.readyAt, this.total);
    }
    const voice = this.voices.find(
      (candidate) =>
        candidate.role === role &&
        (role === "ambient" && pending ? true : !candidate.stopWhenSilent),
    );
    if (!voice) return;
    voice.fadeFrom = voice.volume;
    voice.fadeStartedAt = this.total;
    voice.fadeDurationMs = fadeMs;
    voice.targetVolume = volume;
    // A muted logical role stays resident so later volume changes keep its playhead.
    voice.stopWhenSilent = false;
    this.refreshVoices();
  }

  private refreshVoices(): void {
    const pending = this.pendingAudio;
    // Clearing a zone override can begin a new silent-ambient fade while the
    // original foreground fade is already pending. Both must reach silence;
    // a fresh persistent override makes ambient independent again.
    const retiringAmbient =
      pending &&
      this.project.audio.keepAmbient &&
      resolveAmbientMixVolume(this.project.audio) === 0 &&
      !pending.preserveAmbientFade
        ? this.voices.find((voice) => voice.role === "ambient")
        : undefined;
    const readyAt = Math.max(
      pending?.readyAt ?? 0,
      retiringAmbient?.targetVolume === 0 && retiringAmbient.fadeFrom > 0
        ? retiringAmbient.fadeStartedAt + retiringAmbient.fadeDurationMs
        : 0,
    );
    if (pending && this.total >= readyAt) {
      this.pendingAudio = null;
      this.installVoices(
        pending.desired,
        readyAt,
        resolveAudioTransition(this.project.audio).fadeInMs,
        this.project.audio.keepAmbient,
        resolveAmbientMixVolume(this.project.audio) > 0 ||
          !!pending.preserveAmbientFade,
      );
    }
    this.voices.forEach((voice) => {
      const progress =
        voice.fadeDurationMs === 0
          ? 1
          : Math.min(
              1,
              (this.total - voice.fadeStartedAt) / voice.fadeDurationMs,
            );
      voice.volume =
        voice.fadeFrom + (voice.targetVolume - voice.fadeFrom) * progress;
    });
    this.voices = this.voices.filter(
      (voice) =>
        !(
          voice.stopWhenSilent &&
          voice.volume <= 0 &&
          voice.targetVolume === 0
        ),
    );
  }

  /** Reuse resident ambient, but a new state always restarts its foreground. */
  private installVoices(
    desired: DesiredVoice[],
    startedAt: number,
    fadeDurationMs: number,
    retainAmbient = true,
    preserveAmbientFade = false,
  ): void {
    const occupied = new Set<number>();
    const retained = desired.map((item) => ({
      item,
      old:
        retainAmbient && item.role === "ambient"
          ? this.voices.find(
              (voice) => voice.role === item.role && voice.track === item.track,
            )
          : undefined,
    }));
    retained.forEach(({ old }) => {
      if (old) occupied.add(old.playerIndex);
    });
    this.voices = retained.map(({ item, old }) => {
      // The mixed ambient envelope runs independently of foreground fade-through.
      if (old && preserveAmbientFade) return old;
      const playerIndex =
        old?.playerIndex ??
        Array.from(
          { length: this.project.audio.players.length },
          (_, index) => index,
        ).find((index) => !occupied.has(index))!;
      occupied.add(playerIndex);
      const duration = item.fadeMs ?? fadeDurationMs;
      return {
        ...item,
        stateEpoch: this.stateEpoch,
        playerIndex,
        volume: duration === 0 ? item.volume : 0,
        positionMs: 0,
        startedAt: old?.startedAt ?? startedAt,
        fadeStartedAt: startedAt,
        fadeDurationMs: duration,
        fadeFrom: duration === 0 ? item.volume : 0,
        targetVolume: item.volume,
        stopWhenSilent: false,
      };
    });
  }

  private updateAudio(immediate: boolean): void {
    this.refreshVoices();
    const { audio } = this.project;
    const foreground =
      this.current.id === this.project.initialStateId
        ? null
        : this.current.foregroundTrack;
    const transition = resolveAudioTransition(audio);
    const ambientMixVolume = resolveAmbientMixVolume(audio);
    const mixedAmbient = ambientMixVolume > 0;
    const desired: DesiredVoice[] = [];
    if (
      audio.ambientTrack !== null &&
      (foreground === null || audio.keepAmbient)
    )
      desired.push({
        role: "ambient",
        track: audio.ambientTrack,
        volume: foreground === null ? audio.ambientVolume : ambientMixVolume,
        loop: true,
      });
    if (foreground !== null)
      desired.push({
        role: "foreground",
        track: foreground,
        volume: this.current.volume,
        loop: this.current.loopAudio,
      });
    if (mixedAmbient && !immediate) {
      const ambient = this.voices.find((voice) => voice.role === "ambient");
      const target =
        foreground === null ? audio.ambientVolume : ambientMixVolume;
      if (ambient && ambient.targetVolume !== target) {
        ambient.fadeFrom = ambient.volume;
        ambient.fadeStartedAt = this.total;
        ambient.fadeDurationMs =
          transition.mode === "fade-through"
            ? foreground === null
              ? transition.fadeInMs
              : transition.fadeOutMs
            : transition.crossfadeMs;
        ambient.targetVolume = target;
        ambient.stopWhenSilent = false;
      }
    }
    if (!immediate && transition.mode === "fade-through") {
      if (this.pendingAudio) {
        // Trigger priority is immediate; only the newest audio target survives.
        this.pendingAudio.desired = desired;
        this.pendingAudio.preserveAmbientFade = false;
        if (audio.keepAmbient && !mixedAmbient) {
          const ambient = this.voices.find((voice) => voice.role === "ambient");
          if (ambient && ambient.targetVolume !== 0) {
            ambient.fadeFrom = ambient.volume;
            ambient.fadeStartedAt = this.total;
            ambient.fadeDurationMs = transition.fadeOutMs;
            ambient.targetVolume = 0;
            ambient.stopWhenSilent = false;
          }
        }
      } else {
        const duration = this.voices.some(
          (voice) =>
            voice.volume > 0 && !(mixedAmbient && voice.role === "ambient"),
        )
          ? transition.fadeOutMs
          : 0;
        const retirementDuration = this.voices.some(
          (voice) =>
            voice.volume > 0 &&
            (voice.role === "foreground" || !audio.keepAmbient),
        )
          ? transition.fadeOutMs
          : 0;
        this.pendingAudio = {
          desired,
          readyAt: this.total + retirementDuration,
        };
        this.voices.forEach((voice) => {
          if (mixedAmbient && voice.role === "ambient") return;
          voice.fadeFrom = voice.volume;
          voice.fadeStartedAt = this.total;
          voice.fadeDurationMs = duration;
          voice.targetVolume = 0;
          voice.stopWhenSilent = !(
            audio.keepAmbient && voice.role === "ambient"
          );
        });
      }
      this.refreshVoices();
      return;
    }
    this.pendingAudio = null;
    const hardCut =
      immediate ||
      transition.mode === "cut" ||
      audio.players.length < 2 ||
      transition.crossfadeMs === 0;
    if (hardCut) {
      this.installVoices(desired, this.total, 0);
      return;
    }
    this.voices.forEach((voice) => {
      if (mixedAmbient && voice.role === "ambient") return;
      voice.fadeFrom = voice.volume;
      voice.fadeStartedAt = this.total;
      voice.fadeDurationMs = transition.crossfadeMs;
      voice.targetVolume = 0;
      voice.stopWhenSilent = true;
    });
    desired.forEach((item) => {
      // State entry restarts its foreground clip; ambient alone retains position.
      let existing =
        item.role === "ambient"
          ? this.voices.find(
              (voice) => voice.role === item.role && voice.track === item.track,
            )
          : undefined;
      if (!existing) {
        let playerIndex = Array.from(
          { length: audio.players.length },
          (_, index) => index,
        ).find(
          (index) => !this.voices.some((voice) => voice.playerIndex === index),
        );
        if (playerIndex === undefined) {
          // A rapid new trigger may interrupt an earlier fade: recycle its quietest retiring voice.
          const retiring = this.voices
            .filter((voice) => voice.stopWhenSilent)
            .sort((a, b) => a.volume - b.volume)[0];
          if (!retiring) return;
          playerIndex = retiring.playerIndex;
          this.voices = this.voices.filter((voice) => voice !== retiring);
        }
        existing = {
          ...item,
          stateEpoch: this.stateEpoch,
          playerIndex,
          volume: 0,
          positionMs: 0,
          startedAt: this.total,
          fadeStartedAt: this.total,
          fadeDurationMs: transition.crossfadeMs,
          fadeFrom: 0,
          targetVolume: item.volume,
          stopWhenSilent: false,
        };
        this.voices.push(existing);
      }
      existing.targetVolume = item.volume;
      existing.loop = item.loop;
      existing.stopWhenSilent = false;
    });
  }
}

export function createSimulator(project: SceneProject): SceneSimulator {
  return new SceneSimulator(project);
}
