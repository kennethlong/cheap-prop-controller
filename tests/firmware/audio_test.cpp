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
  Serial1.bytes.clear(); Serial2.bytes.clear(); Serial3.bytes.clear();
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
  for (uint32_t now = from; now < to; ++now) engine.update(now, echo);
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
  Serial1.bytes.clear(); Serial2.bytes.clear(); Serial3.bytes.clear();
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
  puts("Audio host tests passed: decoder initialization, packet framing, fades, persistent ambient, three-player allocation, STOP, echo scheduling.");
}
