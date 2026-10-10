import { getMediaClip } from "../shared";
import type { MediaTrack } from "../shared";

/** Desktop-only media preview. The controller uses its own MP3 modules. */
export class PreviewAudio {
  private context: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Map<
    string,
    {
      source: AudioBufferSourceNode;
      gain: GainNode;
      track: string;
      positionMs?: number;
      clipKey?: string;
    }
  >();
  private auditionGeneration = 0;

  private getContext() {
    this.context ??= new AudioContext();
    return this.context;
  }

  async load(
    id: string,
    bytes: ArrayBuffer,
    isCurrent: () => boolean = () => true,
  ): Promise<number[]> {
    const buffer = await this.getContext().decodeAudioData(bytes.slice(0));
    if (isCurrent()) this.buffers.set(id, buffer);
    return this.peaks(buffer, 0, buffer.duration * 1000);
  }

  private peaks(buffer: AudioBuffer, startMs: number, endMs: number) {
    const data = buffer.getChannelData(0);
    const first = Math.floor((startMs / 1000) * buffer.sampleRate);
    const last = Math.min(
      data.length,
      Math.ceil((endMs / 1000) * buffer.sampleRate),
    );
    const samples = 900;
    const size = (last - first) / samples;
    return Array.from({ length: samples }, (_, i) => {
      let peak = 0;
      const start = first + Math.floor(i * size);
      const end = Math.min(last, first + Math.ceil((i + 1) * size));
      for (let j = start; j < end; j += Math.max(1, Math.floor(size / 100)))
        peak = Math.max(peak, Math.abs(data[j]));
      return peak;
    });
  }

  waveform(track: MediaTrack) {
    const buffer = this.buffers.get(String(track.number));
    if (!buffer) return undefined;
    const clip = getMediaClip(track, buffer.duration * 1000);
    return this.peaks(buffer, clip.startMs, clip.endMs);
  }

  has(id: string) {
    return this.buffers.has(id);
  }
  duration(id: string) {
    return (this.buffers.get(id)?.duration ?? 0) * 1000;
  }

  remove(id: string) {
    this.buffers.delete(id);
    for (const [slot, voice] of this.voices)
      if (voice.track === id) this.stop(slot);
  }

  clear() {
    this.stopAll();
    this.buffers.clear();
  }

  dispose() {
    this.clear();
    const context = this.context;
    this.context = null;
    if (context) void context.close();
  }

  async resume() {
    await this.getContext().resume();
  }
  async pause() {
    if (this.context?.state === "running") await this.context.suspend();
  }

  sync(
    voices: Array<{
      playerIndex: number;
      track: number;
      volume: number;
      positionMs: number;
      loop: boolean;
    }>,
    tracks: MediaTrack[] = [],
  ) {
    const context = this.getContext();
    const slots = new Set(voices.map((voice) => `player-${voice.playerIndex}`));
    for (const key of this.voices.keys())
      if (!slots.has(key)) this.stop(key, 30);
    for (const voice of voices) {
      const slot = `player-${voice.playerIndex}`;
      const track = String(voice.track);
      const buffer = this.buffers.get(track);
      if (!buffer) {
        this.stop(slot);
        continue;
      }
      const clip = getMediaClip(
        tracks.find((item) => item.number === voice.track) ?? {
          number: voice.track,
          name: track,
        },
        buffer.duration * 1000,
      );
      const clipKey = `${clip.startMs}:${clip.endMs}:${voice.loop}`;
      const positionMs = Math.max(0, voice.positionMs);
      let current = this.voices.get(slot);
      if (
        current &&
        (current.track !== track ||
          current.clipKey !== clipKey ||
          voice.positionMs + 100 < (current.positionMs ?? 0))
      ) {
        this.stop(slot, 20);
        current = undefined;
      }
      if (!current) {
        if (
          clip.durationMs <= 0 ||
          (!voice.loop && positionMs >= clip.durationMs)
        )
          continue;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = voice.loop;
        source.loopStart = clip.startMs / 1000;
        source.loopEnd = clip.endMs / 1000;
        source.connect(gain).connect(context.destination);
        gain.gain.setValueAtTime(voice.volume / 30, context.currentTime);
        current = { source, gain, track, positionMs, clipKey };
        this.voices.set(slot, current);
        source.onended = () => {
          if (this.voices.get(slot)?.source === source)
            this.voices.delete(slot);
          source.disconnect();
          gain.disconnect();
        };
        const clipPosition = voice.loop
          ? positionMs % clip.durationMs
          : positionMs;
        const offset = (clip.startMs + clipPosition) / 1000;
        if (voice.loop) source.start(0, offset);
        else source.start(0, offset, (clip.durationMs - clipPosition) / 1000);
      }
      current.positionMs = voice.positionMs;
      current.gain.gain.cancelScheduledValues(context.currentTime);
      current.gain.gain.setValueAtTime(
        current.gain.gain.value,
        context.currentTime,
      );
      current.gain.gain.linearRampToValueAtTime(
        voice.volume / 30,
        context.currentTime + 0.04,
      );
    }
  }

  async audition(track: string, startMs: number, endMs: number) {
    this.stopAll();
    const generation = this.auditionGeneration;
    const context = this.getContext();
    await context.resume();
    if (generation !== this.auditionGeneration) return;
    const buffer = this.buffers.get(track);
    if (!buffer)
      throw new Error("Link this track to an MP3 file before previewing.");
    const clip = getMediaClip(
      {
        number: Number(track),
        name: track,
        trimStartMs: startMs,
        trimEndMs: endMs,
      },
      buffer.duration * 1000,
    );
    if (clip.durationMs <= 0) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    gain.gain.setValueAtTime(0.7, context.currentTime);
    this.voices.set("audition", { source, gain, track });
    source.onended = () => {
      if (this.voices.get("audition")?.source === source)
        this.voices.delete("audition");
      source.disconnect();
      gain.disconnect();
    };
    source.start(0, clip.startMs / 1000, clip.durationMs / 1000);
  }

  stopAudition() {
    this.auditionGeneration++;
    this.stop("audition");
  }

  async play(
    slot: string,
    track: string,
    volume: number,
    loop: boolean,
    fadeMs: number,
    preserve = false,
  ) {
    const context = this.getContext();
    await context.resume();
    const old = this.voices.get(slot);
    if (old?.track === track && preserve) {
      old.gain.gain.cancelScheduledValues(context.currentTime);
      old.gain.gain.setTargetAtTime(
        Math.max(0, volume),
        context.currentTime,
        Math.max(0.01, fadeMs / 3000),
      );
      return;
    }
    this.stop(slot, fadeMs);
    const buffer = this.buffers.get(track);
    if (!buffer) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain).connect(context.destination);
    gain.gain.setValueAtTime(fadeMs ? 0 : volume, context.currentTime);
    if (fadeMs)
      gain.gain.linearRampToValueAtTime(
        volume,
        context.currentTime + fadeMs / 1000,
      );
    this.voices.set(slot, { source, gain, track });
    source.onended = () => {
      if (this.voices.get(slot)?.source === source) this.voices.delete(slot);
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  }

  stop(slot: string, fadeMs = 0) {
    const voice = this.voices.get(slot);
    if (!voice || !this.context) return;
    this.voices.delete(slot);
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    try {
      voice.source.stop(now + fadeMs / 1000 + 0.01);
    } catch {
      /* Already finished. */
    }
  }

  stopAll(fadeMs = 0) {
    this.auditionGeneration++;
    for (const slot of this.voices.keys()) this.stop(slot, fadeMs);
  }
}
