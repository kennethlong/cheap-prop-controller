#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "scene_image.hpp"

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
  fixture(); bytes[16] = 4; seal(); assert(!image.valid(1024, 1)); // Unknown audio feature bit.
  fixture(); bytes[19] = 1; seal(); assert(!image.valid(1024, 1)); // Legacy reserved byte remains zero.
  fixture(); bytes[16] = 2; bytes[17] = bytes[19] = 255; seal(); assert(image.valid(1024, 1)); // Independent max fade ticks.
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
  testIntegrity(); testTimeline(); testDebounce(); testPackets();
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
  puts("Firmware host tests passed: integrity, bounds, pins, timelines, priority, STOP, wrap, debounce, packets, CRC.");
}
