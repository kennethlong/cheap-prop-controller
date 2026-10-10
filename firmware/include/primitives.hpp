#pragma once
#include <stdint.h>

namespace cpc {
inline uint16_t crc16Byte(uint16_t crc, uint8_t byte) {
  crc ^= static_cast<uint16_t>(byte) << 8;
  for (uint8_t bit = 0; bit < 8; ++bit)
    crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021) : static_cast<uint16_t>(crc << 1);
  return crc;
}

// Caller supplies a logical active value. A held input must release before firing.
struct DebouncedInput {
  uint32_t changedAt;
  bool candidate;
  bool stable;
  bool ready;
  void reset(bool active, uint32_t now) {
    changedAt = now; candidate = stable = active; ready = !active;
  }
  bool update(bool active, uint32_t now, uint16_t debounceMs) {
    if (active != candidate) { candidate = active; changedAt = now; }
    if (candidate != stable && static_cast<uint32_t>(now - changedAt) >= debounceMs) {
      stable = candidate;
      if (!stable) ready = true;
      else if (ready) { ready = false; return true; }
    }
    return false;
  }
};

// DFPlayer uses a checksum; Catalex YX5300 accepts its documented 8-byte form.
// Playback uses folder 01 / 001...255.mp3 (0x0f), never FAT insertion order.
inline uint8_t audioPacket(bool dfPlayer, uint8_t command, uint16_t parameter, uint8_t* out) {
  out[0] = 0x7e; out[1] = 0xff; out[2] = 0x06; out[3] = command;
  out[4] = 0; out[5] = static_cast<uint8_t>(parameter >> 8); out[6] = static_cast<uint8_t>(parameter);
  if (!dfPlayer) { out[7] = 0xef; return 8; }
  uint16_t sum = 0;
  for (uint8_t i = 1; i <= 6; ++i) sum += out[i];
  const uint16_t checksum = static_cast<uint16_t>(0 - sum);
  out[7] = static_cast<uint8_t>(checksum >> 8); out[8] = static_cast<uint8_t>(checksum); out[9] = 0xef;
  return 10;
}
}
