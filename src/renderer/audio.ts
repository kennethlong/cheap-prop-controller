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
    }
  >();

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
    const data = buffer.getChannelData(0);
    const samples = 900;
    const size = Math.max(1, Math.floor(data.length / samples));
    return Array.from({ length: samples }, (_, i) => {
      let peak = 0;
      const end = Math.min(data.length, (i + 1) * size);
      for (let j = i * size; j < end; j += Math.max(1, Math.floor(size / 100)))
        peak = Math.max(peak, Math.abs(data[j]));
      return peak;
    });
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
  ) {
    const context = this.getContext();
    const slots = new Set(voices.map((voice) => `player-${voice.playerIndex}`));
    for (const key of this.voices.keys())
      if (!slots.has(key)) this.stop(key, 30);
    for (const voice of voices) {
      const slot = `player-${voice.playerIndex}`;
      const track = String(voice.track);
      let current = this.voices.get(slot);
      if (
        current &&
        (current.track !== track ||
          voice.positionMs + 100 < (current.positionMs ?? 0))
      ) {
        this.stop(slot, 20);
        current = undefined;
      }
      if (!current) {
        const buffer = this.buffers.get(track);
        if (
          !buffer ||
          (!voice.loop && voice.positionMs / 1000 >= buffer.duration)
        )
          continue;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.loop = voice.loop;
        source.connect(gain).connect(context.destination);
        gain.gain.setValueAtTime(voice.volume / 30, context.currentTime);
        current = { source, gain, track, positionMs: voice.positionMs };
        this.voices.set(slot, current);
        source.onended = () => {
          if (this.voices.get(slot)?.source === source)
            this.voices.delete(slot);
          source.disconnect();
          gain.disconnect();
        };
        source.start(0, (voice.positionMs / 1000) % buffer.duration);
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
    for (const slot of this.voices.keys()) this.stop(slot, fadeMs);
  }
}
