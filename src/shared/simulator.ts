import type { SceneProject, SceneState } from "./model";
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
type DesiredVoice = Pick<AudioVoice, "role" | "track" | "volume" | "loop">;
interface PendingAudio {
  desired: DesiredVoice[];
  readyAt: number;
}
interface InputState {
  raw: boolean;
  stable: boolean;
  changedAt: number;
  armed: boolean;
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
  private readonly inputs = new Map<string, InputState>();

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
    this.updateAudio(true);
  }

  advance(milliseconds: number): SimulatorSnapshot {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Advance time must be a finite nonnegative number.");
    if (!this.running) return this.snapshot();
    this.remainder += milliseconds;
    while (this.remainder >= 50) {
      this.remainder -= 50;
      this.total += 50;
      this.elapsed += 50;
      if (this.current.loopTimeline) this.elapsed %= this.current.durationMs;
      else this.elapsed = Math.min(this.elapsed, this.current.durationMs);
      const rising = new Set<string>();
      this.project.triggers.forEach((trigger) => {
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
      this.refreshVoices();
    }
    return this.snapshot();
  }

  /** UI trigger button injects a clean edge, like the device's virtual-trigger command. */
  trigger(triggerId: string): boolean {
    if (!this.inputs.has(triggerId)) return false;
    return this.applyTriggers(new Set([triggerId]));
  }

  /** Physical-input preview: debounce and release-before-rearm apply. */
  setTrigger(triggerId: string, active: boolean): void {
    const input = this.inputs.get(triggerId);
    if (!input) throw new Error(`Unknown trigger: ${triggerId}`);
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
      (!Number.isFinite(centimeters) || centimeters < 0)
    )
      throw new Error("Distance must be nonnegative or null for no echo.");
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
    this.current = this.project.states.find((state) => state.id === stateId)!;
    this.elapsed = 0;
    this.updateAudio(false);
  }

  private refreshVoices(): void {
    if (this.pendingAudio && this.total >= this.pendingAudio.readyAt) {
      const pending = this.pendingAudio;
      this.pendingAudio = null;
      this.installVoices(
        pending.desired,
        pending.readyAt,
        resolveAudioTransition(this.project.audio).fadeInMs,
        this.project.audio.keepAmbient,
        resolveAmbientMixVolume(this.project.audio) > 0,
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
      return {
        ...item,
        playerIndex,
        volume: fadeDurationMs === 0 ? item.volume : 0,
        positionMs: 0,
        startedAt: old?.startedAt ?? startedAt,
        fadeStartedAt: startedAt,
        fadeDurationMs,
        fadeFrom: fadeDurationMs === 0 ? item.volume : 0,
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
      } else {
        const duration = this.voices.some(
          (voice) =>
            voice.volume > 0 && !(mixedAmbient && voice.role === "ambient"),
        )
          ? transition.fadeOutMs
          : 0;
        this.pendingAudio = { desired, readyAt: this.total + duration };
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
