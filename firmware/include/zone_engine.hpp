#pragma once
#include "scene_image.hpp"

namespace cpc {
// Samples, not loop iterations, advance dwell. Missing echoes cannot move a
// visitor into a different zone or complete a stale boundary candidate.
struct ZoneInput {
  enum { None = 255 };
  uint32_t changedAt;
  uint8_t current, candidate;
  bool initialized;
  void reset() { changedAt = 0; current = candidate = None; initialized = false; }
  bool sample(const SceneImage& image, uint8_t sensor, bool valid, uint16_t cm,
      uint32_t now, uint8_t& previous) {
    if (!valid || cm < 2 || cm > 400) { candidate = current; changedAt = now; return false; }
    uint8_t next = None;
    if (initialized && current != None) {
      const uint16_t z = image.zone(current), margin = image.b(z + 5);
      if (static_cast<int32_t>(cm) >= static_cast<int32_t>(image.u16(z + 1)) - margin
          && cm <= image.u16(z + 3) + margin) next = current;
    }
    if (next == None) for (uint8_t i = 0; i < image.zoneCount(); ++i) {
      const uint16_t z = image.zone(i);
      if (image.b(z) == sensor && cm >= image.u16(z + 1) && cm <= image.u16(z + 3)) { next = i; break; }
    }
    if (!initialized) { initialized = true; current = candidate = next; changedAt = now; return false; }
    if (next != candidate) { candidate = next; changedAt = now; }
    if (candidate == current || static_cast<uint32_t>(now - changedAt) < image.b(image.trigger(sensor) + 7) * 50U) return false;
    previous = current; current = candidate; return true;
  }
};
}
