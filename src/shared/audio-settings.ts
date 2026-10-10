import type { SceneProject } from "./model";

/** Preserve legacy projects while keeping crossfade and sequential fade settings separate. */
export function resolveAudioTransition(audio: SceneProject["audio"]) {
  const mode = audio.transitionMode ?? (audio.fadeMs > 0 ? "crossfade" : "cut");
  return {
    mode,
    crossfadeMs: mode === "crossfade" ? audio.fadeMs : 0,
    fadeOutMs: audio.fadeOutMs ?? 250,
    fadeInMs: audio.fadeInMs ?? 250,
  };
}
