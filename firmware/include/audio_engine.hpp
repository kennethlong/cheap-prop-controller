#pragma once
#include <Arduino.h>
#include "scene_image.hpp"
#include "timer_uart.hpp"
#include "audio_feedback.hpp"

namespace cpc {
// No acknowledgement is assumed. UART transport success is not proof of audible
// playback. Hardware measurements must establish decoder latency and fade quality.
class AudioEngine {
  struct Player {
    uint32_t fadeAt, nextCommand;
    uint16_t fadeMs;
    uint8_t kind, tx, track, volume, sentVolume, from, target, stage, generation;
    bool loop, preserve, ambientRole, feedbackEnabled;
  } players[MaxPlayers];
  AudioFeedback feedback[MaxPlayers];
  uint8_t count = 0, packet[10], packetSize = 0, packetIndex = 0, packetPlayer = 0, scan = 0;
  uint8_t pendingState = 0;
  uint8_t transmitted = 0;
  int8_t ambientPlayer = -1, foregroundPlayer = -1;
  uint8_t ambientOverride = 255, foregroundOverride = 255;
  uint16_t ambientOverrideMs = 0, foregroundOverrideMs = 0;
  bool fadeThroughPending = false;
  bool foregroundFinished = false;
  uint8_t packetGeneration = 0, feedbackPending = 0;
  const SceneImage* image = nullptr;

  static bool due(uint32_t now, uint32_t at) { return static_cast<int32_t>(now - at) >= 0; }
  bool sendByte(uint8_t index, uint8_t value) {
#if defined(__AVR_ATmega2560__)
    HardwareSerial* port = index == 0 ? &Serial1 : index == 1 ? &Serial2 : &Serial3;
    if (!port->availableForWrite()) return false;
    transmitted |= 1 << index;
    port->write(value);
    return true;
#else
    return timerUart::write(players[index].tx, value);
#endif
  }
  void command(uint8_t index, uint8_t cmd, uint16_t parameter) {
    packetPlayer = index; packetIndex = 0;
    packetGeneration = players[index].generation;
    packetSize = audioPacket(players[index].kind == 0, cmd, parameter, packet);
  }
  void fade(uint8_t index, uint8_t target, uint16_t duration, uint32_t now, bool preserve) {
    Player& p = players[index];
    if (p.stage == 2 && !packetIndex && packetSize && packetPlayer == index && packet[3] == 0x06) {
      packetSize = 0; p.sentVolume = 255;
    }
    p.from = p.volume; p.target = target; p.fadeMs = duration; p.fadeAt = now; p.preserve = preserve;
  }
  void start(uint8_t index, uint8_t track, bool loop, uint8_t volume, uint16_t duration, uint32_t now, bool ambientRole, bool restart = false) {
    Player& p = players[index];
    if (p.track != track || p.loop != loop || p.ambientRole != ambientRole || restart) {
      ++p.generation; feedbackPending &= ~(1 << index); feedback[index].reset(p.feedbackEnabled);
      p.track = track; p.loop = loop; p.ambientRole = ambientRole;
      if (p.stage >= 2) p.stage = 3;
      p.volume = p.from = 0; p.sentVolume = 255;
    }
    // Active roles keep their playhead at zero. Only a retiring voice is stopped.
    fade(index, volume, duration, now, true);
  }
  void cancelUnsentStart(bool preserveAmbient = false) {
    // Never truncate a packet that has entered the UART. A complete PLAY packet
    // already on the wire cannot be recalled; it is followed by mute/STOP.
    if (!packetIndex && packetSize && (packet[3] == 0x0f || packet[3] == 0x19)
        && !(preserveAmbient && packetPlayer == 0 && players[0].ambientRole)) packetSize = 0;
  }
  void retargetAmbient(uint8_t volume, uint16_t duration, uint32_t now) {
    Player& p = players[0];
    const uint8_t ambient = static_cast<uint8_t>(image->u16(14));
    if (p.track != ambient || !p.ambientRole || !p.loop)
      start(0, ambient, true, volume, duration, now, true);
    else if (p.target != volume) fade(0, volume, duration, now, true);
    // Foreground transitions must neither restart an existing ambient fade nor
    // stop its decoder, including when normal ambient volume is zero.
    p.preserve = true;
  }
  bool independentAmbient() const {
    return image->ambientMixVolume() || (ambientOverride != 255 && (image->b(16) & 1) && image->u16(14));
  }
  void requestFadeThrough(uint8_t stateIndex, uint32_t now) {
    pendingState = stateIndex;
    const bool mixed = image->ambientMixVolume() != 0;
    const bool persistent = (image->b(16) & 1) && image->u16(14);
    if (mixed) {
      const bool foreground = image->u16(image->state(stateIndex) + 2) != 0;
      retargetAmbient(foreground ? image->ambientMixVolume() : image->b(18),
        image->b(foreground ? 19 : 17) * 50U, now);
    }
    if (fadeThroughPending) {
      // A new state clears volume overrides, including an ambient override
      // applied while an earlier foreground handoff was pending.
      if (persistent && !mixed && players[0].target) fade(0, 0, image->b(19) * 50U, now, true);
      return; // Latest target wins without extending the outgoing foreground fade.
    }
    fadeThroughPending = true;
    const uint16_t duration = image->b(19) * 50U;
    cancelUnsentStart(persistent);
    for (uint8_t i = 0; i < count; ++i) {
      if (mixed && i == 0) continue; // Ambient runs independently of the foreground handoff.
      Player& p = players[i];
      const bool preserve = persistent && i == 0 && p.ambientRole;
      // A decoder still starting a superseded foreground must never proceed to
      // its pending PLAY/loop commands. Its zero-volume playback, if already
      // sent, is stopped below. An ambient startup is retained for persistence.
      if (!preserve) {
        if (p.stage < 2) p.track = 0;
        else if (p.stage >= 3 && p.stage <= 5) p.stage = 2;
      }
      fade(i, 0, duration, now, preserve);
    }
  }
  bool readyForFadeThrough() const {
    if (packetSize) return false;
#if !defined(__AVR_ATmega2560__)
    if (timerUart::busy()) return false;
#elif defined(ARDUINO)
    if (count > 0 && !independentAmbient() && !(UCSR1A & _BV(TXC1))) return false;
    if (count > 1 && !(UCSR2A & _BV(TXC2))) return false;
    if (count > 2 && !(UCSR3A & _BV(TXC3))) return false;
#endif
    for (uint8_t i = 0; i < count; ++i) {
      if (i == 0 && independentAmbient()) continue;
      const Player& p = players[i];
      if (p.stage != 2 || p.volume || (p.track && (!p.preserve || p.sentVolume))) return false;
    }
    return true;
  }
  void applyFadeThrough(uint32_t now) {
    fadeThroughPending = false;
    const uint16_t state = image->state(pendingState);
    const uint8_t foreground = static_cast<uint8_t>(image->u16(state + 2));
    const uint8_t ambient = static_cast<uint8_t>(image->u16(14));
    const bool persistent = (image->b(16) & 1) && ambient;
    const uint16_t duration = image->b(17) * 50U;
    const uint8_t ambientVolume = ambientOverride == 255 ? image->b(18) : ambientOverride;
    const uint8_t foregroundVolume = foregroundOverride == 255 ? image->b(state + 11) : foregroundOverride;
    const uint16_t ambientDuration = ambientOverride == 255 ? duration : ambientOverrideMs;
    const uint16_t foregroundDuration = foregroundOverride == 255 ? duration : foregroundOverrideMs;
    ambientPlayer = foregroundPlayer = -1;
    if (independentAmbient()) {
      // Ambient was retargeted at state entry; only foreground waits for silence.
      ambientPlayer = 0;
      if (foreground) { foregroundPlayer = 1; start(1, foreground, image->b(state + 12) & 2,
        foregroundVolume, foregroundDuration, now, false, true); }
      return;
    }
    if (!foreground) {
      if (ambient) { ambientPlayer = 0; start(0, ambient, true, ambientVolume, ambientDuration, now, true); }
      return;
    }
    if (persistent) {
      ambientPlayer = 0;
      start(0, ambient, true, 0, 0, now, true);
      fade(0, 0, 0, now, true);
    }
    foregroundPlayer = persistent ? 1 : 0;
    start(foregroundPlayer, foreground, image->b(state + 12) & 2,
      foregroundVolume, foregroundDuration, now, false, true);
  }
 public:
  void pollFeedbackReady(uint32_t now) {
    if (feedbackPending && transportIdle()) {
      for (uint8_t i = 0; i < count; ++i) if (feedbackPending & (1 << i)) feedback[i].start(now);
      feedbackPending = 0;
    }
  }
  uint8_t feedbackStatus(uint8_t index) const { return feedback[index].status; }
  void sampleFeedback(uint8_t index, bool active, uint32_t now) {
    if (feedback[index].sample(active, now) && index == foregroundPlayer && !players[index].loop && !players[index].ambientRole && !fadeThroughPending)
      foregroundFinished = true;
  }
  bool takeForegroundFinished() { const bool result = foregroundFinished; foregroundFinished = false; return result; }
  bool transportIdle() const {
    if (packetIndex < packetSize) return false;
#if !defined(__AVR_ATmega2560__)
    if (timerUart::busy()) return false;
#elif defined(ARDUINO)
    if ((transmitted & 1) && !(UCSR1A & _BV(TXC1))) return false;
    if ((transmitted & 2) && !(UCSR2A & _BV(TXC2))) return false;
    if ((transmitted & 4) && !(UCSR3A & _BV(TXC3))) return false;
#endif
    return true;
  }
  bool stopped() const {
    if (fadeThroughPending) return false;
    if (packetSize) return false;
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
    image = source; count = image->b(11); packetSize = packetIndex = scan = transmitted = feedbackPending = 0;
    ambientPlayer = foregroundPlayer = -1;
    ambientOverride = foregroundOverride = 255;
    fadeThroughPending = foregroundFinished = false;
    for (uint8_t i = 0; i < count; ++i) {
      Player& p = players[i];
      p = Player{};
      const uint16_t address = image->player(i);
      p.feedbackEnabled = image->b(address + 3) != 0; feedback[i].reset(p.feedbackEnabled);
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
    fadeThroughPending = foregroundFinished = false;
    feedbackPending = 0;
    ambientPlayer = foregroundPlayer = -1;
    ambientOverride = foregroundOverride = 255;
    cancelUnsentStart();
    if (!packetIndex && packetSize && packet[3] == 0x06) packetSize = 0;
    for (uint8_t i = 0; i < count; ++i) {
      Player& p = players[i]; p.track = 0; p.stage = 7; p.target = p.volume = 0;
      feedback[i].reset(p.feedbackEnabled);
      p.nextCommand = now;
    }
  }
  void enter(uint8_t stateIndex, uint32_t now) {
    foregroundFinished = false;
    if (!count || !image) return;
    ambientOverride = foregroundOverride = 255;
    ambientPlayer = foregroundPlayer = -1;
    if (image->b(16) & 2) { requestFadeThrough(stateIndex, now); return; }
    const uint16_t state = image->state(stateIndex);
    const uint8_t foreground = static_cast<uint8_t>(image->u16(state + 2));
    const uint8_t ambient = static_cast<uint8_t>(image->u16(14));
    const bool persistent = (image->b(16) & 1) && ambient;
    const uint16_t fadeMs = image->b(17) * 50U;
    if (!foreground) {
      if (ambient) {
        if (persistent) ambientPlayer = 0;
        else for (uint8_t i = 0; i < count; ++i) if (players[i].track == ambient && players[i].ambientRole) { ambientPlayer = i; break; }
        if (ambientPlayer < 0) {
          ambientPlayer = 0;
          for (uint8_t i = 0; i < count; ++i) if (!players[i].track) { ambientPlayer = i; break; }
        }
      }
      for (uint8_t i = 0; i < count; ++i) {
        if (i == ambientPlayer) {
          if (image->ambientMixVolume()) retargetAmbient(image->b(18), fadeMs, now);
          else start(i, ambient, true, image->b(18), fadeMs, now, true);
        }
        else fade(i, 0, fadeMs, now, false);
      }
      return;
    }
    if (persistent) {
      ambientPlayer = 0;
      if (image->ambientMixVolume()) retargetAmbient(image->ambientMixVolume(), fadeMs, now);
      else {
        if (players[0].track != ambient) start(0, ambient, true, 0, 0, now, true);
        fade(0, 0, fadeMs, now, true);
      }
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
    foregroundPlayer = chosen;
    start(chosen, foreground, image->b(state + 12) & 2, image->b(state + 11), fadeMs, now, false, true);
  }
  void volume(uint8_t role, uint8_t target, uint16_t duration, uint32_t now) {
    if (!image || !count || role > 1 || target > 30) return;
    int8_t player = role ? foregroundPlayer : ambientPlayer;
    if (fadeThroughPending) {
      const bool foreground = image->u16(image->state(pendingState) + 2) != 0;
      const bool persistent = (image->b(16) & 1) && image->u16(14);
      if (role) {
        if (!foreground) return;
        foregroundOverride = target; foregroundOverrideMs = duration;
        return; // The outgoing decoder must continue retiring toward silence.
      }
      if (!image->u16(14) || (foreground && !persistent)) return;
      ambientOverride = target; ambientOverrideMs = duration;
      if (!persistent) return; // A different track still occupies this decoder.
      retargetAmbient(target, duration, now); player = 0;
    }
    if (player < 0 || !players[player].track) return;
    fade(player, target, duration, now, true);
  }
  void update(uint32_t now, bool timingCritical) {
    if (packetIndex < packetSize) {
      if (!timingCritical && sendByte(packetPlayer, packet[packetIndex])) {
        ++packetIndex;
        if (packetIndex == packetSize && packet[3] == 0x0f && players[packetPlayer].track == packet[6] && players[packetPlayer].generation == packetGeneration)
          feedbackPending |= 1 << packetPlayer;
      }
      return;
    }
    if (packetSize) {
      // write() can enqueue bytes on Mega, and Timer2 still owns the last byte
      // on Uno. Anchor decoder recovery to observed completion on the wire;
      // USB/status or sensor stalls during a packet must not consume this gap.
      if (!transportIdle()) return;
      players[packetPlayer].nextCommand = now + (packet[3] == 0x09 ? 250U : 60U);
      packetSize = packetIndex = 0;
    }
    pollFeedbackReady(now);
    if (fadeThroughPending && readyForFadeThrough()) applyFadeThrough(now);
    for (uint8_t n = 0; n < count; ++n) {
      const uint8_t i = scan++ % count;
      Player& p = players[i];
      if (!due(now, p.nextCommand)) continue;
      // Initialization does not reset the decoder; only select SD and stop.
      if (p.stage == 0) { command(i, 0x09, 2); p.stage = 1; return; }
      if (p.stage == 1) { command(i, 0x16, 0); p.stage = p.track ? 3 : 2; return; }
      if (p.stage == 3) { command(i, 0x06, 0); p.sentVolume = 0; p.stage = 4; return; }
      if (p.stage == 4) { command(i, 0x0f, 0x0100 | p.track); p.stage = 5; return; }
      if (p.stage == 5) { command(i, 0x19, p.loop ? 0 : 1); p.stage = 2; p.fadeAt = now; return; }
      if (p.stage == 7) { command(i, 0x16, 0); p.stage = 2; p.track = 0; feedback[i].reset(p.feedbackEnabled); return; }
      if (!p.track) continue;
      const uint32_t elapsed = now - p.fadeAt;
      p.volume = (!p.fadeMs || elapsed >= p.fadeMs) ? p.target : static_cast<uint8_t>(static_cast<int32_t>(p.from) + (static_cast<int32_t>(p.target) - p.from) * static_cast<int32_t>(elapsed) / p.fadeMs);
      if (p.sentVolume != p.volume) { command(i, 0x06, p.volume); p.sentVolume = p.volume; return; }
      if (!p.volume && !p.target && !p.preserve) { command(i, 0x16, 0); p.track = 0; feedback[i].reset(p.feedbackEnabled); return; }
    }
  }
};
}
