#pragma once
#include <stdint.h>

namespace cpc {
// BUSY is evidence from the decoder, not an acknowledgement of a particular
// filename. A falling/rising pair is accepted only after a fresh PLAY. Missing
// cards and startup latency cannot accidentally produce a track-end event.
struct AudioFeedback {
  enum Status : uint8_t { Disabled = 0, Waiting = 1, Playing = 2, Finished = 3, Failed = 4, Stopped = 5 };
  uint32_t changedAt = 0, playAt = 0;
  uint8_t status = Disabled;
  bool candidate = false, stable = false;

  void reset(bool enabled) { status = enabled ? Stopped : Disabled; candidate = stable = false; }
  void start(uint32_t now) {
    if (status == Disabled) return;
    status = Waiting; changedAt = playAt = now; candidate = stable = false;
  }
  // The caller supplies logical active, independently of electrical polarity.
  bool sample(bool active, uint32_t now) {
    if (status != Waiting && status != Playing) return false;
    if (active != candidate) { candidate = active; changedAt = now; }
    if (candidate != stable && static_cast<uint32_t>(now - changedAt) >= 100) {
      stable = candidate;
      if (stable) status = Playing;
      else if (status == Playing) { status = Finished; return true; }
    }
    if (status == Waiting && static_cast<uint32_t>(now - playAt) >= 5000) status = Failed;
    return false;
  }
};
}
