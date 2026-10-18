#pragma once
#include <stdint.h>
#include "primitives.hpp"

namespace cpc {
enum { HeaderSize = 32, MaxOutputs = 32, MaxTriggers = 8, MaxPlayers = 3, MaxStates = 8, MaxZones = 32, MaxZoneActions = 64 };
typedef uint8_t (*ReadByte)(uint16_t);

struct SceneImage {
  ReadByte read;
  uint8_t b(uint16_t offset) const { return read(offset); }
  bool sceneControls() const { return b(3) != '1'; }
  bool child(uint8_t index) const { return b(state(index) + 12) & 4; }
  uint16_t u16(uint16_t offset) const { return static_cast<uint16_t>(b(offset)) | static_cast<uint16_t>(b(offset + 1)) << 8; }
  uint8_t ambientMixVolume() const { return (b(16) >> 2) & 31; }
  bool hasZones() const { return b(16) & 128; }
  uint16_t zoneFooter() const { return u16(4) - 8; }
  uint8_t zoneCount() const { return hasZones() ? b(zoneFooter() + 3) : 0; }
  uint16_t actionCount() const { return hasZones() ? u16(zoneFooter() + 4) : 0; }
  uint16_t transitionEnd() const { return hasZones() ? u16(zoneFooter() + 6) : u16(4); }
  uint16_t zone(uint8_t index) const { return transitionEnd() + index * 10; }
  uint16_t zoneAction(uint8_t index) const { return transitionEnd() + zoneCount() * 10 + index * 6; }
  bool hasIr() const { return hasZones() && u16(4) >= HeaderSize + 16 && b(zoneFooter() + 2) == 2; }
  uint16_t irFooter() const { return zoneFooter() - 8; }
  uint8_t irCommandCount() const { return hasIr() ? b(irFooter() + 2) : 0; }
  uint16_t irTimedCount() const { return hasIr() ? u16(irFooter() + 4) : 0; }
  uint16_t irTimed(uint16_t i) const { return zoneAction(static_cast<uint8_t>(actionCount())) + i * 4; }
  uint16_t irCommand(uint8_t i) const { return irTimed(irTimedCount()) + i * 12; }
  uint16_t irRaw() const { return irCommand(irCommandCount()); }
  bool zonedTrigger(uint8_t index) const {
    for (uint8_t i = 0; i < zoneCount(); ++i) if (b(zone(i)) == index) return true;
    return false;
  }
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
  bool claimFeedback(uint8_t pin, uint8_t board, uint8_t* used) const {
    if ((board == 2 || board == 3) && (pin == 20 || pin == 21)) {
      const uint8_t mask = 1 << (pin & 7);
      if (used[pin >> 3] & mask) return false;
      used[pin >> 3] |= mask; return true;
    }
    return claimPin(pin, board, used);
  }
  // Validate every offset before dereferencing record data. Firmware never trusts
  // the editor: CRC, board, counts, layout, pin ownership and event bounds agree.
  bool valid(uint16_t capacity, uint8_t board, bool checkCrc = true) const {
    if (b(0) != 'C' || b(1) != 'P' || b(2) != 'C' || b(3) < '1' || b(3) > '3') return false;
    const uint16_t length = u16(4);
    if (length < HeaderSize || length > capacity || b(8) != board) return false;
    if (b(9) > MaxOutputs || b(10) > MaxTriggers || b(11) > MaxPlayers || !b(12) || b(12) > MaxStates || b(13) >= b(12)) return false;
    if (u16(14) > 255 || ambientMixVolume() > 30 || b(18) > 30 || (!(b(16) & 2) && b(19))) return false;
    if (ambientMixVolume() && (!(b(16) & 1) || !u16(14))) return false;
    if (hasZones()) {
      if (length < HeaderSize + 8) return false;
      const uint16_t footer = zoneFooter();
      if (b(footer) != 'Z' || b(footer + 1) != 'N' || (b(footer + 2) != 1 && b(footer + 2) != 2) || zoneCount() > MaxZones || actionCount() > MaxZoneActions) return false;
      uint32_t end = static_cast<uint32_t>(transitionEnd()) + zoneCount() * 10U + actionCount() * 6U;
      if (b(footer + 2) == 1) { if (!zoneCount() || end != footer) return false; }
      else {
        if (!hasIr() || irCommandCount() > 32 || irTimedCount() > 128 || b(irFooter() + 3)) return false;
        if (b(irFooter()) != (board == 4 ? 11 : 9) || b(irFooter() + 1) != 2) return false;
        end += irTimedCount() * 4U + irCommandCount() * 12U + u16(irFooter() + 6);
        if (end != irFooter()) return false;
      }
      if (transitionEnd() < HeaderSize || transitionEnd() > footer) return false;
    }
    uint16_t offset = HeaderSize;
    if (u16(20) != offset) return false;
    offset += b(9) * 2;
    if (u16(22) != offset) return false;
    offset += b(10) * 8;
    if (u16(24) != offset) return false;
    offset += b(11) * 4;
    if (u16(26) != offset) return false;
    offset += b(12) * 16;
    if (u16(28) != offset || offset > transitionEnd() || u16(30) < offset || u16(30) > transitionEnd() || (u16(30) - offset) % 6 || (transitionEnd() - u16(30)) % 2) return false;
    uint8_t used[9] = {0};
    if (hasIr() && (!claimPin(b(irFooter()), board, used) || !claimPin(b(irFooter() + 1), board, used))) return false;
    for (uint8_t i = 0; i < b(9); ++i) {
      const uint16_t p = output(i);
      if (b(p + 1) > 3 || !claimPin(b(p), board, used)) return false;
    }
    for (uint8_t i = 0; i < b(10); ++i) {
      const uint16_t p = trigger(i);
      if (b(p) >= 3) {
        // Timers and app-only triggers own no GPIO. A manual trigger has no
        // input flags, interval, threshold, hysteresis or debounce state.
        if (b(p) > 4 || !sceneControls() || b(p + 1) != 255 || b(p + 2) != 255 || b(p + 6) || b(p + 7)) return false;
        if (b(p) == 3 ? (b(p + 3) > 1 || !u16(p + 4)) : (b(p + 3) || u16(p + 4))) return false;
        continue;
      }
      if (b(p) > 2 || b(p + 3) > 3 || !claimPin(b(p + 1), board, used)) return false;
      if (b(p) == 2) {
        if (!claimPin(b(p + 2), board, used) || u16(p + 4) < 2 || u16(p + 4) > 400 || !b(p + 6) || u16(p + 4) + b(p + 6) > 400 || b(p + 3)) return false;
      } else if (b(p + 2) != 255) return false;
    }
    for (uint8_t i = 0; i < b(11); ++i) {
      const uint16_t p = player(i);
      if (b(p) > 1 || !claimPin(b(p + 1), board, used) || !claimPin(b(p + 2), board, used)) return false;
      if (b(p + 3) && (!sceneControls() || !(b(p + 3) & 127) || !claimFeedback((b(p + 3) & 127) - 1, board, used))) return false;
      if (board == 4 && (b(p + 1) != 18 - 2 * i || b(p + 2) != 19 - 2 * i)) return false;
    }
    const uint16_t totalEvents = (u16(30) - u16(28)) / 6;
    const uint16_t totalTransitions = (transitionEnd() - u16(30)) / 2;
    if (totalTransitions > 128) return false;
    uint16_t eventsSeen = 0, transitionsSeen = 0;
    bool hasForeground = false, multipleForeground = false;
    uint8_t firstForeground = 0;
    uint8_t owners[MaxOutputs];
    for (uint8_t i = 0; i < MaxOutputs; ++i) owners[i] = 255;
    for (uint8_t i = 0; i < b(12); ++i) {
      const uint16_t p = state(i), count = u16(p + 6);
      const bool isChild = child(i);
      if (!u16(p) || u16(p + 2) > 255 || u16(p + 4) != eventsSeen || count > totalEvents - eventsSeen || u16(p + 8) != transitionsSeen || b(p + 10) > totalTransitions - transitionsSeen || b(p + 11) > 30) return false;
      if (isChild) {
        if (b(3) != '3' || b(p + 12) != 4 || i == b(13) || !count || u16(p + 2) || b(p + 10) || b(p + 13)) return false;
      } else if (b(p + 12) > 3 || u16(p + 14)) return false;
      if (b(p + 13)) {
        if (!sceneControls() || b(p + 13) > b(12) || child(b(p + 13) - 1) || i == b(13) || !u16(p + 2) || (b(p + 12) & 2)) return false;
        for (uint8_t j = 0; j < b(11); ++j) if (!b(player(j) + 3)) return false;
      }
      hasForeground |= u16(p + 2) != 0;
      if (u16(p + 2)) {
        if (firstForeground && firstForeground != u16(p + 2)) multipleForeground = true;
        firstForeground = static_cast<uint8_t>(u16(p + 2));
      }
      uint16_t previousStart = 0;
      uint8_t previousOutput = 0;
      for (uint16_t j = 0; j < count; ++j) {
        const uint16_t e = event(eventsSeen + j);
        if (u16(e) >= u16(e + 2) || u16(e + 2) > u16(p) || b(e + 4) >= b(9) || b(e + 5) > (sceneControls() ? 1 : 0)) return false;
        const uint8_t channel = b(e + 4), owner = isChild ? i : static_cast<uint8_t>(MaxStates);
        if ((owners[channel] != 255 && owners[channel] != owner) || (isChild && (b(output(channel) + 1) & 2))) return false;
        owners[channel] = owner;
        if (j && (u16(e) < previousStart || (u16(e) == previousStart && b(e + 4) < previousOutput))) return false;
        previousStart = u16(e); previousOutput = b(e + 4);
        for (uint16_t k = 0; k < j; ++k) {
          const uint16_t earlier = event(eventsSeen + k);
          if (b(earlier + 4) == b(e + 4) && u16(earlier + 2) > u16(e)) return false;
        }
      }
      uint16_t transitionTriggers = 0;
      uint8_t previousKey = 255, destinations = 0;
      for (uint8_t j = 0; j < b(p + 10); ++j) {
        const uint16_t t = transition(transitionsSeen + j);
        const uint8_t input = b(t) & 7, key = input + ((b(t) & 128) ? 8 : 0);
        if ((b(t) & 120) || input >= b(10) || b(t + 1) >= b(12)) return false;
        if ((b(t) & 128) && (!sceneControls() || b(trigger(input)) >= 3 || zonedTrigger(input))) return false;
        if (key == previousKey) { if (!sceneControls() || child(b(t + 1)) || child(b(t - 1))) return false; }
        else {
          if (transitionTriggers & (static_cast<uint16_t>(1) << key)) return false;
          transitionTriggers |= static_cast<uint16_t>(1) << key; destinations = 0; previousKey = key;
        }
        if (destinations & (1 << b(t + 1))) return false;
        destinations |= 1 << b(t + 1);
      }
      eventsSeen += count; transitionsSeen += b(p + 10);
    }
    if (eventsSeen != totalEvents || transitionsSeen != totalTransitions) return false;
    uint16_t actionsSeen = 0;
    for (uint8_t i = 0; i < zoneCount(); ++i) {
      const uint16_t z = zone(i);
      if (b(z) >= b(10) || b(trigger(b(z))) != 2 || (i && b(z) < b(zone(i - 1))) || u16(z + 1) < 2 || u16(z + 3) > 400 || u16(z + 1) > u16(z + 3) || !b(z + 5)) return false;
      for (uint8_t j = 0; j < i; ++j) {
        const uint16_t earlier = zone(j);
        if (b(earlier) == b(z) && u16(z + 1) <= u16(earlier + 3) && u16(earlier + 1) <= u16(z + 3)) return false;
      }
      for (uint8_t edge = 0; edge < 2; ++edge) {
        if (b(z + 6 + edge * 2) != actionsSeen || b(z + 7 + edge * 2) > actionCount() - actionsSeen) return false;
        actionsSeen += b(z + 7 + edge * 2);
      }
    }
    if (actionsSeen != actionCount()) return false;
    for (uint8_t i = 0; i < actionCount(); ++i) {
      const uint16_t a = zoneAction(i);
      if (b(a) == 0) {
        if (b(a + 1) >= b(12) || child(b(a + 1)) || u16(a + 2) || u16(a + 4)) return false;
      } else if (b(a) == 1) {
        if (b(a + 1) > 1 || u16(a + 2) > 30 || u16(a + 4) > 255) return false;
      } else if (b(a) == 2) {
        if (!hasIr() || b(a + 1) >= irCommandCount() || u16(a + 2) || u16(a + 4)) return false;
      } else return false;
    }
    if (hasIr()) {
      uint16_t rawSeen = 0;
      for (uint8_t i = 0; i < irCommandCount(); ++i) {
        const uint16_t c = irCommand(i);
        if (b(c) > 1 || b(c + 1) != 38 || !b(c + 2) || b(c + 2) > 10 || b(c + 3) || u16(c + 10) || u16(c + 8) < 50 || u16(c + 8) > 2000 || u16(c + 8) % 50) return false;
        if (b(c) == 1) {
          const uint16_t count = u16(c + 6);
          if (u16(c + 4) != rawSeen || count < 5 || count > 127 || !(count & 1) || count > u16(irFooter() + 6) - rawSeen) return false;
          uint16_t ticks = 0;
          for (uint8_t j = 0; j < count; ++j) { const uint8_t value = b(irRaw() + rawSeen + j); if (value < 2) return false; ticks += value; }
          if (ticks > 4000) return false;
          rawSeen += count;
        }
      }
      if (rawSeen != u16(irFooter() + 6)) return false;
      for (uint16_t i = 0; i < irTimedCount(); ++i) {
        const uint16_t t = irTimed(i);
        if (b(t) >= b(12) || child(b(t)) || b(t + 1) >= irCommandCount() || u16(t + 2) >= u16(state(b(t)))) return false;
        if (i) { const uint16_t prev = irTimed(i - 1); if (b(t) < b(prev) || (b(t) == b(prev) && u16(t + 2) < u16(prev + 2))) return false; }
      }
    }
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
  uint8_t roundRobin[MaxStates][16];
  uint32_t timerAt[MaxTriggers];
  uint32_t childAt[MaxStates];
  uint8_t busyChildren, childActiveMask;
  void begin(const SceneImage* source) { image = source; enteredAt = 0; currentState = 0; running = false; busyChildren = childActiveMask = 0; }
  void enter(uint8_t stateIndex, uint32_t now) { currentState = stateIndex; enteredAt = now; }
  void run(uint32_t now) {
    for (uint8_t s = 0; s < MaxStates; ++s) for (uint8_t k = 0; k < 16; ++k) roundRobin[s][k] = 0;
    for (uint8_t i = 0; i < MaxTriggers; ++i) timerAt[i] = now;
    busyChildren = childActiveMask = 0; running = true; enter(image->b(13), now);
  }
  void stop() { running = false; busyChildren = childActiveMask = 0; }
  void updateChildren(uint32_t now) {
    childActiveMask = 0;
    for (uint8_t i = 0, bit = 1; i < MaxStates; ++i, bit <<= 1) if (busyChildren & bit) {
      const uint16_t s = image->state(i);
      const uint32_t elapsed = now - childAt[i], duration = image->u16(s) * 50UL;
      if (elapsed < duration) childActiveMask |= bit;
      else if (elapsed - duration >= image->u16(s + 14) * 50UL) busyChildren &= ~bit;
    }
  }
  uint8_t activeChildren() const { return childActiveMask; }
  uint8_t coolingChildren() const { return busyChildren & ~childActiveMask; }
  void resetExternalTimers(uint32_t now) {
    if (!running) return;
    for (uint8_t i = 0; i < image->b(10); ++i) {
      const uint16_t p = image->trigger(i);
      if (image->b(p) == 3 && (image->b(p + 3) & 1)) timerAt[i] = now;
    }
  }
  uint8_t timerEdges(uint32_t now, bool externalActivation = false) {
    if (!running) return 0;
    if (externalActivation) resetExternalTimers(now);
    uint8_t edges = 0;
    for (uint8_t i = 0; i < image->b(10); ++i) {
      const uint16_t p = image->trigger(i);
      if (image->b(p) == 3 && static_cast<uint32_t>(now - timerAt[i]) >= image->u16(p + 4) * 50UL) { timerAt[i] = now; edges |= 1 << i; }
    }
    return edges;
  }
  bool trigger(uint8_t edges, uint32_t now, uint8_t releases = 0) {
    if (!running) return false;
    updateChildren(now);
    const uint16_t s = image->state(currentState);
    uint8_t nextState = 255;
    for (uint8_t i = 0; i < image->b(s + 10);) {
      const uint16_t t = image->transition(image->u16(s + 8) + i);
      const uint8_t wire = image->b(t), key = (wire & 7) + ((wire & 128) ? 8 : 0);
      uint8_t count = 1;
      while (i + count < image->b(s + 10) && image->b(image->transition(image->u16(s + 8) + i + count)) == wire) ++count;
      if (((wire & 128) ? releases : edges) & (1 << (wire & 7))) {
        uint8_t& cursor = roundRobin[currentState][key];
        const uint8_t target = image->b(image->transition(image->u16(s + 8) + i + cursor) + 1);
        if (image->child(target)) {
          if (!(busyChildren & (1 << target))) { childAt[target] = now; busyChildren |= 1 << target; childActiveMask |= 1 << target; }
        } else if (nextState == 255) { cursor = (cursor + 1) % count; nextState = target; }
      }
      i += count;
    }
    // All matching children belong to the original main state. Changing the
    // parent never restarts a child, and a child never signals an audio entry.
    if (nextState == 255) return false;
    enter(nextState, now); return true;
  }
  uint32_t stateOutputs(uint8_t index, uint32_t elapsed, uint32_t mask) const {
    const uint16_t s = image->state(index), duration = image->u16(s);
    uint32_t tick = elapsed / 50;
    if (image->b(s + 12) & 1) tick %= duration;
    else if (tick >= duration) return mask;
    for (uint16_t i = 0; i < image->u16(s + 6); ++i) {
      const uint16_t e = image->event(image->u16(s + 4) + i);
      if (tick >= image->u16(e) && tick < image->u16(e + 2)) {
        const uint32_t bit = static_cast<uint32_t>(1) << image->b(e + 4);
        if (image->b(e + 5)) mask &= ~bit; else mask |= bit;
      }
    }
    return mask;
  }
  uint32_t activeOutputs(uint32_t now) {
    if (!running) return 0;
    updateChildren(now);
    uint32_t mask = 0;
    for (uint8_t i = 0; i < image->b(9); ++i)
      if (image->b(image->output(i) + 1) & 2) mask |= static_cast<uint32_t>(1) << i;
    mask = stateOutputs(currentState, now - enteredAt, mask);
    for (uint8_t i = 0, bit = 1; i < MaxStates; ++i, bit <<= 1) if (childActiveMask & bit)
      mask = stateOutputs(i, now - childAt[i], mask);
    return mask;
  }
};
}
