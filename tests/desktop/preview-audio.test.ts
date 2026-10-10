import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewAudio } from "../../src/renderer/audio";
import type { MediaTrack } from "../../src/shared";

const createFakeSource = () => ({
  buffer: null as AudioBuffer | null,
  loop: false,
  loopStart: 0,
  loopEnd: 0,
  start: vi.fn(),
  stop: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn((gain: unknown) => gain),
  onended: null as (() => void) | null,
});

class FakeAudioContext {
  static latest: FakeAudioContext;
  currentTime = 0;
  state = "running";
  destination = {};
  sources: Array<ReturnType<typeof createFakeSource>> = [];
  resume = vi.fn(async () => {});
  suspend = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    FakeAudioContext.latest = this;
  }
  async decodeAudioData() {
    const data = Float32Array.from({ length: 10000 }, (_, index) =>
      index >= 2000 && index < 5000 ? 0.5 : 0.1,
    );
    return {
      duration: 10,
      sampleRate: 1000,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }
  createBufferSource() {
    const source = createFakeSource();
    this.sources.push(source);
    return source;
  }
  createGain() {
    return {
      gain: {
        value: 0.5,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
}

const trimmed: MediaTrack = {
  number: 1,
  name: "scene.mp3",
  trimStartMs: 2000,
  trimEndMs: 5000,
};
const voice = (positionMs: number, loop = false) => ({
  playerIndex: 0,
  track: 1,
  volume: 20,
  positionMs,
  loop,
});

describe("trimmed desktop audio preview", () => {
  beforeEach(() => vi.stubGlobal("AudioContext", FakeAudioContext));
  afterEach(() => vi.unstubAllGlobals());

  it("plays from the selected start and schedules a nonlooping stop at the selected end", async () => {
    const audio = new PreviewAudio();
    await audio.load("1", new ArrayBuffer(0));
    audio.sync([voice(1000)], [trimmed]);
    const source = FakeAudioContext.latest.sources[0];
    expect(source.start).toHaveBeenCalledWith(0, 3, 2);
    expect(source.loop).toBe(false);
    source.onended?.();
    audio.sync([voice(3050)], [trimmed]);
    expect(FakeAudioContext.latest.sources).toHaveLength(1);
  });

  it("loops inside the selected clip and wraps late starts within that range", async () => {
    const audio = new PreviewAudio();
    await audio.load("1", new ArrayBuffer(0));
    audio.sync([voice(8000, true)], [trimmed]);
    const source = FakeAudioContext.latest.sources[0];
    expect(source.loopStart).toBe(2);
    expect(source.loopEnd).toBe(5);
    expect(source.start).toHaveBeenCalledWith(0, 4);
  });

  it("redraws waveform peaks from the selected samples", async () => {
    const audio = new PreviewAudio();
    const full = await audio.load("1", new ArrayBuffer(0));
    expect(full[0]).toBeCloseTo(0.1);
    expect(audio.waveform(trimmed)).toHaveLength(900);
    expect(audio.waveform(trimmed)?.every((peak) => peak === 0.5)).toBe(true);
  });

  it("auditions only the draft range and stops scene audio first", async () => {
    const audio = new PreviewAudio();
    await audio.load("1", new ArrayBuffer(0));
    audio.sync([voice(0)], [trimmed]);
    await audio.audition("1", 4000, 4500);
    const [scene, audition] = FakeAudioContext.latest.sources;
    expect(scene.stop).toHaveBeenCalled();
    expect(audition.start).toHaveBeenCalledWith(0, 4, 0.5);
    audio.stopAudition();
    expect(audition.stop).toHaveBeenCalled();
  });

  it("cancels an audition even while audio resume is pending", async () => {
    const audio = new PreviewAudio();
    await audio.load("1", new ArrayBuffer(0));
    let resumed!: () => void;
    FakeAudioContext.latest.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resumed = resolve;
        }),
    );
    const pending = audio.audition("1", 2000, 5000);
    audio.stopAudition();
    resumed();
    await pending;
    expect(FakeAudioContext.latest.sources).toHaveLength(0);
  });
});
