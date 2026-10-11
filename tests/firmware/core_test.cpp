#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "scene_image.hpp"
#include "zone_engine.hpp"

static uint8_t bytes[4096];
static uint16_t size;
static uint8_t read(uint16_t index) { assert(index < size); return bytes[index]; }
static cpc::SceneImage image{read};
static void word(uint16_t at, uint16_t value) { bytes[at] = value & 255; bytes[at + 1] = value >> 8; }
static void seal() { word(6, image.crc(size)); }
static void fixture() {
  memset(bytes, 0, sizeof(bytes));
  size = 108;
  memcpy(bytes, "CPC1", 4); word(4, size);
  bytes[8] = 1; bytes[9] = 2; bytes[10] = 2; bytes[12] = 2;
  word(20, 32); word(22, 36); word(24, 52); word(26, 52); word(28, 84); word(30, 102);
  bytes[32] = 2; bytes[34] = 3;
  bytes[37] = 4; bytes[38] = 255; bytes[39] = 3; bytes[43] = 1;
  bytes[44] = 1; bytes[45] = 5; bytes[46] = 255; bytes[51] = 1;
  word(52, 20); bytes[62] = 1; // idle -> active on trigger0
  word(68, 40); word(74, 3); word(76, 1); bytes[78] = 2;
  word(84, 0); word(86, 10); bytes[88] = 0;
  word(90, 20); word(92, 30); bytes[94] = 1;
  word(96, 30); word(98, 40); bytes[100] = 0;
  bytes[102] = 0; bytes[103] = 1;
  bytes[104] = 1; bytes[105] = 0;
  bytes[106] = 0; bytes[107] = 1;
  seal();
}
static void testIntegrity() {
  fixture(); assert(image.valid(1024, 1));
  assert(!image.valid(1024, 2)); assert(!image.valid(100, 1));
  bytes[6] ^= 1; assert(!image.valid(1024, 1)); seal();
  bytes[34] = 2; seal(); assert(!image.valid(1024, 1)); // duplicate pin
  fixture(); bytes[32] = 0; seal(); assert(!image.valid(1024, 1)); // host UART
  fixture(); bytes[32] = 20; seal(); assert(!image.valid(1024, 1)); // A6 not GPIO
  fixture(); word(30, 4090); seal(); assert(!image.valid(1024, 1));
  fixture(); bytes[12] = 0; seal(); assert(!image.valid(1024, 1));
  fixture(); word(96, 9); seal(); assert(!image.valid(1024, 1)); // unsorted/overlap
  fixture(); bytes[100] = 2; seal(); assert(!image.valid(1024, 1));
  fixture(); word(98, 41); seal(); assert(!image.valid(1024, 1));
  fixture(); bytes[105] = 2; seal(); assert(!image.valid(1024, 1));
  fixture(); bytes[106] = 1; seal(); assert(!image.valid(1024, 1)); // duplicate trigger
  fixture(); bytes[79] = 31; seal(); assert(!image.valid(1024, 1));
  fixture(); word(54, 1); seal(); assert(!image.valid(1024, 1)); // no decoder
  fixture(); bytes[33] = 4; seal(); assert(!image.valid(1024, 1));
  fixture(); bytes[16] = 128; seal(); assert(!image.valid(1024, 1)); // Reserved audio feature bit.
  fixture(); bytes[19] = 1; seal(); assert(!image.valid(1024, 1)); // Legacy reserved byte remains zero.
  fixture(); bytes[16] = 2; bytes[17] = bytes[19] = 255; seal(); assert(image.valid(1024, 1)); // Independent max fade ticks.
}
static void testAmbientMixValidation() {
  fixture();
  // One ambient-only decoder is sufficient even with a retained mixed level.
  memmove(bytes + 56, bytes + 52, size - 52); size += 4;
  word(4, size); bytes[11] = 1;
  word(26, 56); word(28, 88); word(30, 106);
  bytes[52] = 0; bytes[53] = 6; bytes[54] = 7; bytes[55] = 0;
  word(14, 1); bytes[16] = 1 | (30 << 2); bytes[18] = 20;
  seal(); assert(image.valid(1024, 1)); assert(image.ambientMixVolume() == 30);
  bytes[16] = 1 | (31 << 2); seal(); assert(!image.valid(1024, 1));
  bytes[16] = 1 | (8 << 2) | 128; seal(); assert(!image.valid(1024, 1));
  bytes[16] = 8 << 2; seal(); assert(!image.valid(1024, 1)); // Nonpersistent mix is malformed.
  bytes[16] = 1 | (8 << 2); word(14, 0); seal(); assert(!image.valid(1024, 1));
  word(14, 1); bytes[16] |= 2; bytes[17] = 3; bytes[19] = 7;
  seal(); assert(image.valid(1024, 1)); assert(image.ambientMixVolume() == 8);
  word(74, 2); seal(); assert(!image.valid(1024, 1)); // Persistent foreground still needs two decoders.
}
static void zoneFixture() {
  fixture();
  bytes[44] = 2; bytes[46] = 6; bytes[47] = 0;
  word(48, 100); bytes[50] = 10; bytes[51] = 2;
  bytes[16] |= 128;
  const uint16_t ranges[3][2] = {{2, 40}, {80, 100}, {150, 300}};
  for (uint8_t i = 0; i < 3; ++i) {
    const uint16_t z = 108 + i * 10;
    bytes[z] = 1; word(z + 1, ranges[i][0]); word(z + 3, ranges[i][1]); bytes[z + 5] = 10;
  }
  bytes[114] = 0; bytes[115] = 1; bytes[116] = 1; bytes[117] = 1;
  bytes[124] = 2; bytes[125] = 1; bytes[126] = 3; bytes[127] = 0;
  bytes[134] = 3; bytes[135] = 1; bytes[136] = 4; bytes[137] = 0;
  bytes[138] = 0; bytes[139] = 1;
  bytes[144] = 1; word(148, 2);
  bytes[150] = 1; bytes[151] = 1; word(152, 12); word(154, 3);
  bytes[156] = 0; bytes[157] = 0;
  size = 170; word(4, size);
  bytes[162] = 'Z'; bytes[163] = 'N'; bytes[164] = 1; bytes[165] = 3;
  word(166, 4); word(168, 108); seal();
  assert(image.valid(1024, 1));
}
static void testZoneValidation() {
  zoneFixture(); assert(image.hasZones() && image.zoneCount() == 3 && image.actionCount() == 4);
  assert(!image.zonedTrigger(0) && image.zonedTrigger(1));
  assert(image.transitionEnd() == 108 && image.zone(2) == 128 && image.zoneAction(3) == 156);
  zoneFixture(); bytes[162] = 'X'; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[164] = 2; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[165] = 0; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[165] = 33; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(166, 65); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(168, 65535); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(168, 109); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[108] = 0; seal(); assert(!image.valid(1024, 1)); // Digital input cannot own zones.
  zoneFixture(); bytes[108] = 2; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(109, 1); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(111, 401); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(109, 41); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[113] = 0; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(119, 40); seal(); assert(!image.valid(1024, 1)); // Inclusive endpoints overlap.
  zoneFixture(); bytes[114] = 1; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[115] = 5; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[124] = 1; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[137] = 1; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[138] = 2; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[139] = 2; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(140, 1); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(142, 1); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); bytes[145] = 2; seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(146, 31); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(148, 256); seal(); assert(!image.valid(1024, 1));
  zoneFixture(); word(146, 30); word(148, 255); seal(); assert(image.valid(1024, 1));
  // Reorder same-sensor ranges: editor order is valid and need not be spatial.
  zoneFixture(); word(109, 150); word(111, 300); word(129, 2); word(131, 40); seal(); assert(image.valid(1024, 1));
  // Extension bytes cannot masquerade as legacy transition records.
  bytes[16] &= ~128; seal(); assert(!image.valid(1024, 1));
}
static void testZoneSampling() {
  zoneFixture(); cpc::ZoneInput input; input.reset(); uint8_t previous = 255;
  assert(!input.sample(image, 1, false, 0, 0, previous)); assert(!input.initialized);
  assert(!input.sample(image, 1, true, 100, 10, previous)); assert(input.current == 1); // Silent startup.
  assert(!input.sample(image, 1, true, 110, 1000, previous)); // Inclusive deadband retains current.
  assert(!input.sample(image, 1, true, 111, 1010, previous));
  assert(!input.sample(image, 1, true, 111, 1109, previous));
  assert(input.sample(image, 1, true, 111, 1110, previous)); assert(previous == 1 && input.current == 255);
  assert(!input.sample(image, 1, true, 30, 1200, previous));
  assert(!input.sample(image, 1, false, 0, 1300, previous));
  assert(!input.sample(image, 1, true, 30, 1400, previous)); // Invalid reset the complete dwell.
  assert(input.sample(image, 1, true, 30, 1500, previous)); assert(previous == 255 && input.current == 0);
  assert(!input.sample(image, 1, true, 50, 1600, previous)); // Same-zone boundary is retained.
  assert(!input.sample(image, 1, true, 200, 1700, previous));
  assert(input.sample(image, 1, true, 200, 1800, previous)); assert(previous == 0 && input.current == 2); // Skips middle.
  assert(!input.sample(image, 1, true, 401, 1900, previous)); assert(input.current == 2);
  assert(!input.sample(image, 1, true, 1, 2000, previous)); assert(input.current == 2);
  assert(!input.sample(image, 1, true, 90, 2100, previous));
  assert(!input.sample(image, 1, true, 200, 2150, previous)); // Bounce back cancels candidate.
  assert(!input.sample(image, 1, true, 90, 2200, previous));
  assert(input.sample(image, 1, true, 90, 2300, previous)); assert(input.current == 1);
  input.reset(); assert(!input.sample(image, 1, true, 30, 2400, previous)); assert(input.current == 0);
  bytes[51] = 0;
  assert(input.sample(image, 1, true, 200, 2401, previous)); assert(previous == 0 && input.current == 2);
  input.reset(); bytes[51] = 1;
  assert(!input.sample(image, 1, true, 90, 0xffffffe0UL, previous));
  assert(!input.sample(image, 1, true, 30, 0xfffffff0UL, previous));
  assert(input.sample(image, 1, true, 30, 0x22UL, previous)); assert(input.current == 0);
  // Same pin pair owns every zone, and readings from another sensor cannot select them.
  input.reset(); assert(!input.sample(image, 0, true, 90, 0, previous)); assert(input.current == 255);
}
static void testTimeline() {
  fixture();
  cpc::SceneRuntime runtime; runtime.begin(&image);
  assert(runtime.activeOutputs(0) == 0);
  runtime.run(1000); assert(runtime.currentState == 0);
  bytes[16] = 2; bytes[17] = bytes[19] = 255; // Long audio fades never delay state/output time.
  assert(!runtime.trigger(2, 1000));
  assert(runtime.trigger(1, 1000)); assert(runtime.currentState == 1);
  assert(runtime.activeOutputs(1000) == 1);
  assert(runtime.activeOutputs(1499) == 1);
  assert(runtime.activeOutputs(1500) == 0); // half-open event boundary
  assert(runtime.activeOutputs(2000) == 2);
  assert(runtime.activeOutputs(2500) == 1);
  assert(runtime.activeOutputs(3000) == 0);
  assert(runtime.activeOutputs(90000) == 0);
  bytes[80] = 1; // loop timeline
  assert(runtime.activeOutputs(3000) == 1);
  assert(runtime.trigger(3, 3001)); assert(runtime.currentState == 0); // reset priority
  bytes[33] = 2; // idle-active output
  assert(runtime.activeOutputs(3001) == 1);
  runtime.stop(); assert(runtime.activeOutputs(3001) == 0); // STOP bypasses idle
  assert(!runtime.trigger(1, 3002));
  runtime.run(0xfffffff0UL); runtime.trigger(1, 0xfffffff0UL);
  assert(runtime.activeOutputs(0x00000010UL) == 1); // clock wrap
  assert(runtime.activeOutputs(0x00000200UL) == 1); // idle-active remains
}
static void testDebounce() {
  cpc::DebouncedInput input;
  input.reset(true, 0);
  assert(!input.update(true, 1000, 50)); // held through startup is unarmed
  assert(!input.update(false, 1001, 50)); assert(!input.update(false, 1051, 50));
  assert(!input.update(true, 1060, 50));
  assert(!input.update(false, 1070, 50)); // contact bounce
  assert(!input.update(true, 1080, 50));
  assert(!input.update(true, 1129, 50)); assert(input.update(true, 1130, 50));
  assert(!input.update(true, 1200, 50));
  input.reset(false, 0xfffffff0UL);
  assert(!input.update(true, 0xfffffff8UL, 50)); assert(input.update(true, 0x30UL, 50));
}
static void testPackets() {
  uint8_t packet[10];
  const uint8_t expected[] = {0x7e, 0xff, 6, 6, 0, 0, 30, 0xfe, 0xd7, 0xef};
  assert(cpc::audioPacket(true, 6, 30, packet) == 10);
  assert(!memcmp(packet, expected, 10));
  assert(cpc::audioPacket(false, 0x0f, 0x0102, packet) == 8);
  assert(packet[3] == 0x0f && packet[5] == 1 && packet[6] == 2 && packet[7] == 0xef);
  uint16_t crc = 0xffff;
  const char* text = "123456789";
  for (; *text; ++text) crc = cpc::crc16Byte(crc, *text);
  assert(crc == 0x29b1);
}
int main(int argc, char** argv) {
  testIntegrity(); testAmbientMixValidation(); testZoneValidation(); testZoneSampling(); testTimeline(); testDebounce(); testPackets();
  if (argc > 1) {
    FILE* file = nullptr;
#ifdef _MSC_VER
    fopen_s(&file, argv[1], "rb");
#else
    file = fopen(argv[1], "rb");
#endif
    assert(file); size = static_cast<uint16_t>(fread(bytes, 1, sizeof(bytes), file)); fclose(file);
    assert(size >= 32 && image.valid(bytes[8] == 4 ? 4096 : 1024, bytes[8]));
    puts("Desktop-generated binary passes firmware validation.");
  }
  puts("Firmware host tests passed: integrity, zone layout/actions, fresh-sample dwell, deadband, gaps, baseline, wrap, pins, timelines, debounce, packets, CRC.");
}
