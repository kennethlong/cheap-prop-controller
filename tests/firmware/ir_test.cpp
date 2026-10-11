#include <assert.h>
#include <stdio.h>
#include <string.h>
#define __AVR_ATmega2560__
#include "ir_engine.hpp"
static uint8_t bytes[4096];
static uint16_t length;
static uint8_t read(uint16_t at) { assert(at < length); return bytes[at]; }
static cpc::SceneImage image{read};
static void word(uint16_t at, uint16_t value) { bytes[at] = value & 255; bytes[at + 1] = value >> 8; }
static void seal() { word(6, image.crc(length)); }
static void fixture() {
  memset(bytes, 0, sizeof(bytes)); length = 139;
  memcpy(bytes, "CPC1", 4); word(4, length); bytes[8] = 1; bytes[9] = bytes[10] = 1; bytes[12] = 2; bytes[16] = 128;
  word(20, 32); word(22, 34); word(24, 42); word(26, 42); word(28, 74); word(30, 74);
  bytes[32] = 3; bytes[35] = 4; bytes[36] = 255;
  word(42, 20); bytes[52] = 1; word(58, 20); word(66, 1); bytes[68] = 1;
  bytes[74] = 0; bytes[75] = 1; bytes[76] = 0; bytes[77] = 0;
  bytes[78] = 0; bytes[79] = 0; word(80, 0);
  bytes[82] = 0; bytes[83] = 1; word(84, 2);
  bytes[86] = 1; bytes[87] = 1; word(88, 0);
  bytes[90] = 1; bytes[91] = 0; word(92, 1);
  bytes[94] = 0; bytes[95] = 38; bytes[96] = 2; word(98, 0x807f); word(100, 0x00ff); word(102, 100);
  bytes[106] = 1; bytes[107] = 38; bytes[108] = 1; word(110, 0); word(112, 5); word(114, 50);
  const uint8_t raw[] = {10, 20, 10, 20, 10}; memcpy(bytes + 118, raw, 5);
  bytes[123] = 9; bytes[124] = 2; bytes[125] = 2; word(127, 4); word(129, 5);
  bytes[131] = 'Z'; bytes[132] = 'N'; bytes[133] = 2; word(137, 78);
  seal(); assert(image.valid(1024, 1));
}
static void invalidByte(uint16_t at, uint8_t value) { fixture(); bytes[at] = value; seal(); assert(!image.valid(1024, 1)); }
static void invalidWord(uint16_t at, uint16_t value) { fixture(); word(at, value); seal(); assert(!image.valid(1024, 1)); }
static void validation() {
  fixture(); assert(image.hasIr() && image.zoneCount() == 0 && image.irCommandCount() == 2 && image.irTimedCount() == 4);
  invalidByte(133, 3); invalidByte(123, 10); invalidByte(124, 3); invalidByte(125, 33); invalidByte(126, 1);
  invalidWord(127, 129); invalidWord(129, 65535); invalidWord(137, 77);
  invalidByte(32, 2); invalidByte(32, 9); invalidByte(35, 2); invalidByte(35, 9);
  invalidByte(94, 2); invalidByte(95, 40); invalidByte(96, 0); invalidByte(96, 11); invalidByte(97, 1);
  invalidWord(102, 0); invalidWord(102, 51); invalidWord(102, 2050); invalidWord(104, 1);
  invalidWord(110, 1); invalidWord(112, 4); invalidWord(112, 6); invalidWord(112, 129); invalidByte(118, 1);
  invalidByte(78, 2); invalidByte(79, 2); invalidWord(80, 20); invalidWord(84, 0xffff); invalidByte(86, 0); // Order falls back from tick2 to0.
  fixture(); bytes[96] = 10; word(102, 2000); seal(); assert(image.valid(1024, 1));
}
static void finishFrame() {
  unsigned budget = 20000;
  while (cpc::irDriver::transmitting && budget--) {
    if (cpc::irDriver::position & 1) cpc::irDriver::spaceDone(); else cpc::irDriver::carrierTick();
  }
  assert(budget && !cpc::irDriver::transmitting);
}
static void replay() {
  fixture(); cpc::IrEngine ir; ir.begin(&image); ir.enter(0, 0);
  ir.update(0, false, true); assert(!ir.transmitting());
  ir.update(0, true, false); assert(!ir.transmitting());
  ir.update(0, true, true); assert(ir.transmitting() && cpc::irDriver::pulseCount == 67);
  assert(cpc::irDriver::pulseData[0] == 180 && cpc::irDriver::pulseData[1] == 90);
  assert(cpc::irDriver::pulseData[3] == 34 && cpc::irDriver::pulseData[17] == 11); // LSB-first 0x7f.
  assert(cpc::irDriver::cycles == 342); finishFrame();
  ir.update(70, true, true); assert(!ir.transmitting());
  ir.update(169, true, true); assert(!ir.transmitting());
  ir.update(170, true, true); assert(ir.transmitting()); finishFrame();
  ir.timeline(100); // Enqueue tick2 exactly once.
  ir.timeline(101);
  ir.update(240, true, true); assert(!ir.transmitting());
  ir.update(340, true, true); assert(ir.transmitting() && cpc::irDriver::pulseCount == 5); finishFrame();
  ir.update(350, true, true); assert(ir.busy()); ir.update(400, true, true); assert(!ir.busy());
  ir.enter(0, 400); ir.update(400, true, true); assert(ir.transmitting());
  ir.enqueue(0); ir.enter(1, 410); // Old queued command/repeat cancelled; active frame retained.
  finishFrame(); ir.update(480, true, true); assert(!ir.transmitting());
  ir.update(580, true, true); assert(ir.transmitting() && cpc::irDriver::pulseCount == 5);
  ir.stop(); assert(!ir.transmitting() && !ir.busy());
  for (uint8_t i = 0; i < 8; ++i) assert(ir.enqueue(0));
  assert(!ir.enqueue(0) && ir.takeOverflow() && !ir.takeOverflow()); ir.stop();
  bytes[54] = 1; ir.enter(0, 1000); ir.timeline(3100); // Two loop crossings plus tick2.
  assert(!ir.takeOverflow());
  ir.timeline(50000); assert(ir.takeOverflow()); ir.stop();
}
static void staging() {
  fixture(); cpc::IrEngine ir; ir.begin(&image);
  assert(!ir.stage(0, 1, 1, 50, 1)); assert(!ir.stage(1, 5, 1, 50, 1));
  assert(!ir.stage(1, 6, 1, 50, 0)); assert(!ir.stage(0, 0, 0, 50, 1));
  assert(ir.stage(1, 5, 1, 100, 0)); assert(!ir.play(0));
  const uint8_t raw[] = {10, 20, 10, 20, 10}, bad[] = {1};
  assert(!ir.data(1, raw, 1)); assert(!ir.data(0, bad, 1));
  assert(ir.data(0, raw, 3)); assert(ir.stagedOffset() == 3);
  assert(!ir.data(0, raw, 2)); assert(ir.data(3, raw + 3, 2)); assert(ir.play(10));
  ir.update(10, false, true); assert(!ir.transmitting()); ir.update(10, true, true); assert(ir.transmitting());
  finishFrame(); ir.update(20, true, true); assert(ir.busy()); ir.update(120, true, true); assert(!ir.busy());
  assert(ir.stage(0, 0, 1, 50, 0xffffffffUL)); assert(ir.play(100));
  ir.update(100, true, true); assert(cpc::irDriver::pulseData[3] == 34 && cpc::irDriver::pulseData[65] == 34); ir.stop();
  uint8_t longRaw[17]; memset(longRaw, 255, sizeof(longRaw));
  assert(ir.stage(1, 17, 1, 50, 0)); assert(ir.data(0, longRaw, 17)); assert(!ir.play(0)); ir.stop();
}
static void capture() {
  uint8_t data[127] = {}; cpc::irDriver::Capture rx;
  rx.arm(data, 0); rx.edge(false, 20000);
  uint32_t now = 20000; const uint8_t raw[] = {180, 90, 11, 34, 11};
  for (uint8_t i = 0; i < 5; ++i) { now += raw[i] * 50; rx.edge(!(i & 1), now); }
  assert(!rx.poll(now - 4)); // Edge ISR won the race after main sampled micros().
  assert(!rx.poll(now + 14999)); assert(rx.poll(now + 15000) == 1 && rx.count == 5 && !memcmp(data, raw, 5));
  rx.arm(data, 0); rx.edge(false, 20000); rx.edge(true, 29000); rx.edge(false, 31250); rx.edge(true, 31800);
  assert(rx.poll(46800) == 2); // NEC repeat alone is not a learned button.
  rx.arm(data, 0); rx.edge(false, 20000); rx.edge(true, 20030); assert(rx.result == 2);
  rx.arm(data, 0); rx.edge(false, 20000); now = 20000;
  for (uint8_t i = 0; i < 128; ++i) { now += 100; rx.edge(!(i & 1), now); }
  assert(rx.result == 3); rx.cancel(); assert(!rx.active && !rx.result);
  rx.arm(data, 0xfffff000UL); rx.edge(false, 0x4000UL); rx.edge(true, 0x5000UL); assert(rx.count == 1); // micros wrap.
  fixture(); cpc::IrEngine ir; ir.begin(&image); ir.learn(0);
  assert(!ir.pollLearn(1, 1000, false) && !cpc::irDriver::capture.active);
  assert(!ir.pollLearn(100, 100000, true) && cpc::irDriver::capture.active);
  assert(ir.pollLearn(10100, 10100000, true) == 4 && !ir.learning()); ir.stop();
}
int main() { validation(); replay(); staging(); capture(); puts("IR host tests passed: strict v2 validation/pin collisions, NEC/raw envelope, FIFO/gaps, timed loops, state/STOP cancellation, staged RAM tests, bounded capture/noise/repeats/timeout."); }
