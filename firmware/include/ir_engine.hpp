#pragma once
#include "scene_image.hpp"
#include "ir_driver.hpp"

namespace cpc {
class IrEngine {
  const SceneImage* image = nullptr;
  uint8_t queue[8] = {}, head = 0, queued = 0, state = 0;
  uint8_t pulses[127] = {}, length = 0, repeats = 0;
  uint16_t gap = 50;
  uint32_t nextAt = 0, enteredAt = 0, lastTick = 0, learnAt = 0;
  bool job = false, wasSending = false, overflow = false, gapPending = false;
  bool irEnabled = false;
  // 0 normal, 1 draining for learn, 2 receiving, 3 staging, 4 staged playback.
  uint8_t mode = 0, stagedExpected = 0, stagedReceived = 0;
  static bool due(uint32_t now, uint32_t at) { return static_cast<int32_t>(now - at) >= 0; }
  void nec(uint32_t code) {
    length = 67; pulses[0] = 180; pulses[1] = 90;
    for (uint8_t i = 0; i < 32; ++i) { pulses[2 + i * 2] = 11; pulses[3 + i * 2] = code & (static_cast<uint32_t>(1) << i) ? 34 : 11; }
    pulses[66] = 11;
  }
  void load(uint8_t index) {
    const uint16_t c = image->irCommand(index);
    repeats = image->b(c + 2); gap = image->u16(c + 8);
    if (!image->b(c)) nec(static_cast<uint32_t>(image->u16(c + 4)) | static_cast<uint32_t>(image->u16(c + 6)) << 16);
    else { length = static_cast<uint8_t>(image->u16(c + 6)); for (uint8_t i = 0; i < length; ++i) pulses[i] = image->b(image->irRaw() + image->u16(c + 4) + i); }
  }
 public:
  bool enabled() const { return irEnabled; }
  bool transmitting() const { return irDriver::transmitting; }
  bool learning() const { return mode == 1 || mode == 2; }
  bool staging() const { return mode == 3; }
  bool busy() const { return transmitting() || job || queued || gapPending || mode != 0; }
  uint8_t stagedOffset() const { return stagedReceived; }
  uint8_t captureLength() const { return irDriver::capture.count; }
  uint16_t captureMicros(uint8_t i) const { return pulses[i] * 50U; }
  bool takeOverflow() { const bool value = overflow; overflow = false; return value; }
  void begin(const SceneImage* source) {
    stop(); irDriver::end(); image = source; irEnabled = source && source->hasIr();
    if (enabled()) {
      irDriver::begin(image->b(image->irFooter()));
#if defined(ARDUINO)
      pinMode(2, INPUT);
#endif
    }
  }
  void stop() {
    irDriver::cancel(); irDriver::stopReceiver();
    head = queued = repeats = mode = stagedExpected = stagedReceived = 0;
    job = wasSending = overflow = gapPending = false;
  }
  bool enqueue(uint8_t command) {
    if (!enabled() || mode || command >= image->irCommandCount()) return false;
    if (queued == 8) { overflow = true; return false; }
    queue[(head + queued++) & 7] = command; return true;
  }
  void enter(uint8_t stateIndex, uint32_t now) { enter(stateIndex, now, now); }
  void enter(uint8_t stateIndex, uint32_t now, uint32_t observedNow) {
    head = queued = 0; state = stateIndex; enteredAt = now; lastTick = 0;
    // A frame already on the air can finish; repetitions and unsent commands
    // from the old state are cancelled. STOP additionally cuts the carrier.
    if (transmitting()) repeats = 1;
    else {
      if (wasSending) { nextAt = observedNow + gap; gapPending = true; }
      job = false; repeats = 0; wasSending = false;
    }
    if (!enabled() || mode) return;
    for (uint16_t i = 0; i < image->irTimedCount(); ++i) {
      const uint16_t t = image->irTimed(i);
      if (image->b(t) == state && !image->u16(t + 2)) enqueue(image->b(t + 1));
    }
  }
  void timeline(uint32_t now) {
    if (!enabled() || mode) return;
    const uint32_t current = (now - enteredAt) / 50;
    if (current == lastTick) return;
    const uint16_t s = image->state(state), duration = image->u16(s);
    const bool loop = image->b(s + 12) & 1;
    const uint32_t first = loop ? lastTick / duration : 0, end = loop ? current / duration : 0;
    for (uint32_t cycle = first; cycle <= end; ++cycle) {
      for (uint16_t i = 0; i < image->irTimedCount(); ++i) {
        const uint16_t t = image->irTimed(i);
        if (image->b(t) != state) continue;
        const uint32_t at = cycle * duration + image->u16(t + 2);
        if (at > lastTick && at <= current && !enqueue(image->b(t + 1))) { lastTick = current; return; }
      }
      if (cycle - first >= 8 && cycle < end) { overflow = true; break; } // Bounded catch-up after host/clock jumps.
    }
    lastTick = current;
  }
  void learn(uint32_t now) { stop(); mode = 1; learnAt = now; }
  // Result: 0 pending, 1 capture, 2 malformed/repeat, 3 overflow, 4 timeout.
  uint8_t pollLearn(uint32_t now, uint32_t nowUs, bool audioStopped) {
    if (mode == 1 && audioStopped) { irDriver::armReceiver(pulses); mode = 2; learnAt = now; }
    if (mode != 2) return 0;
    uint8_t result = irDriver::capture.poll(nowUs);
    if (!result && now - learnAt >= 10000) result = 4;
    if (result) {
#if defined(ARDUINO)
      detachInterrupt(digitalPinToInterrupt(2));
#endif
      irDriver::capture.active = false; mode = 0;
    }
    return result;
  }
  bool stage(uint8_t kind, uint8_t count, uint8_t sendCount, uint16_t gapMs, uint32_t code) {
    if (!enabled() || kind > 1 || !sendCount || sendCount > 10 || gapMs < 50 || gapMs > 2000 || gapMs % 50 || (kind == 0 && count) || (kind == 1 && (count < 5 || count > 127 || !(count & 1) || code))) return false;
    stop(); mode = 3; repeats = sendCount; gap = gapMs;
    if (!kind) { nec(code); stagedExpected = stagedReceived = 0; }
    else { length = stagedExpected = count; stagedReceived = 0; }
    return true;
  }
  bool data(uint8_t offset, const uint8_t* values, uint8_t count) {
    if (mode != 3 || offset != stagedReceived || !count || count > 32 || count > stagedExpected - stagedReceived) return false;
    for (uint8_t i = 0; i < count; ++i) if (values[i] < 2) return false;
    for (uint8_t i = 0; i < count; ++i) pulses[stagedReceived++] = values[i];
    return true;
  }
  bool play(uint32_t now) {
    if (mode != 3 || stagedReceived != stagedExpected) return false;
    uint16_t ticks = 0; for (uint8_t i = 0; i < length; ++i) ticks += pulses[i];
    if (ticks > 4000) return false;
    mode = 4; job = true; wasSending = false; nextAt = now; return true;
  }
  void update(uint32_t now, bool transportIdle, bool sonarIdle) {
    if (!enabled() || mode == 1 || mode == 2 || mode == 3) return;
    if (transmitting()) return;
    if (gapPending && due(now, nextAt)) gapPending = false;
    if (wasSending) {
      wasSending = false;
      if (repeats) --repeats;
      nextAt = now + gap; gapPending = true;
      if (!repeats) { job = false; if (mode == 4) mode = 0; }
    }
    if (!job && queued) { load(queue[head]); head = (head + 1) & 7; --queued; job = true; if (!gapPending) nextAt = now; }
    if (job && due(now, nextAt) && transportIdle && sonarIdle) { gapPending = false; irDriver::send(pulses, length); wasSending = true; }
  }
};
}
