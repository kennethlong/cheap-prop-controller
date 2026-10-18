#define _CRT_SECURE_NO_WARNINGS
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "scene_image.hpp"

static uint8_t bytes[4096], original[4096];
static uint16_t length, originalLength;
static uint8_t read(uint16_t offset) { assert(offset < length); return bytes[offset]; }
static cpc::SceneImage image{read};
static void word(uint16_t offset, uint16_t value) { bytes[offset] = value & 255; bytes[offset + 1] = value >> 8; }
static void seal() { word(4, length); word(6, image.crc(length)); }
static bool valid() { seal(); return image.valid(1024, 1); }
static void fixture() { length = originalLength; memcpy(bytes, original, length); assert(image.valid(1024, 1)); }

static void testValidation() {
  fixture(); assert(image.b(3) == '3' && image.sceneControls() && image.child(3) && image.child(4));
  const uint16_t main = image.state(1), a = image.state(3), b = image.state(4);
  const uint16_t events = image.u16(28), mappings = image.u16(30);
  for (uint8_t version = '1'; version <= '4'; ++version) {
    fixture(); bytes[3] = version; assert(valid() == (version == '3'));
  }
  const uint8_t flags[] = {5, 6, 7, 8, 12, 255};
  for (uint8_t flag : flags) { fixture(); bytes[a + 12] = flag; assert(!valid()); }
  fixture(); bytes[13] = 3; assert(!valid()); // A child cannot boot as the main scene.
  fixture(); word(a + 6, 0); assert(!valid());
  fixture(); word(a + 2, 2); assert(!valid());
  fixture(); bytes[a + 10] = 1; assert(!valid());
  fixture(); bytes[a + 13] = 1; assert(!valid());
  fixture(); word(main + 14, 1); assert(!valid());
  fixture(); word(a + 14, 65535); assert(valid()); // Full unsigned cooldown field.
  fixture(); bytes[image.output(1) + 1] |= 2; assert(!valid()); // Child output must idle OFF.
  fixture(); bytes[events + 4] = 1; assert(!valid()); // Parent and child claim the same channel.
  fixture(); bytes[image.event(image.u16(b + 4)) + 4] = 1; assert(!valid()); // Distinct child ownership.
  fixture(); bytes[mappings + 4] = bytes[mappings + 2]; assert(!valid()); // Two children in a round-robin group.
  fixture(); bytes[mappings + 6] = bytes[mappings + 4]; assert(!valid()); // Child/main mixed group.
  fixture(); bytes[mappings + 3] = 2; bytes[mappings + 4] = bytes[mappings + 2]; assert(!valid()); // Main/child order too.
  fixture(); bytes[image.player(0) + 3] = 14; bytes[main + 13] = 3; assert(valid());
  bytes[main + 13] = 4; assert(!valid()); // Audio end must target main, even with valid BUSY feedback.
  fixture(); bytes[image.trigger(1)] = 2; bytes[image.trigger(1) + 2] = 13;
  bytes[image.trigger(1) + 3] = 0; word(image.trigger(1) + 4, 100); bytes[image.trigger(1) + 6] = 10;
  assert(valid()); // Ordinary threshold ultrasonic can launch a child.
  fixture(); bytes[mappings + 2] |= 128; assert(valid()); // Digital release can launch a child.
  fixture(); bytes[mappings + 2] = 15; assert(!valid());
}

static void testExtensionValidation() {
  fixture();
  const uint16_t end = length, trigger = image.trigger(3);
  bytes[trigger] = 2; bytes[trigger + 2] = 13; bytes[trigger + 3] = 0;
  word(trigger + 4, 100); bytes[trigger + 6] = 10;
  memset(bytes + end, 0, 24); length += 24; bytes[16] |= 128;
  bytes[end] = 3; word(end + 1, 2); word(end + 3, 100); bytes[end + 5] = 10;
  bytes[end + 7] = 1; bytes[end + 8] = 1;
  bytes[end + 10] = 0; bytes[end + 11] = 2;
  bytes[end + 16] = 'Z'; bytes[end + 17] = 'N'; bytes[end + 18] = 1; bytes[end + 19] = 1;
  word(end + 20, 1); word(end + 22, end); assert(valid());
  bytes[end + 11] = 3; assert(!valid()); // Zone state action cannot bypass child launch rules.

  fixture();
  // Add a valid NEC command and timed main cue without changing record sizes.
  bytes[image.player(0) + 1] = 14; bytes[image.player(0) + 2] = 15;
  bytes[image.output(1)] = 6; // Free IR's Uno TX9/RX2 pins.
  memset(bytes + end, 0, 32); length += 32; bytes[16] |= 128;
  bytes[end] = 1; // Timed cue belongs to main state1.
  bytes[end + 5] = 38; bytes[end + 6] = 1; word(end + 12, 50);
  bytes[end + 16] = 9; bytes[end + 17] = 2; bytes[end + 18] = 1; word(end + 20, 1);
  bytes[end + 24] = 'Z'; bytes[end + 25] = 'N'; bytes[end + 26] = 2; word(end + 30, end);
  assert(valid()); bytes[end] = 3; assert(!valid()); // No timed IR on output-only children.
}

static void testIndependentTimeline() {
  fixture(); cpc::SceneRuntime scene; scene.begin(&image); scene.run(1000);
  assert(!scene.trigger(2, 1050) && !scene.activeChildren()); // Mapping unavailable in idle.
  assert(scene.trigger(1, 1100) && scene.currentState == 1);
  assert(scene.activeOutputs(1200) == 1);
  assert(!scene.trigger(2, 1250) && scene.currentState == 1 && scene.enteredAt == 1100);
  assert(scene.activeChildren() == 8 && scene.activeOutputs(1250) == 3);
  assert(!scene.trigger(2, 1300) && scene.childAt[3] == 1250); // Running retrigger ignored.
  assert(!scene.trigger(4, 1300));
  assert(scene.activeOutputs(1399) == 3 && scene.activeOutputs(1400) == 7);
  assert(scene.activeOutputs(1499) == 7 && scene.activeOutputs(1500) == 5);
  assert(scene.activeChildren() == 16 && scene.coolingChildren() == 8);
  assert(!scene.trigger(2, 1600) && scene.childAt[3] == 1250); // Cooldown not extended.
  assert(scene.activeOutputs(1700) == 1); // ChildB's event ends before its timeline.
  assert(scene.activeOutputs(1800) == 1 && scene.coolingChildren() == 24);
  scene.updateChildren(2300); assert(scene.coolingChildren() == 8);
  assert(!scene.trigger(2, 3499) && scene.childAt[3] == 1250);
  assert(!scene.trigger(2, 3500) && scene.childAt[3] == 3500 && scene.activeChildren() == 8);
  assert(scene.enteredAt == 1100 && scene.activeOutputs(3500) == 2);
  assert(scene.activeOutputs(4200) == 1); // Parent's loop retained its original phase.

  scene.run(0); scene.trigger(1, 0); scene.trigger(6, 100);
  assert(scene.activeOutputs(200) == 7);
  assert(scene.trigger(8, 200) && scene.currentState == 2 && scene.enteredAt == 200);
  assert(scene.activeOutputs(200) == 6 && scene.activeChildren() == 24);
  scene.activeOutputs(350); assert(scene.activeChildren() == 16 && scene.coolingChildren() == 8);
  assert(!scene.trigger(4, 1100) && scene.childAt[4] == 100); // New parent's mappings determine availability.
  scene.stop(); assert(!scene.activeChildren() && !scene.coolingChildren() && !scene.activeOutputs(1200));
  assert(!scene.trigger(2, 1200));
  scene.run(1300); assert(!scene.busyChildren && scene.currentState == 0);
}

static void testDispatchAndWrap() {
  fixture(); const uint16_t t = image.transition(image.u16(image.state(1) + 8));
  bytes[t] = 3; bytes[t + 1] = 2; bytes[t + 2] = 1; bytes[t + 3] = 3; bytes[t + 4] = 2; bytes[t + 5] = 4;
  assert(valid());
  cpc::SceneRuntime scene; scene.begin(&image); scene.run(0); scene.trigger(1, 0);
  assert(scene.trigger(14, 100) && scene.currentState == 2 && scene.activeChildren() == 24);
  assert(scene.activeOutputs(200) == 6); // Children after the main mapping still launch from original state.
  bytes[t + 3] = 0; assert(valid()); scene.run(0); scene.trigger(1, 0);
  assert(scene.trigger(14, 100) && scene.currentState == 2 && scene.activeChildren() == 16); // First main wins.

  fixture(); scene.begin(&image); scene.run(0xfffffe00UL); scene.trigger(1, 0xfffffe00UL);
  assert(!scene.trigger(2, 0xfffffff0UL) && scene.activeOutputs(0xfffffff0UL) == 3);
  assert(scene.activeOutputs(0x000000e9UL) == 3);
  assert(scene.activeOutputs(0x000000eaUL) == 1 && scene.coolingChildren() == 8);
  assert(!scene.trigger(2, 0x000008b9UL) && scene.childAt[3] == 0xfffffff0UL);
  assert(!scene.trigger(2, 0x000008baUL) && scene.childAt[3] == 0x000008baUL);
  // A zero cooldown permits a new activation exactly at completion, not before.
  fixture(); word(image.state(3) + 14, 0); assert(valid()); scene.run(0); scene.trigger(1, 0); scene.trigger(2, 0);
  scene.trigger(2, 249); assert(scene.childAt[3] == 0); scene.trigger(2, 250); assert(scene.childAt[3] == 250);
  // Expired bookkeeping is cleared, so a later millis rollover cannot revive a child.
  scene.activeOutputs(1000); assert(!scene.busyChildren); assert(scene.activeOutputs(250) == 1);
}

static void testReleaseAndTimer() {
  fixture(); const uint16_t t = image.transition(image.u16(image.state(1) + 8));
  bytes[t] |= 128; assert(valid());
  cpc::SceneRuntime scene; scene.begin(&image); scene.run(0); scene.trigger(1, 0);
  assert(!scene.trigger(2, 100) && !scene.activeChildren());
  assert(!scene.trigger(0, 200, 2) && scene.activeChildren() == 8);
  fixture(); const uint16_t trigger = image.trigger(1);
  bytes[trigger] = 3; bytes[trigger + 1] = bytes[trigger + 2] = 255; bytes[trigger + 3] = 0;
  word(trigger + 4, 10); bytes[trigger + 6] = bytes[trigger + 7] = 0; assert(valid());
  scene.begin(&image); scene.run(0); scene.trigger(1, 0);
  assert(!scene.timerEdges(499)); assert(!scene.trigger(scene.timerEdges(500), 500));
  assert(scene.activeChildren() == 8 && scene.enteredAt == 0);
}

int main(int argc, char** argv) {
  assert(argc == 2); FILE* file = fopen(argv[1], "rb"); assert(file);
  originalLength = static_cast<uint16_t>(fread(original, 1, sizeof(original), file)); fclose(file);
  assert(originalLength >= cpc::HeaderSize);
  testValidation(); testExtensionValidation(); testIndependentTimeline(); testDispatchAndWrap(); testReleaseAndTimer();
  puts("Parallel child firmware tests passed: CPC3 validation/ownership, independent parent timeline, concurrent children, retrigger/cooldown endpoints, main-transition priority, scope, STOP/reset, release/timer and clock wrap.");
}
