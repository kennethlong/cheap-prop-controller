#pragma once
#include <stdint.h>
#include "primitives.hpp"

namespace cpc {
enum { HeaderSize = 32, MaxOutputs = 32, MaxTriggers = 8, MaxPlayers = 3, MaxStates = 8 };
typedef uint8_t (*ReadByte)(uint16_t);

struct SceneImage {
  ReadByte read;
  uint8_t b(uint16_t offset) const { return read(offset); }
  uint16_t u16(uint16_t offset) const { return static_cast<uint16_t>(b(offset)) | static_cast<uint16_t>(b(offset + 1)) << 8; }
  uint8_t ambientMixVolume() const { return (b(16) >> 2) & 31; }
  uint16_t output(uint8_t index) const { return u16(20) + index * 2; }
  uint16_t trigger(uint8_t index) const { return u16(22) + index * 8; }
  uint16_t player(uint8_t index) const { return u16(24) + index * 4; }
  uint16_t state(uint8_t index) const { return u16(26) + index * 16; }
  uint16_t event(uint16_t index) const { return u16(28) + index * 6; }
  uint16_t transition(uint16_t index) const { return u16(30) + index * 2; }
  uint16_t crc(uint16_t length) const {
    uint16_t value = 0xffff;
    for (uint16_t i = 0; i < length; ++i) value = crc16Byte(value, i == 6 || i == 7 ? 0 : b(i));
    return value;
  }
  bool claimPin(uint8_t pin, uint8_t board, uint8_t* used) const {
    if (pin < 2 || pin >= (board == 4 ? 70 : 20)) return false;
    const uint8_t mask = 1 << (pin & 7);
    if (used[pin >> 3] & mask) return false;
    used[pin >> 3] |= mask;
    return true;
  }
  // Validate every offset before dereferencing record data. Firmware never trusts
  // the editor: CRC, board, counts, layout, pin ownership and event bounds agree.
  bool valid(uint16_t capacity, uint8_t board, bool checkCrc = true) const {
    if (b(0) != 'C' || b(1) != 'P' || b(2) != 'C' || b(3) != '1') return false;
    const uint16_t length = u16(4);
    if (length < HeaderSize || length > capacity || b(8) != board) return false;
    if (b(9) > MaxOutputs || b(10) > MaxTriggers || b(11) > MaxPlayers || !b(12) || b(12) > MaxStates || b(13) >= b(12)) return false;
    if (u16(14) > 255 || (b(16) & 128) || ambientMixVolume() > 30 || b(18) > 30 || (!(b(16) & 2) && b(19))) return false;
    if (ambientMixVolume() && (!(b(16) & 1) || !u16(14))) return false;
    uint16_t offset = HeaderSize;
    if (u16(20) != offset) return false;
    offset += b(9) * 2;
    if (u16(22) != offset) return false;
    offset += b(10) * 8;
    if (u16(24) != offset) return false;
    offset += b(11) * 4;
    if (u16(26) != offset) return false;
    offset += b(12) * 16;
    if (u16(28) != offset || offset > length || u16(30) < offset || u16(30) > length || (u16(30) - offset) % 6 || (length - u16(30)) % 2) return false;
    uint8_t used[9] = {0};
    for (uint8_t i = 0; i < b(9); ++i) {
      const uint16_t p = output(i);
      if (b(p + 1) > 3 || !claimPin(b(p), board, used)) return false;
    }
    for (uint8_t i = 0; i < b(10); ++i) {
      const uint16_t p = trigger(i);
      if (b(p) > 2 || b(p + 3) > 3 || !claimPin(b(p + 1), board, used)) return false;
      if (b(p) == 2) {
        if (!claimPin(b(p + 2), board, used) || u16(p + 4) < 2 || u16(p + 4) > 400 || !b(p + 6) || u16(p + 4) + b(p + 6) > 400 || b(p + 3)) return false;
      } else if (b(p + 2) != 255) return false;
    }
    for (uint8_t i = 0; i < b(11); ++i) {
      const uint16_t p = player(i);
      if (b(p) > 1 || b(p + 3) || !claimPin(b(p + 1), board, used) || !claimPin(b(p + 2), board, used)) return false;
      if (board == 4 && (b(p + 1) != 18 - 2 * i || b(p + 2) != 19 - 2 * i)) return false;
    }
    const uint16_t totalEvents = (u16(30) - u16(28)) / 6;
    const uint16_t totalTransitions = (length - u16(30)) / 2;
    uint16_t eventsSeen = 0, transitionsSeen = 0;
    bool hasForeground = false, multipleForeground = false;
    uint8_t firstForeground = 0;
    for (uint8_t i = 0; i < b(12); ++i) {
      const uint16_t p = state(i), count = u16(p + 6);
      if (!u16(p) || u16(p + 2) > 255 || u16(p + 4) != eventsSeen || count > totalEvents - eventsSeen || u16(p + 8) != transitionsSeen || b(p + 10) > totalTransitions - transitionsSeen || b(p + 11) > 30 || b(p + 12) > 3 || b(p + 13) || b(p + 14) || b(p + 15)) return false;
      hasForeground |= u16(p + 2) != 0;
      if (u16(p + 2)) {
        if (firstForeground && firstForeground != u16(p + 2)) multipleForeground = true;
        firstForeground = static_cast<uint8_t>(u16(p + 2));
      }
      uint16_t previousStart = 0;
      uint8_t previousOutput = 0;
      for (uint16_t j = 0; j < count; ++j) {
        const uint16_t e = event(eventsSeen + j);
        if (u16(e) >= u16(e + 2) || u16(e + 2) > u16(p) || b(e + 4) >= b(9) || b(e + 5)) return false;
        if (j && (u16(e) < previousStart || (u16(e) == previousStart && b(e + 4) < previousOutput))) return false;
        previousStart = u16(e); previousOutput = b(e + 4);
        for (uint16_t k = 0; k < j; ++k) {
          const uint16_t earlier = event(eventsSeen + k);
          if (b(earlier + 4) == b(e + 4) && u16(earlier + 2) > u16(e)) return false;
        }
      }
      uint8_t transitionTriggers = 0;
      for (uint8_t j = 0; j < b(p + 10); ++j) {
        const uint16_t t = transition(transitionsSeen + j);
        if (b(t) >= b(10) || b(t + 1) >= b(12) || (transitionTriggers & (1 << b(t)))) return false;
        transitionTriggers |= 1 << b(t);
      }
      eventsSeen += count; transitionsSeen += b(p + 10);
    }
    if (eventsSeen != totalEvents || transitionsSeen != totalTransitions) return false;
    uint8_t requiredPlayers = (hasForeground || u16(14)) ? 1 : 0;
    const bool crossfade = !(b(16) & 2) && b(17);
    if (hasForeground && u16(14) && (b(16) & 1)) requiredPlayers = crossfade && multipleForeground ? 3 : 2;
    else if (hasForeground && crossfade && (u16(14) || multipleForeground)) requiredPlayers = 2;
    if (b(11) < requiredPlayers) return false;
    if (u16(state(b(13)) + 2)) return false; // The initial state is ambient only.
    return !checkCrc || crc(length) == u16(6);
  }
};

struct SceneRuntime {
  const SceneImage* image;
  uint32_t enteredAt;
  uint8_t currentState;
  bool running;
  void begin(const SceneImage* source) { image = source; enteredAt = 0; currentState = 0; running = false; }
  void enter(uint8_t stateIndex, uint32_t now) { currentState = stateIndex; enteredAt = now; }
  void run(uint32_t now) { running = true; enter(image->b(13), now); }
  void stop() { running = false; }
  bool trigger(uint8_t edges, uint32_t now) {
    if (!running) return false;
    const uint16_t s = image->state(currentState);
    for (uint8_t i = 0; i < image->b(s + 10); ++i) {
      const uint16_t t = image->transition(image->u16(s + 8) + i);
      if (edges & (1 << image->b(t))) { enter(image->b(t + 1), now); return true; }
    }
    return false;
  }
  uint32_t activeOutputs(uint32_t now) const {
    if (!running) return 0;
    uint32_t mask = 0;
    for (uint8_t i = 0; i < image->b(9); ++i)
      if (image->b(image->output(i) + 1) & 2) mask |= static_cast<uint32_t>(1) << i;
    const uint16_t s = image->state(currentState), duration = image->u16(s);
    uint32_t tick = static_cast<uint32_t>(now - enteredAt) / 50;
    if (image->b(s + 12) & 1) tick %= duration;
    else if (tick >= duration) return mask;
    for (uint16_t i = 0; i < image->u16(s + 6); ++i) {
      const uint16_t e = image->event(image->u16(s + 4) + i);
      if (tick >= image->u16(e) && tick < image->u16(e + 2)) mask |= static_cast<uint32_t>(1) << image->b(e + 4);
    }
    return mask;
  }
};
}
