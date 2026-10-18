#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#define __AVR_ATmega2560__
#define ARDUINO 10819
// Exercise the real Mega transmit-complete checks without changing the shared
// serial fake. Ordinary tests model immediate writes; drain tests hold TXC low.
static uint8_t UCSR1A = 1, UCSR2A = 1, UCSR3A = 1;
enum { TXC1 = 0, TXC2 = 0, TXC3 = 0 };
#define _BV(bit) (1 << (bit))
#include "audio_engine.hpp"
#include "audio_feedback.hpp"
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
  UCSR1A = UCSR2A = UCSR3A = 1;
}
static size_t packetLength(const HardwareSerial& port) {
  const uint8_t player = &port == &Serial1 ? 0 : &port == &Serial2 ? 1 : 2;
  return image.b(image.player(player)) ? 8 : 10;
}
static unsigned commands(const HardwareSerial& port, uint8_t command, int parameter = -1) {
  unsigned result = 0;
  for (size_t i = 0; i < port.bytes.size();) {
    assert(port.bytes[i] == 0x7e);
    const size_t length = packetLength(port);
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
  const size_t length = packetLength(port);
  for (size_t i = 0; i + length <= port.bytes.size(); i += length) {
    assert(port.bytes[i] == 0x7e && port.bytes[i + length - 1] == 0xef);
    const int value = (port.bytes[i + 5] << 8) | port.bytes[i + 6];
    if (port.emittedAt[i] >= after && port.bytes[i + 3] == command && (parameter < 0 || parameter == value))
      return port.emittedAt[i];
  }
  return UINT32_MAX;
}
static void assertVolumeRange(const HardwareSerial& port, uint8_t minimum, uint8_t maximum, uint32_t after) {
  const size_t length = packetLength(port);
  for (size_t i = 0; i + length <= port.bytes.size(); i += length) {
    assert(port.bytes[i] == 0x7e && port.bytes[i + length - 1] == 0xef);
    if (port.emittedAt[i] >= after && port.bytes[i + 3] == 0x06)
      assert(port.bytes[i + 5] == 0 && port.bytes[i + 6] >= minimum && port.bytes[i + 6] <= maximum);
  }
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
static void testCommandRecoveryAfterTransport() {
  // A USB STATUS print can stall the main loop in the middle of a packet.
  // Decoder recovery begins after its final byte, never at packet creation.
  for (uint8_t kind = 0; kind < 2; ++kind) for (uint8_t command = 0; command < 2; ++command) {
    sequentialFixture(false, 0, 0); bytes[32] = kind;
    cpc::AudioEngine engine;
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3000);
    const uint8_t current = command ? 0x0f : 0x09, next = command ? 0x19 : 0x16;
    const uint32_t packetAt = commandAt(Serial1, current, command ? 0x0101 : 2);
    sequentialFixture(false, 0, 0); bytes[32] = kind;
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, packetAt + 3);
    const size_t packetOffset = Serial1.bytes.size() - 3;
    assert(Serial1.bytes[packetOffset] == 0x7e);
    advance(engine, packetAt + 43, 3500); // 40 ms main-loop stall; no UART bytes lost.
    const uint32_t completed = Serial1.emittedAt[packetOffset + packetLength(Serial1) - 1];
    const uint32_t nextAt = commandAt(Serial1, next, 0, packetAt);
    assert(nextAt >= completed + (command ? 60U : 250U));
    assert(nextAt < completed + (command ? 70U : 260U)); // No arbitrary extra delay.
  }

  // Mega write() may only enqueue the final byte. TXC, not buffer acceptance,
  // starts the recovery interval, even when the main loop keeps running.
  sequentialFixture(false, 0, 0);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3000);
  const uint32_t playAt = commandAt(Serial1, 0x0f, 0x0101);
  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, playAt + 3);
  UCSR1A = 0;
  advance(engine, playAt + 3, playAt + 110);
  assert(commands(Serial1, 0x0f, 0x0101) == 1);
  assert(commands(Serial1, 0x19, 0) == 0 && !engine.transportIdle());
  UCSR1A = 1;
  advance(engine, playAt + 110, playAt + 170);
  assert(commands(Serial1, 0x19, 0) == 0);
  advance(engine, playAt + 170, playAt + 200);
  assert(commandAt(Serial1, 0x19, 0) >= playAt + 170);

  // STOP while PLAY is on the wire preserves framing and decoder recovery,
  // then reaches STOP promptly without ever sending LOOP or raising volume.
  sequentialFixture(false, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, playAt + 3);
  engine.stop(playAt + 3); UCSR1A = 0;
  advance(engine, playAt + 3, playAt + 20);
  assert(commands(Serial1, 0x0f, 0x0101) == 1 && !engine.stopped());
  assert(commandAt(Serial1, 0x16, 0, playAt) == UINT32_MAX);
  UCSR1A = 1;
  advance(engine, playAt + 20, playAt + 80);
  assert(commandAt(Serial1, 0x16, 0, playAt) == UINT32_MAX);
  advance(engine, playAt + 80, playAt + 91);
  const uint32_t stopAt = commandAt(Serial1, 0x16, 0, playAt);
  assert(stopAt >= playAt + 80 && stopAt <= playAt + 82);
  // Final STOP byte is queued, but shutdown is not acknowledged until actual
  // drain and its recovery deadline have been recorded by update().
  UCSR1A = 0;
  assert(!engine.stopped() && !engine.transportIdle());
  advance(engine, playAt + 91, playAt + 110);
  UCSR1A = 1;
  assert(engine.transportIdle() && !engine.stopped());
  advance(engine, playAt + 110, playAt + 200);
  assert(engine.stopped() && commands(Serial1, 0x19, 0) == 0);
  assert(commands(Serial1, 0x06, 20) == 0);
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
  const uint32_t incomingPlay = commandAt(Serial1, 0x0f, 0x0102);
  // The outgoing track's 30 -> 0 fade can also pass through volume 25.
  assert(commandAt(Serial1, 0x06, 25, incomingPlay) == UINT32_MAX);
  engine.stop(6050); advance(engine, 6050, 7000); assert(engine.stopped());
  assert(commandAt(Serial1, 0x06, 25, incomingPlay) == UINT32_MAX);
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
static void mixedFixture(bool sequential, uint8_t kind = 0, uint16_t fadeOut = 600, uint16_t fadeIn = 150) {
  if (sequential) sequentialFixture(true, fadeOut, fadeIn);
  else fixture();
  bytes[16] |= 8 << 2;
  bytes[32] = kind;
  word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4));
}
static void testMixedAmbientTransitions() {
  // Exercise the complete idle -> foreground -> foreground -> idle path with
  // both DFPlayer and YX5300 ambient packets, for crossfade, sequential and cut.
  for (uint8_t kind = 0; kind < 2; ++kind) for (uint8_t mode = 0; mode < 3; ++mode) {
    mixedFixture(mode != 0, kind);
    if (mode == 2) {
      bytes[16] &= ~2; bytes[17] = bytes[19] = 0;
      word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4));
    }
    cpc::AudioEngine engine;
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
    const unsigned ambientStops = commands(Serial1, 0x16);
    const unsigned mixedVolumes = commands(Serial1, 0x06, 8);
    assert(commands(Serial1, 0x06, 20) == 1);
    engine.enter(1, 3500); advance(engine, 3500, 4800);
    assert(commands(Serial1, 0x06, 8) == mixedVolumes + 1);
    assert(commands(Serial2, 0x0f, 0x0102) == 1);
    assert(commands(Serial2, 0x06, 25) == 1);
    if (mode == 1) {
      // An idle foreground decoder starts before the longer ambient adjustment
      // finishes: ambient cannot gate sequential readiness.
      assert(commandAt(Serial2, 0x0f, 0x0102) < commandAt(Serial1, 0x06, 8, 3500));
      assert(commandAt(Serial1, 0x06, 8, 3500) >= 4100);
    }
    const unsigned ambientVolumes = commands(Serial1, 0x06);
    engine.enter(2, 4800); advance(engine, 4800, 6200);
    const HardwareSerial& foreground = mode ? Serial2 : Serial3;
    assert(commands(foreground, 0x0f, 0x0103) == 1);
    assert(commands(foreground, 0x06, 30) == 1);
    assert(commands(Serial1, 0x06) == ambientVolumes); // No dip during foreground handoff.
    engine.enter(0, 6200); advance(engine, 6200, 7600);
    assert(commands(Serial1, 0x06, 20) == 2);
    if (mode == 1) {
      // The normal ambient level returns over fade-in while foreground fades
      // out independently; it need not wait for the outgoing STOP.
      assert(commandAt(Serial1, 0x06, 20, 6200) < commandAt(foreground, 0x16, 0, 6200));
      assert(commandAt(Serial1, 0x06, 20, 6200) >= 6350);
    }
    assertVolumeRange(Serial1, 8, 20, 3500);
    assert(commands(Serial1, 0x0f, 0x0101) == 1);
    assert(commands(Serial1, 0x16) == ambientStops);
    engine.stop(7600); advance(engine, 7600, 8100);
    assert(engine.stopped() && commands(Serial1, 0x16) == ambientStops + 1);
  }
}
static void testMixedLatestAndStop() {
  mixedFixture(true, 0, 1000, 150);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, 3900);
  engine.enter(2, 3900); advance(engine, 3900, 4200);
  engine.enter(1, 4200); advance(engine, 4200, 5400);
  assert(commands(Serial2, 0x0f, 0x0103) == 0); // Superseded foreground never starts.
  assert(commands(Serial2, 0x0f, 0x0102) == 2);
  assert(commandAt(Serial1, 0x06, 8, 3500) < 4600); // Repeated mixed target does not extend ambient fade.
  assertVolumeRange(Serial1, 8, 20, 3500);
  assert(commands(Serial1, 0x16) == 1 && commands(Serial1, 0x0f, 0x0101) == 1);

  // Reverse the ambient envelope while foreground is still fading out. The
  // latest idle request must restore normal volume immediately using fade-in.
  engine.enter(2, 5400); advance(engine, 5400, 5600);
  engine.enter(0, 5600); advance(engine, 5600, 5900);
  assert(commandAt(Serial1, 0x06, 20, 5600) < 5850);
  engine.enter(2, 5900); advance(engine, 5900, 6000);
  engine.stop(6000); advance(engine, 6000, 7000);
  assert(engine.stopped());
  assert(commands(Serial2, 0x0f, 0x0103) == 0);
  assert(commands(Serial1, 0x16) == 2);
  assert(commandAt(Serial1, 0x0f, 0x0101, 6000) == UINT32_MAX);
  engine.enter(0, 7000); advance(engine, 7000, 8000);
  assert(commands(Serial1, 0x0f, 0x0101) == 2 && commands(Serial1, 0x06, 20) == 3);
}
static void testMixedStartupAndCancellation() {
  for (uint8_t sequential = 0; sequential < 2; ++sequential) {
    mixedFixture(sequential != 0);
    cpc::AudioEngine engine;
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 100);
    engine.enter(1, 100); advance(engine, 100, 200);
    engine.enter(2, 200); advance(engine, 200, 4000);
    assert(commands(Serial1, 0x0f, 0x0101) == 1);
    assert(commands(Serial1, 0x06, 8) == 1 && commands(Serial1, 0x06, 20) == 0);
    assert(commands(Serial1, 0x16) == 1);
    if (sequential) assert(commands(Serial2, 0x0f, 0x0102) == 0);
    // A zero normal level must preserve ambient so that the next foreground
    // can raise it again without resetting its playhead.
    bytes[18] = 0;
    engine.enter(0, 4000); advance(engine, 4000, 5200);
    engine.enter(1, 5200); advance(engine, 5200, 6500);
    assert(commands(Serial1, 0x0f, 0x0101) == 1 && commands(Serial1, 0x16) == 1);
    assert(commands(Serial1, 0x06, 8) == 2);
  }

  // Retain an ambient PLAY queued before a rapid trigger; discard a queued
  // foreground PLAY, while STOP cancels all queued playback including ambient.
  mixedFixture(true, 0, 0, 0);
  cpc::AudioEngine engine;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  const uint32_t ambientAt = commandAt(Serial1, 0x0f, 0x0101);
  engine.enter(1, 3500); advance(engine, 3500, 4500);
  const uint32_t foregroundAt = commandAt(Serial2, 0x0f, 0x0102);
  mixedFixture(true, 0, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, ambientAt);
  engine.enter(1, ambientAt); advance(engine, ambientAt, 3500);
  assert(commands(Serial1, 0x0f, 0x0101) == 1 && commands(Serial1, 0x16) == 1);
  mixedFixture(true, 0, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, foregroundAt);
  engine.enter(2, foregroundAt); advance(engine, foregroundAt, 4500);
  assert(commands(Serial2, 0x0f, 0x0102) == 0 && commands(Serial2, 0x0f, 0x0103) == 1);
  assert(commands(Serial1, 0x06, 0) == 1 && commands(Serial1, 0x16) == 1);
  mixedFixture(true, 0, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, ambientAt);
  engine.stop(ambientAt); advance(engine, ambientAt, 3500);
  assert(commands(Serial1, 0x0f, 0x0101) == 0 && engine.stopped());

  // A partly transmitted foreground PLAY retains framing, then STOP silences
  // every decoder and prevents either fade from restoring a later volume.
  mixedFixture(true, 0, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); advance(engine, 3500, foregroundAt + 3);
  engine.stop(foregroundAt + 3); advance(engine, foregroundAt + 3, 4500);
  assert(commands(Serial2, 0x0f, 0x0102) == 1 && engine.stopped());
  assert(commandAt(Serial2, 0x16, 0, foregroundAt) != UINT32_MAX);
  assert(commandAt(Serial2, 0x06, 25, foregroundAt) == UINT32_MAX);
  assert(commands(Serial1, 0x16) == 2);

  // The same framing guarantee applies when STOP interrupts ambient startup.
  mixedFixture(true, 0, 0, 0);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, ambientAt + 3);
  engine.stop(ambientAt + 3); advance(engine, ambientAt + 3, 3500);
  assert(commands(Serial1, 0x0f, 0x0101) == 1 && engine.stopped());
  assert(commands(Serial1, 0x16) == 2 && commands(Serial1, 0x06, 20) == 0);
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
static void testVolumeActions() {
  for (uint8_t kind = 0; kind < 2; ++kind) for (uint8_t mode = 0; mode < 3; ++mode) {
    mixedFixture(mode != 0, kind, 400, 200);
    if (mode == 2) { bytes[16] &= ~2; bytes[17] = bytes[19] = 0; }
    cpc::AudioEngine engine;
    engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
    engine.volume(1, 30, 0, 3500); // No foreground role: never invent playback.
    engine.volume(0, 4, 200, 3500); advance(engine, 3500, 4000);
    assert(commandAt(Serial1, 0x06, 4, 3500) >= 3700);
    assert(commands(Serial1, 0x0f) == 1 && commands(Serial2, 0x0f) == 0);
    engine.enter(1, 4000);
    engine.volume(1, 0, 0, 4000); // Pending/startup track must stay alive silently.
    engine.volume(0, 3, 0, 4000); advance(engine, 4000, 5200);
    assert(commands(Serial2, 0x0f, 0x0102) == 1);
    assert(commands(Serial2, 0x16) == 1); // Boot STOP only.
    assert(commandAt(Serial2, 0x06, 25, 4000) == UINT32_MAX);
    assert(commandAt(Serial1, 0x06, 3, 4000) != UINT32_MAX);
    engine.volume(1, 12, 250, 5200); advance(engine, 5200, 6000);
    assert(commandAt(Serial2, 0x06, 12, 5200) >= 5450);
    assert(commands(Serial2, 0x0f, 0x0102) == 1); // Volume-up keeps playhead.
    engine.enter(2, 6000); engine.volume(1, 7, 100, 6000); advance(engine, 6000, 7500);
    const HardwareSerial& incoming = mode ? Serial2 : Serial3;
    assert(commandAt(incoming, 0x06, 7, 6000) != UINT32_MAX);
    if (!mode) {
      // Retiring 12 -> 0 may legitimately pass through the incoming target 7;
      // verify it never rises instead of forbidding that intermediate value.
      uint8_t retiringVolume = 12;
      for (size_t at = 0; at + packetLength(Serial2) <= Serial2.bytes.size(); at += packetLength(Serial2))
        if (Serial2.emittedAt[at] >= 6000 && Serial2.bytes[at + 3] == 0x06) {
          assert(Serial2.bytes[at + 6] <= retiringVolume);
          retiringVolume = Serial2.bytes[at + 6];
        }
      assert(retiringVolume == 0);
    }
    assert(commandAt(Serial1, 0x06, 8, 6000) != UINT32_MAX); // State entry clears ambient override.
    engine.enter(0, 7500); advance(engine, 7500, 9000);
    assert(commandAt(Serial1, 0x06, 20, 7500) != UINT32_MAX);
    assert(commands(Serial1, 0x0f) == 1);
    engine.stop(9000); engine.volume(0, 30, 0, 9000); engine.volume(1, 30, 0, 9000);
    advance(engine, 9000, 9500); assert(engine.stopped());
    assert(commandAt(Serial1, 0x06, 30, 9000) == UINT32_MAX);
  }
}
static void testVolumePendingAndZeroDefaults() {
  // A normal ambient volume of zero still leaves a logical voice to adjust.
  for (uint8_t sequential = 0; sequential < 2; ++sequential) {
    mixedFixture(sequential != 0); bytes[18] = 0;
    cpc::AudioEngine engine; engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
    engine.volume(0, 9, 0, 3500); advance(engine, 3500, 3900);
    assert(commands(Serial1, 0x0f, 0x0101) == 1 && commands(Serial1, 0x16) == 1);
    assert(commandAt(Serial1, 0x06, 9, 3500) != UINT32_MAX);
  }
  // Overrides before decoder initialization apply to the eventual target.
  sequentialFixture(false, 500, 100);
  cpc::AudioEngine engine; engine.begin(&image, 0); engine.enter(1, 0);
  engine.volume(1, 11, 900, 0); advance(engine, 0, 4000);
  const uint32_t loop = commandAt(Serial1, 0x19, 1);
  assert(commandAt(Serial1, 0x06, 11) >= loop + 900);
  assert(commands(Serial1, 0x06, 25) == 0);
  engine.enter(0, 4000); engine.volume(0, 6, 700, 4000); advance(engine, 4000, 6000);
  assert(commandAt(Serial1, 0x06, 6, 4000) != UINT32_MAX);
  assert(commandAt(Serial1, 0x06, 20, 4000) == UINT32_MAX);
  engine.enter(1, 6000); engine.volume(1, 0, 0, 6000);
  engine.enter(2, 6100); advance(engine, 6100, 8000);
  assert(commandAt(Serial1, 0x06, 30, 6100) != UINT32_MAX); // Latest state clears old override.

  // A silent persistent ambient can be raised during handoff without blocking
  // foreground readiness. Another state clears it even while still pending.
  sequentialFixture(true, 800, 100);
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); engine.volume(0, 6, 0, 3500); advance(engine, 3500, 4500);
  assert(commandAt(Serial1, 0x06, 6, 3500) != UINT32_MAX);
  assert(commands(Serial2, 0x0f, 0x0102) == 1);
  engine.enter(2, 4500); engine.volume(0, 11, 0, 4500); advance(engine, 4500, 4600);
  engine.enter(1, 4600); advance(engine, 4600, 6500);
  assert(commandAt(Serial1, 0x06, 0, 4600) != UINT32_MAX);
  assert(commandAt(Serial2, 0x06, 25, 4600) != UINT32_MAX);
  assert(commands(Serial2, 0x0f, 0x0103) == 0);

  // Ambient that is only retiring under a nonpersistent foreground is not a
  // logical ambient role, even while the old decoder remains audible.
  fixture(); bytes[16] = 0;
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3500);
  engine.enter(1, 3500); engine.volume(0, 30, 0, 3500); advance(engine, 3500, 4500);
  assert(commandAt(Serial1, 0x06, 30, 3500) == UINT32_MAX);
  assert(commands(Serial1, 0x16) == 2);
}
static void testBusyFeedbackPrimitive() {
  cpc::AudioFeedback feedback;
  feedback.reset(false); feedback.start(0);
  assert(!feedback.sample(true, 5000) && feedback.status == cpc::AudioFeedback::Disabled);
  feedback.reset(true); assert(feedback.status == cpc::AudioFeedback::Stopped);
  feedback.start(1000);
  assert(!feedback.sample(false, 2000) && feedback.status == cpc::AudioFeedback::Waiting);
  assert(!feedback.sample(true, 2100)); assert(!feedback.sample(false, 2150));
  assert(!feedback.sample(true, 2200)); assert(!feedback.sample(true, 2299));
  assert(!feedback.sample(true, 2300) && feedback.status == cpc::AudioFeedback::Playing);
  assert(!feedback.sample(false, 2500)); assert(!feedback.sample(true, 2550));
  assert(!feedback.sample(false, 2600)); assert(!feedback.sample(false, 2699));
  assert(feedback.sample(false, 2700) && feedback.status == cpc::AudioFeedback::Finished);
  assert(!feedback.sample(false, 8000)); // Completion is a one-shot edge.
  feedback.start(9000); assert(!feedback.sample(false, 13999));
  assert(!feedback.sample(false, 14000) && feedback.status == cpc::AudioFeedback::Failed);
  assert(!feedback.sample(true, 15000)); // A disconnected/missing player never ends a state.
  feedback.start(0xffffff00UL); assert(!feedback.sample(true, 0xffffff00UL));
  assert(!feedback.sample(true, 0xffffff64UL));
  assert(!feedback.sample(false, 0xfffffff0UL));
  assert(feedback.sample(false, 0x54UL)); // Debounce survives millis wrap.
  feedback.reset(true); assert(!feedback.sample(false, 1000));
}
static void testAudioFeedbackRouting() {
  sequentialFixture(false, 0, 0); bytes[3] = '2'; bytes[35] = 3;
  bytes[image.state(1) + 13] = 1;
  word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4));
  cpc::AudioEngine engine; engine.begin(&image, 0); engine.enter(0, 0);
  assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Stopped);
  engine.sampleFeedback(0, true, 1000); assert(!engine.takeForegroundFinished());
  advance(engine, 0, 3000);
  assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Waiting);
  engine.sampleFeedback(0, true, 3000); engine.sampleFeedback(0, true, 3100);
  assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Playing);
  engine.sampleFeedback(0, false, 3200); engine.sampleFeedback(0, false, 3300);
  assert(!engine.takeForegroundFinished()); // Ambient BUSY cannot end a foreground state.

  engine.enter(1, 3400); advance(engine, 3400, 4200);
  assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Waiting);
  engine.sampleFeedback(0, false, 4200); assert(!engine.takeForegroundFinished());
  engine.sampleFeedback(0, true, 4500); engine.sampleFeedback(0, true, 4600);
  engine.sampleFeedback(0, false, 4650); engine.sampleFeedback(0, true, 4670);
  engine.sampleFeedback(0, false, 4700); engine.sampleFeedback(0, false, 4799);
  assert(!engine.takeForegroundFinished());
  engine.sampleFeedback(0, false, 4800); assert(engine.takeForegroundFinished());
  assert(!engine.takeForegroundFinished());

  engine.enter(1, 4900); advance(engine, 4900, 5800);
  engine.sampleFeedback(0, false, 12000);
  assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Failed && !engine.takeForegroundFinished());
  engine.enter(1, 12000); advance(engine, 12000, 13000);
  engine.sampleFeedback(0, true, 13000); engine.sampleFeedback(0, true, 13100);
  engine.sampleFeedback(0, false, 13200); engine.sampleFeedback(0, false, 13300);
  engine.enter(2, 13300); assert(!engine.takeForegroundFinished()); // Old completion never survives another state.
  engine.stop(13400); assert(engine.feedbackStatus(0) == cpc::AudioFeedback::Stopped);

  fixture(); bytes[3] = '2'; bytes[35] = 3; bytes[39] = 4; bytes[43] = 5;
  word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4));
  engine.begin(&image, 0); engine.enter(0, 0); advance(engine, 0, 3000);
  engine.enter(1, 3000); advance(engine, 3000, 4000);
  engine.sampleFeedback(1, true, 4000); engine.sampleFeedback(1, true, 4100);
  engine.enter(2, 4200); // Retiring player1 remains BUSY while new player2 starts.
  engine.sampleFeedback(1, false, 4200); engine.sampleFeedback(1, false, 4300);
  assert(!engine.takeForegroundFinished());
  advance(engine, 4200, 5000);
  engine.sampleFeedback(2, true, 5000); engine.sampleFeedback(2, true, 5100);
  engine.sampleFeedback(2, false, 5200); engine.sampleFeedback(2, false, 5300);
  assert(engine.takeForegroundFinished());
}
int main() {
  testCommandRecoveryAfterTransport();
  testBusyFeedbackPrimitive();
  testAudioFeedbackRouting();
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
  testMixedAmbientTransitions(); testMixedLatestAndStop(); testMixedStartupAndCancellation();
  testVolumeActions(); testVolumePendingAndZeroDefaults();
  puts("Audio host tests passed: completion-anchored recovery, buffered UART drain/STOP, BUSY debounce/start timeout/foreground routing, role-volume actions, packet retirement, crossfade/cut/sequential fades, ambient mixing, startup, STOP, echo scheduling.");
}
