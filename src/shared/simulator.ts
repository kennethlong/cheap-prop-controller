import {
  isZonedTrigger,
  type SceneProject,
  type SceneState,
  type TriggerConfig,
  type ZoneAction,
} from "./model";
import { parseProject, validateProject } from "./validation";
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
}
interface DistanceState {
  distanceCm: number | null;
  zoneId: string | null;
  baselined: boolean;
  candidateId: string | null;
  candidateSince: number | null;
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
  private readonly inputs = new Map<string, InputState>();
  private readonly distances = new Map<string, DistanceState>();

  constructor(project: SceneProject) {
    this.project = parseProject(project);
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
      }),
    );
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
      this.project.triggers.forEach((trigger) => {
        if (isZonedTrigger(trigger)) return;
        const input = this.inputs.get(trigger.id)!;
        if (
          input.raw !== input.stable &&
          this.total - input.changedAt >= trigger.debounceMs
        ) {
          input.stable = input.raw;
          if (!input.stable) input.armed = true;
          else if (input.armed) {
            input.armed = false;
            rising.add(trigger.id);
          }
        }
      });
      this.applyTriggers(rising);
      this.project.triggers.forEach((trigger) => {
        if (isZonedTrigger(trigger)) this.sampleZones(trigger);
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
    }
    return this.snapshot();
  }

  /** UI trigger button injects a clean edge, like the device's virtual-trigger command. */
  trigger(triggerId: string): boolean {
    const trigger = this.project.triggers.find((item) => item.id === triggerId);
    if (!trigger || isZonedTrigger(trigger)) return false;
    return this.applyTriggers(new Set([triggerId]));
  }

  /** Physical-input preview: debounce and release-before-rearm apply. */
  setTrigger(triggerId: string, active: boolean): void {
    const input = this.inputs.get(triggerId);
    if (!input) throw new Error(`Unknown trigger: ${triggerId}`);
    if (
      isZonedTrigger(
        this.project.triggers.find((item) => item.id === triggerId)!,
      )
    )
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
    if (
      centimeters === null ||
      centimeters < 2 ||
      centimeters > 400 ||
      centimeters >= trigger.thresholdCm + trigger.hysteresisCm
    )
      this.setTrigger(triggerId, false);
    else if (centimeters <= trigger.thresholdCm)
      this.setTrigger(triggerId, true);
    else this.setTrigger(triggerId, input.raw);
  }

  reset(): SimulatorSnapshot {
    this.running = true;
    this.remainder = 0;
    this.irActivity = [];
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
    this.distances.forEach((distance) => {
      distance.candidateSince = null;
    });
    return this.snapshot();
  }

  snapshot(): SimulatorSnapshot {
    this.refreshVoices();
    const outputs: Record<string, boolean> = Object.create(null) as Record<
      string,
      boolean
    >;
    const physicalOutputs: Record<string, boolean> = Object.create(
      null,
    ) as Record<string, boolean>;
    this.project.outputs.forEach((output) => {
      const active =
        this.running &&
        (output.idleActive ||
          this.current.events.some(
            (event) =>
              event.outputId === output.id &&
              this.elapsed >= event.startMs &&
              this.elapsed < event.endMs,
          ));
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

  private applyTriggers(rising: Set<string>): boolean {
    if (!this.running || rising.size === 0) return false;
    const transition = this.current.transitions.find((candidate) =>
      rising.has(candidate.triggerId),
    );
    if (!transition) return false;
    this.enter(transition.targetStateId);
    return true;
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
    for (const event of [...(this.current.irEvents ?? [])].sort(
      (a, b) => a.atMs - b.atMs,
    ))
      if (event.atMs > afterMs && event.atMs <= throughMs)
        this.recordIr(event.commandId, "timeline");
  }

  private sampleZones(trigger: TriggerConfig): void {
    const distance = this.distances.get(trigger.id)!;
    if (distance.distanceCm === null) {
      distance.candidateSince = null;
      return;
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
      return;
    }
    if (nextId === distance.zoneId) {
      distance.candidateSince = null;
      return;
    }
    if (distance.candidateSince === null || distance.candidateId !== nextId) {
      distance.candidateId = nextId;
      distance.candidateSince = this.total;
    }
    if (this.total - distance.candidateSince < trigger.debounceMs) return;
    distance.zoneId = nextId;
    distance.candidateSince = null;
    // Record the crossing before dispatch; entering a scene does not rearm sensors.
    this.applyZoneActions(current?.onExit ?? []);
    this.applyZoneActions(next?.onEnter ?? []);
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
