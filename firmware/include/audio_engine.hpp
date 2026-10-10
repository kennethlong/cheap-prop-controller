#pragma once
#include <Arduino.h>
#include "scene_image.hpp"
#include "timer_uart.hpp"

namespace cpc {
// No acknowledgement is assumed. UART transport success is not proof of audible
// playback. Hardware measurements must establish decoder latency and fade quality.
class AudioEngine {
  struct Player {
    uint32_t fadeAt, nextCommand;
    uint16_t fadeMs;
    uint8_t kind, tx, track, volume, sentVolume, from, target, stage;
    bool loop, preserve, ambientRole;
  } players[MaxPlayers];
  uint8_t count = 0, packet[10], packetSize = 0, packetIndex = 0, packetPlayer = 0, scan = 0;
  const SceneImage* image = nullptr;

  static bool due(uint32_t now, uint32_t at) { return static_cast<int32_t>(now - at) >= 0; }
  bool sendByte(uint8_t index, uint8_t value) {
#if defined(__AVR_ATmega2560__)
    HardwareSerial* port = index == 0 ? &Serial1 : index == 1 ? &Serial2 : &Serial3;
    if (!port->availableForWrite()) return false;
    port->write(value);
    return true;
#else
    return timerUart::write(players[index].tx, value);
#endif
  }
  void command(uint8_t index, uint8_t cmd, uint16_t parameter, uint32_t now) {
    packetPlayer = index; packetIndex = 0;
    packetSize = audioPacket(players[index].kind == 0, cmd, parameter, packet);
    players[index].nextCommand = now + 60;
  }
  void fade(uint8_t index, uint8_t target, uint16_t duration, uint32_t now, bool preserve) {
    Player& p = players[index];
    p.from = p.volume; p.target = target; p.fadeMs = duration; p.fadeAt = now; p.preserve = preserve;
  }
  void start(uint8_t index, uint8_t track, bool loop, uint8_t volume, uint16_t duration, uint32_t now, bool ambientRole, bool restart = false) {
    Player& p = players[index];
    if (p.track != track || p.loop != loop || p.ambientRole != ambientRole || restart) {
      p.track = track; p.loop = loop; p.ambientRole = ambientRole;
      if (p.stage >= 2) p.stage = 3;
      p.volume = p.from = 0; p.sentVolume = 255;
    }
    fade(index, volume, duration, now, false);
  }
 public:
  bool stopped() const {
    if (packetIndex < packetSize) return false;
#if !defined(__AVR_ATmega2560__)
    if (timerUart::busy()) return false;
#elif defined(ARDUINO)
    if (count > 0 && !(UCSR1A & _BV(TXC1))) return false;
    if (count > 1 && !(UCSR2A & _BV(TXC2))) return false;
    if (count > 2 && !(UCSR3A & _BV(TXC3))) return false;
#endif
    for (uint8_t i = 0; i < count; ++i)
      if (players[i].track || players[i].stage == 7) return false;
    return true;
  }
  void begin(const SceneImage* source, uint32_t now) {
#if !defined(__AVR_ATmega2560__)
    timerUart::begin();
#endif
    image = source; count = image->b(11); packetSize = packetIndex = scan = 0;
    for (uint8_t i = 0; i < count; ++i) {
      Player& p = players[i];
      p = Player{};
      const uint16_t address = image->player(i);
      p.kind = image->b(address); p.tx = image->b(address + 1); p.sentVolume = 255;
      p.nextCommand = now + 1600; // decoder power-up; scene/USB still run
#if defined(__AVR_ATmega2560__)
      HardwareSerial* port = i == 0 ? &Serial1 : i == 1 ? &Serial2 : &Serial3;
      port->begin(9600);
#else
      digitalWrite(p.tx, HIGH); pinMode(p.tx, OUTPUT);
      pinMode(image->b(address + 2), INPUT);
#endif
    }
  }
  void stop(uint32_t now) {
    // Finish a packet already in flight so subsequent STOP retains framing.
    for (uint8_t i = 0; i < count; ++i) {
      Player& p = players[i]; p.track = 0; p.stage = 7; p.target = p.volume = 0;
      p.nextCommand = now;
    }
  }
  void enter(uint8_t stateIndex, uint32_t now) {
    if (!count || !image) return;
    const uint16_t state = image->state(stateIndex);
    const uint8_t foreground = static_cast<uint8_t>(image->u16(state + 2));
    const uint8_t ambient = static_cast<uint8_t>(image->u16(14));
    const bool persistent = (image->b(16) & 1) && ambient;
    const uint16_t fadeMs = image->b(17) * 50U;
    if (!foreground) {
      int8_t ambientPlayer = -1;
      if (ambient) {
        if (persistent) ambientPlayer = 0;
        else for (uint8_t i = 0; i < count; ++i) if (players[i].track == ambient && players[i].ambientRole) { ambientPlayer = i; break; }
        if (ambientPlayer < 0) {
          ambientPlayer = 0;
          for (uint8_t i = 0; i < count; ++i) if (!players[i].track) { ambientPlayer = i; break; }
        }
      }
      for (uint8_t i = 0; i < count; ++i) {
        if (i == ambientPlayer) start(i, ambient, true, image->b(18), fadeMs, now, true);
        else fade(i, 0, fadeMs, now, false);
      }
      return;
    }
    if (persistent) {
      if (players[0].track != ambient) start(0, ambient, true, 0, 0, now, true);
      fade(0, 0, fadeMs, now, true);
    }
    const uint8_t first = persistent ? 1 : 0;
    uint8_t chosen = first;
    // Prefer an idle decoder; otherwise reuse the quietest, deterministically.
    for (uint8_t i = first; i < count; ++i) {
      if (!players[i].track) { chosen = i; break; }
      if (players[i].volume < players[chosen].volume) chosen = i;
    }
    for (uint8_t i = first; i < count; ++i)
      if (i != chosen) fade(i, 0, fadeMs, now, false);
    start(chosen, foreground, image->b(state + 12) & 2, image->b(state + 11), fadeMs, now, false, true);
  }
  void update(uint32_t now, bool timingCritical) {
    if (packetIndex < packetSize) {
      if (!timingCritical && sendByte(packetPlayer, packet[packetIndex])) ++packetIndex;
      return;
    }
    for (uint8_t n = 0; n < count; ++n) {
      const uint8_t i = scan++ % count;
      Player& p = players[i];
      if (!due(now, p.nextCommand)) continue;
      // Initialization does not reset the decoder; only select SD and stop.
      if (p.stage == 0) { command(i, 0x09, 2, now); p.stage = 1; p.nextCommand = now + 250; return; }
      if (p.stage == 1) { command(i, 0x16, 0, now); p.stage = p.track ? 3 : 2; return; }
      if (p.stage == 3) { command(i, 0x06, 0, now); p.sentVolume = 0; p.stage = 4; return; }
      if (p.stage == 4) { command(i, 0x0f, 0x0100 | p.track, now); p.stage = 5; return; }
      if (p.stage == 5) { command(i, 0x19, p.loop ? 0 : 1, now); p.stage = 2; p.fadeAt = now; return; }
      if (p.stage == 7) { command(i, 0x16, 0, now); p.stage = 2; p.track = 0; return; }
      if (!p.track) continue;
      const uint32_t elapsed = now - p.fadeAt;
      p.volume = (!p.fadeMs || elapsed >= p.fadeMs) ? p.target : static_cast<uint8_t>(static_cast<int32_t>(p.from) + (static_cast<int32_t>(p.target) - p.from) * static_cast<int32_t>(elapsed) / p.fadeMs);
      if (p.sentVolume != p.volume) { command(i, 0x06, p.volume, now); p.sentVolume = p.volume; return; }
      if (!p.volume && !p.target && !p.preserve) { command(i, 0x16, 0, now); p.track = 0; return; }
    }
  }
};
}
