#include <assert.h>
#include <stdio.h>
#include <string.h>
#define __AVR_ATmega2560__
#include "audio_engine.hpp"
HardwareSerial Serial1, Serial2, Serial3;
static uint8_t bytes[128];
static uint8_t read(uint16_t index) { assert(index < sizeof(bytes)); return bytes[index]; }
static cpc::SceneImage image{read};
static void word(uint16_t at, uint16_t value) { bytes[at] = value & 255; bytes[at + 1] = value >> 8; }
static void fixture() {
  memset(bytes, 0, sizeof(bytes));
  memcpy(bytes, "CPC1", 4); word(4, 92);
  bytes[8] = 4; bytes[11] = 3; bytes[12] = 3;
  word(14, 1); bytes[16] = 1; bytes[17] = 4; bytes[18] = 20;
  word(20, 32); word(22, 32); word(24, 32); word(26, 44); word(28, 92); word(30, 92);
  bytes[33] = 18; bytes[34] = 19;
  bytes[36] = 1; bytes[37] = 16; bytes[38] = 17;
  bytes[41] = 14; bytes[42] = 15;
  word(44, 100); word(60, 100); word(76, 100);
  word(62, 2); bytes[71] = 25; word(78, 3); bytes[87] = 30;
  word(6, image.crc(92)); assert(image.valid(4096, 4));
  Serial1 = HardwareSerial{}; Serial2 = HardwareSerial{}; Serial3 = HardwareSerial{};
}
static unsigned commands(const HardwareSerial& port, uint8_t command, int parameter = -1) {
  unsigned result = 0;
  for (size_t i = 0; i < port.bytes.size();) {
    assert(port.bytes[i] == 0x7e);
    const size_t length = (&port == &Serial2) ? 8 : 10;
    if (i + length > port.bytes.size()) break;
    assert(port.bytes[i + length - 1] == 0xef);
    const int value = (port.bytes[i + 5] << 8) | port.bytes[i + 6];
    if (port.bytes[i + 3] == command && (parameter < 0 || parameter == value)) ++result;
    i += length;
  }
  return result;
}
static void advance(cpc::AudioEngine& engine, uint32_t from, uint32_t to, bool echo = false) {
  for (uint32_t now = from; now < to; ++now) {
    Serial1.now = Serial2.now = Serial3.now = now;
    engine.update(now, echo);
  }
}
static uint32_t commandAt(const HardwareSerial& port, uint8_t command, int parameter, uint32_t after = 0) {
  const size_t length = (&port == &Serial2) ? 8 : 10;
  for (size_t i = 0; i + length <= port.bytes.size(); i += length) {
    assert(port.bytes[i] == 0x7e && port.bytes[i + length - 1] == 0xef);
    const int value = (port.bytes[i + 5] << 8) | port.bytes[i + 6];
    if (port.emittedAt[i] >= after && port.bytes[i + 3] == command && (parameter < 0 || parameter == value))
      return port.emittedAt[i];
  }
  return UINT32_MAX;
}
static void sequentialFixture(bool persistent = false, uint16_t fadeOut = 150, uint16_t fadeIn = 350) {
  fixture();
  const uint8_t count = persistent ? 2 : 1;
  const uint16_t stateOffset = 32 + count * 4, length = stateOffset + 48;
  memmove(bytes + stateOffset, bytes + 44, 48);
  bytes[11] = count; bytes[16] = persistent ? 3 : 2;
  bytes[17] = static_cast<uint8_t>(fadeIn / 50); bytes[19] = static_cast<uint8_t>(fadeOut / 50);
  word(4, length); word(26, stateOffset); word(28, length); word(30, length);
  word(6, image.crc(length)); assert(image.valid(4096, 4));
}
static void testSequentialDurations() {
  sequentialFixture();
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  assert(commands(Serial1, 0x06, 20) == 1);
  engine.enter(1, 3500); advance(engine, 3500, 3650);
  assert(commands(Serial1, 0x0f, 0x0102) == 0); // Old track gets the entire outgoing fade.
  advance(engine, 3650, 5000);
  const uint32_t mute = commandAt(Serial1, 0x06, 0, 3500);
  const uint32_t play = commandAt(Serial1, 0x0f, 0x0102);
  const uint32_t loop = commandAt(Serial1, 0x19, 1, play);
  const uint32_t full = commandAt(Serial1, 0x06, 25, play);
  assert(mute >= 3650 && mute < play);
  assert(commandAt(Serial1, 0x16, 0, 3500) < play);
  assert(play < loop && full >= loop + 349); // Fade-in starts after PLAY/loop startup.
  engine.enter(0, 5000); advance(engine, 5000, 6500);
  assert(commands(Serial1, 0x0f, 0x0101) == 2); // Nonpersistent ambient restarts.
  assert(commandAt(Serial1, 0x06, 20, 5000) != UINT32_MAX);

  // Both zero durations still mute before switching, then restore full volume.
  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3000);
  engine.enter(1, 3000); advance(engine, 3000, 3800);
  const uint32_t zeroPlay = commandAt(Serial1, 0x0f, 0x0102);
  assert(commandAt(Serial1, 0x06, 0, 3000) < zeroPlay);
  assert(commandAt(Serial1, 0x06, 25, zeroPlay) < 3500);

  for (uint8_t which = 0; which < 2; ++which) {
    const uint16_t outMs = which ? 350 : 0, inMs = which ? 0 : 350;
    sequentialFixture(false, outMs, inMs);
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
    engine.enter(1, 3500); advance(engine, 3500, 5000);
    const uint32_t nextPlay = commandAt(Serial1, 0x0f, 0x0102);
    const uint32_t nextLoop = commandAt(Serial1, 0x19, 1, nextPlay);
    const uint32_t nextFull = commandAt(Serial1, 0x06, 25, nextPlay);
    assert(commandAt(Serial1, 0x06, 0, 3500) >= 3500UL + outMs);
    assert(nextFull >= nextLoop + inMs && nextFull < nextLoop + inMs + 100);
  }
}
static void testSequentialLatestAndStop() {
  sequentialFixture(false, 500, 500);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, 3900);
  engine.enter(2, 3900); advance(engine, 3900, 5100);
  assert(commands(Serial1, 0x0f, 0x0102) == 0);
  assert(commands(Serial1, 0x0f, 0x0103) == 1);
  assert(commandAt(Serial1, 0x0f, 0x0103) < 4400); // Latest trigger did not extend outgoing deadline.

  // Enter during fade-in: fade from current level and cancel pending target on STOP.
  engine.enter(1, 5100); advance(engine, 5100, 6050);
  assert(commands(Serial1, 0x0f, 0x0102) == 1);
  assert(commandAt(Serial1, 0x06, 25, 5100) == UINT32_MAX);
  engine.stop(6050); advance(engine, 6050, 7000); assert(engine.stopped());
  assert(commandAt(Serial1, 0x06, 25, 5100) == UINT32_MAX);
  engine.enter(0, 7000); advance(engine, 7000, 8500);
  engine.enter(1, 8500); advance(engine, 8500, 8700);
  engine.stop(8700); advance(engine, 8700, 9600); assert(engine.stopped());
  assert(commandAt(Serial1, 0x0f, 0x0102, 8500) == UINT32_MAX);

  // Rapid trigger before decoder initialization never sends the superseded track.
  sequentialFixture(); engine.begin(&image, 0);
  engine.enter(1, 0); advance(engine, 0, 100);
  engine.enter(2, 100); advance(engine, 100, 3500);
  assert(commands(Serial1, 0x0f, 0x0101) == 0);
  assert(commands(Serial1, 0x0f, 0x0102) == 0);
  assert(commands(Serial1, 0x0f, 0x0103) == 1);

  // A new state during the incoming fade fades its current (partial) level out.
  sequentialFixture(false, 150, 1000);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 4000);
  engine.enter(1, 4000); advance(engine, 4000, 4600);
  assert(commands(Serial1, 0x0f, 0x0102) == 1);
  assert(commandAt(Serial1, 0x06, 25, 4000) == UINT32_MAX);
  engine.enter(2, 4600); advance(engine, 4600, 6500);
  assert(commands(Serial1, 0x0f, 0x0103) == 1);
  assert(commandAt(Serial1, 0x06, 25, 4000) > commandAt(Serial1, 0x0f, 0x0103));
  assert(commandAt(Serial1, 0x06, 30, 4600) != UINT32_MAX);
}
static void testSequentialPersistentAmbient() {
  sequentialFixture(true, 200, 350);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  const unsigned ambientStops = commands(Serial1, 0x16);
  engine.enter(1, 3500); advance(engine, 3500, 5000);
  assert(commands(Serial1, 0x16) == ambientStops);
  assert(commands(Serial2, 0x0f, 0x0102) == 1);
  assert(commandAt(Serial1, 0x06, 0, 3500) < commandAt(Serial2, 0x0f, 0x0102));
  engine.enter(2, 5000); advance(engine, 5000, 6500);
  assert(commands(Serial2, 0x0f, 0x0103) == 1);
  assert(commands(Serial3, 0x0f) == 0); // Only one foreground decoder is needed.
  engine.enter(0, 6500); advance(engine, 6500, 8000);
  assert(commands(Serial1, 0x0f, 0x0101) == 1);
  assert(commands(Serial1, 0x06, 20) == 2);
  assert(commands(Serial1, 0x16) == ambientStops);
  assert(commandAt(Serial2, 0x16, 0, 6500) < commandAt(Serial1, 0x06, 20, 6500));
  engine.stop(8000); advance(engine, 8000, 8500); assert(engine.stopped());
}
static void testSequentialPacketCancellation() {
  // Locate the exact scheduler step that creates PLAY, before any byte is sent.
  sequentialFixture(false, 0, 0);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, 4500);
  const uint32_t playAt = commandAt(Serial1, 0x0f, 0x0102);
  assert(playAt != UINT32_MAX);

  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, playAt);
  engine.enter(2, playAt); advance(engine, playAt, 5000);
  assert(commands(Serial1, 0x0f, 0x0102) == 0); // Superseded queued PLAY is discarded.
  assert(commands(Serial1, 0x0f, 0x0103) == 1);

  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, playAt);
  engine.stop(playAt); advance(engine, playAt, 4500);
  assert(commands(Serial1, 0x0f, 0x0102) == 0 && engine.stopped());

  // Once bytes are in flight, finish their framing, then STOP while still muted.
  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, playAt + 3);
  engine.stop(playAt + 3); advance(engine, playAt + 3, 4500);
  assert(commands(Serial1, 0x0f, 0x0102) == 1 && engine.stopped());
  assert(commandAt(Serial1, 0x16, 0, playAt) != UINT32_MAX);
  assert(commandAt(Serial1, 0x06, 25, playAt) == UINT32_MAX);

  // Retained ambient must keep its queued PLAY when the foreground supersedes
  // the idle state's initial fade-in before that PLAY enters the UART.
  sequentialFixture(true, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  const uint32_t ambientAt = commandAt(Serial1, 0x0f, 0x0101);
  sequentialFixture(true, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, ambientAt);
  engine.enter(1, ambientAt); advance(engine, ambientAt, 4000);
  assert(commands(Serial1, 0x0f, 0x0101) == 1);
  assert(commands(Serial2, 0x0f, 0x0102) == 1);
  assert(commands(Serial1, 0x16) == 1); // Boot STOP only; ambient playback retained.
}
static void testSameTrackInDifferentRoles() {
  fixture();
  // Two decoders; ambient and foreground intentionally use the same looping
  // asset. Returning to ambient must not continue the foreground playhead.
  memmove(bytes + 40, bytes + 44, 48);
  bytes[11] = 2; bytes[16] = 0;
  word(4, 88); word(26, 40); word(28, 88); word(30, 88);
  word(58, 1); bytes[68] = 2;
  word(6, image.crc(88)); assert(image.valid(4096, 4));
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 2500);
  assert(commands(Serial1, 0x0f, 0x0101) == 1);
  engine.enter(1, 2500); advance(engine, 2500, 3500);
  assert(commands(Serial1, 0x16) == 2); // ambient finished fading and stopped
  assert(commands(Serial2, 0x0f, 0x0101) == 1);
  engine.enter(0, 3500); advance(engine, 3500, 4500);
  assert(commands(Serial1, 0x0f, 0x0101) == 2); // fresh ambient playback
  assert(commands(Serial2, 0x16) == 2); // foreground is replaced, not retained

  // The same role change must restart a decoder when hard cuts use one player.
  memmove(bytes + 36, bytes + 40, 48);
  bytes[11] = 1; bytes[17] = 0;
  word(4, 84); word(26, 36); word(28, 84); word(30, 84);
  word(6, image.crc(84)); assert(image.valid(4096, 4));
  Serial1 = HardwareSerial{}; Serial2 = HardwareSerial{}; Serial3 = HardwareSerial{};
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 2500);
  engine.enter(1, 2500); advance(engine, 2500, 3500);
  assert(commands(Serial1, 0x0f, 0x0101) == 2);
  engine.enter(0, 3500); advance(engine, 3500, 4500);
  assert(commands(Serial1, 0x0f, 0x0101) == 3);
}
int main() {
  fixture(); cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0);
  advance(engine, 0, 1500); assert(Serial1.bytes.empty());
  advance(engine, 1500, 2500);
  assert(commands(Serial1, 0x09, 2) == 1);
  assert(commands(Serial1, 0x0f, 0x0101) == 1);
  assert(commands(Serial1, 0x19, 0) == 1);
  assert(commands(Serial1, 0x06, 20) == 1);
  const unsigned ambientStops = commands(Serial1, 0x16);
  engine.enter(1, 2500); advance(engine, 2500, 3500);
  assert(commands(Serial1, 0x16) == ambientStops); // persistent ambient was muted, not stopped
  assert(commands(Serial1, 0x06, 0) >= 2);
  assert(commands(Serial2, 0x0f, 0x0102) == 1);
  assert(commands(Serial2, 0x06, 25) == 1);
  engine.enter(2, 3500); advance(engine, 3500, 4500);
  assert(commands(Serial3, 0x0f, 0x0103) == 1);
  assert(commands(Serial3, 0x06, 30) == 1);
  assert(commands(Serial2, 0x16) == 2); // boot stop plus faded-out foreground
  engine.enter(0, 4500); advance(engine, 4500, 5500);
  assert(commands(Serial1, 0x0f, 0x0101) == 1); // ambient position preserved
  assert(commands(Serial1, 0x06, 20) == 2);
  assert(commands(Serial3, 0x16) == 2);
  engine.enter(1, 5500); advance(engine, 5500, 5700, true);
  const size_t length = Serial2.bytes.size();
  advance(engine, 5700, 5750, true); assert(Serial2.bytes.size() == length); // no TX during echo timing
  advance(engine, 5750, 6500);
  engine.stop(6500); advance(engine, 6500, 6750);
  assert(engine.stopped());
  assert(commands(Serial1, 0x16) == ambientStops + 1);
  assert(commands(Serial2, 0x16) == 3);
  testSameTrackInDifferentRoles();
  testSequentialDurations(); testSequentialLatestAndStop(); testSequentialPersistentAmbient(); testSequentialPacketCancellation();
  puts("Audio host tests passed: initialization, framing, crossfade, sequential fade timings, latest target, persistent ambient, STOP, echo scheduling.");
}
