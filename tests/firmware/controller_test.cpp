#define _CRT_SECURE_NO_WARNINGS
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sstream>
#include <string>
#define __AVR_ATmega2560__
#define CPC_BOARD_ID 4
#include <Arduino.h>
#include <EEPROM.h>

static uint32_t fakeMillis = 0;
static void (*afterPrint)() = nullptr;
static uint8_t pins[70] = {};
static const uint8_t LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1, INPUT_PULLUP = 2;
static uint32_t millis() { return fakeMillis; }
static uint32_t micros() { return fakeMillis * 1000; }
static void digitalWrite(uint8_t pin, uint8_t value) { pins[pin] = value; }
static int digitalRead(uint8_t pin) { return pins[pin]; }
static void pinMode(uint8_t pin, uint8_t mode) { if (mode == INPUT_PULLUP) pins[pin] = HIGH; }
struct __FlashStringHelper {};
#define F(value) reinterpret_cast<const __FlashStringHelper*>(value)
struct HostSerial {
  std::string text;
  uint32_t printDelay = 0;
  void begin(unsigned long) {}
  int available() const { return 0; }
  int read() { return -1; }
  void print(const __FlashStringHelper* value) { print(reinterpret_cast<const char*>(value)); }
  template <typename T> void print(T value) {
    std::ostringstream out; out << value; text += out.str(); fakeMillis += printDelay;
    if (afterPrint) afterPrint();
  }
  void print(uint8_t value) { print(static_cast<unsigned>(value)); }
  template <typename T> void println(T value) { print(value); text += '\n'; }
} Serial;
HardwareSerial Serial1, Serial2, Serial3;
FakeEEPROM EEPROM;

// Exercise the actual dispatcher and command paths, including serial logging
// that moves millis() forward between ordered actions in one loop iteration.
#ifdef _MSC_VER
#pragma warning(push)
// AVR integers and size_t are 16-bit; the host equivalents are wider. The
// controller bounds these conversions before use, as on the physical board.
#pragma warning(disable: 4244 4267)
#endif
#include "../../firmware/src/main.cpp"
#ifdef _MSC_VER
#pragma warning(pop)
#endif

static void word(uint16_t address, uint16_t value) {
  EEPROM.bytes[address] = value & 255; EEPROM.bytes[address + 1] = value >> 8;
}
static void fixture() {
  memset(EEPROM.bytes, 0, sizeof(EEPROM.bytes));
  uint8_t* b = EEPROM.bytes;
  memcpy(b, "CPC1", 4); word(4, 156);
  b[8] = 4; b[10] = 2; b[11] = 3; b[12] = 3;
  word(14, 1); b[16] = 128 | 1 | (8 << 2); b[17] = 4; b[18] = 20;
  word(20, 32); word(22, 32); word(24, 48); word(26, 60); word(28, 108); word(30, 108);
  b[32] = 2; b[33] = 2; b[34] = 3; word(36, 100); b[38] = 10;
  b[41] = 4; b[42] = 255; b[43] = 3;
  for (uint8_t i = 0; i < 3; ++i) {
    b[49 + i * 4] = 18 - i * 2; b[50 + i * 4] = 19 - i * 2;
    word(60 + i * 16, 100); word(68 + i * 16, i); b[70 + i * 16] = 1;
    b[108 + i * 2] = 1; b[109 + i * 2] = (i + 1) % 3;
  }
  word(78, 2); b[87] = 25; word(94, 3); b[103] = 30;
  b[114] = 0; word(115, 2); word(117, 100); b[119] = 10;
  b[120] = 0; b[121] = 4; b[122] = 4;
  b[124] = 0; b[125] = 1;
  b[130] = 1; b[131] = 1; word(132, 12); word(134, 4);
  b[136] = 0; b[137] = 2;
  b[142] = 1; b[143] = 1; word(144, 7); word(146, 4);
  b[148] = 'Z'; b[149] = 'N'; b[150] = 1; b[151] = 1; word(152, 4); word(154, 114);
  word(6, image.crc(156)); assert(image.valid(4096, 4));
  Serial = HostSerial{}; Serial1 = HardwareSerial{}; Serial2 = HardwareSerial{}; Serial3 = HardwareSerial{};
  fakeMillis = 0; validScene = true; uploading = virtualMagic = beginPending = false;
  setupScene();
}
static void advance(uint32_t to) {
  while (fakeMillis < to) {
    Serial1.now = Serial2.now = Serial3.now = fakeMillis;
    audio.update(fakeMillis, false); ++fakeMillis;
  }
}
static uint32_t volumeAt(const HardwareSerial& port, uint8_t level, uint32_t after) {
  for (size_t i = 0; i + 10 <= port.bytes.size(); i += 10) {
    assert(port.bytes[i] == 0x7e && port.bytes[i + 9] == 0xef);
    if (port.emittedAt[i] >= after && port.bytes[i + 3] == 6 && port.bytes[i + 6] == level)
      return port.emittedAt[i];
  }
  return UINT32_MAX;
}
static void send(const char* text) { strcpy(line, text); command(); }
static void testOrderedActionTimestamps() {
  fixture(); advance(4000);
  assert(volumeAt(Serial1, 20, 0) != UINT32_MAX);
  fakeMillis = 5000; Serial.printDelay = 5;
  sonarNext = micros() + 60000;
  changedSensor = 0; exitedZone = 255; enteredZone = 0;
  loop();
  assert(fakeMillis == 5030); // Two state reports each advance the wall clock.
  assert(engine.currentState == 2 && engine.enteredAt == 5000);
  advance(5200);
  assert(volumeAt(Serial1, 8, 5000) == UINT32_MAX); // No unsigned elapsed-time underflow.
  advance(6000);
  assert(volumeAt(Serial1, 8, 5000) >= 5200 && volumeAt(Serial1, 8, 5000) < 5400);
  assert(volumeAt(Serial3, 7, 5000) != UINT32_MAX); // Last state then volume action wins.
  assert(volumeAt(Serial3, 30, 5000) == UINT32_MAX);
}
static void testCommandsAndResetBaseline() {
  fixture(); advance(4000); Serial.printDelay = 5;
  const unsigned initialState = engine.currentState;
  send("TRIGGER 0"); assert(engine.currentState == initialState);
  assert(Serial.text.find("Distance zones require a sensor reading") != std::string::npos);
  fakeMillis = 5000; send("TRIGGER 1");
  assert(engine.currentState == 1 && engine.enteredAt == 5000);
  advance(5200); assert(volumeAt(Serial1, 8, 5000) == UINT32_MAX);
  advance(6000); assert(volumeAt(Serial1, 8, 5000) >= 5200);
  zones[0].initialized = true; zones[0].current = 0; changedSensor = 0;
  fakeMillis = 6500; send("RESET");
  assert(engine.currentState == 0 && engine.enteredAt == 6500);
  assert(!zones[0].initialized && changedSensor == 255);
  advance(6700); assert(volumeAt(Serial1, 20, 6500) == UINT32_MAX);
  advance(7000); assert(volumeAt(Serial1, 20, 6500) >= 6700);
  changedSensor = 0; send("STOP"); assert(!engine.running && changedSensor == 255);
  advance(7500); assert(audio.stopped());
  fakeMillis = 8000; send("RUN");
  assert(engine.running && engine.currentState == 0 && engine.enteredAt == 8000 && !zones[0].initialized);
}
static void testResidentFadeTimestamp() {
  fixture();
  // Both ordered states keep ambient alone. No foreground startup packet can
  // preempt the scheduler's resident-ambient fade evaluation in this iteration.
  word(78, 0); word(94, 0);
  advance(4000); audio.volume(0, 4, 0, 4000); advance(4500);
  assert(volumeAt(Serial1, 4, 4000) != UINT32_MAX);
  fakeMillis = 5000; Serial.printDelay = 5; sonarNext = micros() + 60000;
  changedSensor = 0; exitedZone = 255; enteredZone = 0;
  loop(); assert(fakeMillis == 5030 && engine.enteredAt == 5000);
  advance(5200); assert(volumeAt(Serial1, 20, 5000) == UINT32_MAX);
  advance(5500); assert(volumeAt(Serial1, 20, 5000) >= 5200);
}
static void loadIrFixture(const char* path) {
  stop(); FILE* file = fopen(path, "rb"); assert(file);
  const size_t size = fread(EEPROM.bytes, 1, sizeof(EEPROM.bytes), file); fclose(file);
  assert(size >= 48 && image.valid(sizeof(EEPROM.bytes), EEPROM.bytes[8]) && image.hasIr());
  Serial = HostSerial{}; fakeMillis = 0; validScene = true; uploading = virtualMagic = beginPending = false;
  setupScene();
}
static void finishIrFrame() {
  unsigned budget = 20000;
  while (ir.transmitting() && budget--) {
    if (cpc::irDriver::position & 1) cpc::irDriver::spaceDone(); else cpc::irDriver::carrierTick();
  }
  assert(budget);
}
static void finishDuringLogging() { if (fakeMillis >= 1090 && ir.transmitting()) finishIrFrame(); }
static void installIrCommand() {
  const uint16_t footer = image.irFooter(), length = image.u16(4) + 12;
  memmove(EEPROM.bytes + footer + 12, EEPROM.bytes + footer, 16);
  memset(EEPROM.bytes + footer, 0, 12);
  EEPROM.bytes[footer + 1] = 38; EEPROM.bytes[footer + 2] = 1;
  word(footer + 4, 0x00ff); word(footer + 6, 0x00ff); word(footer + 8, 100);
  EEPROM.bytes[footer + 14] = 1; word(4, length); word(6, image.crc(length));
  assert(image.valid(sizeof(EEPROM.bytes), EEPROM.bytes[8]));
  ir.begin(&image); ir.enter(0, 0); assert(ir.enqueue(0));
}
static void testIrCompletionTimestamps(const char* emptyScene) {
  loadIrFixture(emptyScene); installIrCommand(); fakeMillis = 1000;
  // The first loop update starts a frame. A debounced button changes state,
  // and the frame's ISR completes while that state report blocks on serial.
  inputs[0].reset(false, 800); inputs[0].update(true, 850, 100);
  pins[image.b(image.trigger(0) + 1)] = LOW;
  Serial.printDelay = 30; afterPrint = finishDuringLogging;
  loop(); afterPrint = nullptr; Serial.printDelay = 0;
  assert(fakeMillis == 1090 && !ir.transmitting() && ir.busy());
  fakeMillis = 1100; loop(); assert(ir.busy()); // Never shorten the physical gap to 10ms.
  fakeMillis = 1189; loop(); assert(ir.busy());
  fakeMillis = 1190; loop(); assert(!ir.busy());

  loadIrFixture(emptyScene); installIrCommand(); fakeMillis = 1000;
  ir.update(fakeMillis, true, true); assert(ir.transmitting());
  Serial.printDelay = 30; afterPrint = finishDuringLogging;
  stateChanged(1000); assert(fakeMillis == 1090 && !ir.transmitting());
  stateChanged(1000); // A second ordered action observes the completed frame.
  afterPrint = nullptr; Serial.printDelay = 0;
  assert(fakeMillis == 1180); ir.update(fakeMillis, true, true); assert(ir.busy());
  ir.update(1189, true, true); assert(ir.busy());
  ir.update(1190, true, true); assert(!ir.busy());
}
static void testIrCommands(const char* emptyScene) {
  fixture(); Serial.text.clear(); send("IRLEARN");
  assert(Serial.text.find("Upload an IR-enabled scene") != std::string::npos && engine.running);
  loadIrFixture(emptyScene);
  uint8_t saved[4096]; memcpy(saved, EEPROM.bytes, sizeof(saved));
  send("IRBEGIN 0 0 1 100 16711935"); assert(!engine.running && ir.staging());
  assert(Serial.text.find("\"command\":\"IRBEGIN\"") != std::string::npos);
  send("IRPLAY"); loop();
  // IR waits until every audio STOP frame has drained, if the starter has audio.
  for (uint32_t i = 0; i < 1000 && !ir.transmitting(); ++i) { ++fakeMillis; loop(); }
  assert(ir.transmitting() && cpc::irDriver::pulseCount == 67);
  send("STOP"); assert(!ir.transmitting() && !ir.busy() && !engine.running);
  send("IRBEGIN 1 5 1 50 0"); send("IRDATA 0 0A140A"); assert(ir.stagedOffset() == 3);
  send("IRDATA 0 140A"); assert(ir.stagedOffset() == 3);
  send("IRPLAY"); assert(ir.staging());
  send("IRDATA 3 140A"); send("IRPLAY");
  for (uint32_t i = 0; i < 1000 && !ir.transmitting(); ++i) { ++fakeMillis; loop(); }
  assert(ir.transmitting() && cpc::irDriver::pulseCount == 5); finishIrFrame();
  loop(); assert(ir.busy()); fakeMillis += 50; loop(); assert(!ir.busy());
  Serial.text.clear(); send("IRLEARN"); assert(!engine.running && ir.learning());
  assert(Serial.text.empty()); // IRLEARN has no early success ACK.
  for (uint32_t i = 0; i < 1000 && !cpc::irDriver::capture.active; ++i) { ++fakeMillis; loop(); }
  assert(cpc::irDriver::capture.active);
  uint32_t stamp = micros() + 20000; cpc::irDriver::capture.edge(false, stamp);
  const uint8_t values[] = {180, 90, 11, 34, 11};
  for (uint8_t i = 0; i < 5; ++i) { stamp += values[i] * 50; cpc::irDriver::capture.edge(!(i & 1), stamp); }
  fakeMillis = (stamp + 15000 + 999) / 1000; loop();
  assert(Serial.text.find("\"pulsesUs\":[9000,4500,550,1700,550]") != std::string::npos);
  assert(!engine.running && !ir.learning());
  send("IRLEARN"); loop(); send("STOP");
  assert(!cpc::irDriver::capture.active && !ir.learning());
  Serial.text.clear(); fakeMillis += 11000; loop(); assert(Serial.text.empty()); // No stale capture after cancel.
  assert(!memcmp(saved, EEPROM.bytes, sizeof(saved))); // Training/testing is entirely in RAM.
}
int main(int argc, char** argv) {
  testOrderedActionTimestamps(); testCommandsAndResetBaseline(); testResidentFadeTimestamp();
  if (argc > 1) { testIrCommands(argv[1]); testIrCompletionTimestamps(argv[1]); }
  puts("Controller host tests passed: ordered action timestamps, serial logging delay, zone trigger rejection, legacy trigger, RESET/RUN baseline, IR learning/staged playback/EEPROM preservation, STOP cancellation.");
}
