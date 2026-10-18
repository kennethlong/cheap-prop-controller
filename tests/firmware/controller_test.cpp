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
static uint32_t pinReads[70] = {};
static const uint8_t LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1, INPUT_PULLUP = 2;
static uint32_t millis() { return fakeMillis; }
static uint32_t micros() { return fakeMillis * 1000; }
static void digitalWrite(uint8_t pin, uint8_t value) { assert(pin < 70); pins[pin] = value; }
static int digitalRead(uint8_t pin) { assert(pin < 70); ++pinReads[pin]; return pins[pin]; }
static void pinMode(uint8_t pin, uint8_t mode) { assert(pin < 70); if (mode == INPUT_PULLUP) pins[pin] = HIGH; }
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
  fakeMillis = 0; pendingReports = 0; validScene = true; uploading = virtualMagic = beginPending = false;
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
static void outputFixture() {
  stop(); memset(EEPROM.bytes, 0, sizeof(EEPROM.bytes));
  uint8_t* b = EEPROM.bytes; memcpy(b, "CPC2", 4); word(4, 52);
  b[8] = 4; b[9] = 2; b[12] = 1;
  word(20, 32); word(22, 36); word(24, 36); word(26, 36); word(28, 52); word(30, 52);
  b[32] = 4; b[33] = 3; b[34] = 5; word(36, 20); b[48] = 1;
  word(6, image.crc(52)); assert(image.valid(4096, 4));
  Serial = HostSerial{}; fakeMillis = 0; validScene = true; uploading = virtualMagic = beginPending = false;
  setupScene(); assert(outputMask == 1 && pins[4] == LOW);
}
static void beginTest() {
  char text[48]; sprintf(text, "TESTBEGIN %u %u", image.u16(4), image.u16(6)); send(text);
}
static void testOutputTestMode() {
  outputFixture(); uint8_t saved[4096]; memcpy(saved, EEPROM.bytes, sizeof(saved));
  send("TESTBEGIN 52 0"); assert(engine.running && !testingOutputs && outputMask == 1);
  send("TESTBEGIN 51 0"); assert(engine.running && !testingOutputs);
  beginTest(); assert(testingOutputs && !engine.running && outputMask == 0 && pins[4] == HIGH && pins[5] == LOW);
  send("TEST 1"); assert(outputMask == 1 && pins[4] == LOW && pins[5] == LOW);
  fakeMillis = 1000; send("TEST 2"); assert(outputMask == 2 && pins[4] == HIGH && pins[5] == HIGH);
  send("TEST 4"); assert(outputMask == 2);
  send("TEST -1"); assert(outputMask == 2);
  send("TEST 4294967296"); assert(outputMask == 2);
  send("RUN"); send("RESET"); send("TRIGGER 0"); send("IRLEARN"); send("BEGIN 52 0");
  assert(testingOutputs && !engine.running && !uploading && outputMask == 2);
  assert(!memcmp(saved, EEPROM.bytes, sizeof(saved)));
  fakeMillis = 2499; loop(); assert(testingOutputs && outputMask == 2);
  fakeMillis = 2500; loop(); assert(!testingOutputs && !engine.running && !outputMask && pins[4] == HIGH && pins[5] == LOW);
  send("TEST 1"); assert(!testingOutputs && !outputMask);
  beginTest(); send("TEST 3"); assert(outputMask == 3);
  fakeMillis = 3000; send("TEST 0"); assert(testingOutputs && !outputMask);
  fakeMillis = 4499; loop(); assert(testingOutputs);
  send("STOP"); assert(!testingOutputs && !outputMask && !engine.running);
  assert(!memcmp(saved, EEPROM.bytes, sizeof(saved)));
  fakeMillis = 0xfffffff0UL; beginTest(); send("TEST 3");
  fakeMillis = 0x5cbUL; loop(); assert(testingOutputs);
  fakeMillis = 0x5ccUL; send("TEST 1"); assert(!testingOutputs && !outputMask); // Expired command cannot renew itself.
  Serial.text.clear(); send("STATUS");
  assert(Serial.text.find("\"testingOutputs\":false") != std::string::npos);
  assert(Serial.text.find("\"sceneControls\":true") != std::string::npos);
  assert(Serial.text.find("\"outputTest\":true") != std::string::npos);
}
static void testCpc2UploadCommit() {
  outputFixture(); const uint16_t length = image.u16(4), crc = image.u16(6);
  uint8_t saved[52]; memcpy(saved, EEPROM.bytes, sizeof(saved));
  char text[96]; sprintf(text, "BEGIN %u %u", length, crc); send(text); loop();
  assert(uploading && !beginPending && !validScene && EEPROM.bytes[0] == 0);
  for (uint16_t offset = 0; offset < length;) {
    const uint8_t count = length - offset > 32 ? 32 : static_cast<uint8_t>(length - offset);
    int written = sprintf(text, "DATA %u ", offset);
    for (uint8_t i = 0; i < count; ++i) written += sprintf(text + written, "%02x", saved[offset + i]);
    send(text); offset += count;
  }
  assert(uploadVersion == '2' && image.b(3) == '2' && EEPROM.bytes[0] == 0);
  send("COMMIT"); assert(validScene && !uploading && !virtualMagic && engine.running);
  assert(!memcmp(saved, EEPROM.bytes, sizeof(saved)) && image.valid(4096, 4));
}
static void testFeedbackEchoScheduling() {
  fixture(); EEPROM.bytes[3] = '2';
  EEPROM.bytes[51] = 7; EEPROM.bytes[55] = 8; EEPROM.bytes[59] = 9;
  word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4)); setupScene();
  memset(pinReads, 0, sizeof(pinReads));
  fakeMillis = 100; sonarPhase = 2; sonarIndex = 0; sonarAt = micros(); pins[3] = LOW;
  loop(); assert(sonarPhase == 2 && !pinReads[6] && !pinReads[7] && !pinReads[8]);
  send("STATUS"); assert(!pinReads[6] && !pinReads[7] && !pinReads[8]); // Status reports cached BUSY.
  sonarPhase = 0; sonarNext = micros() + 60000; loop();
  assert(pinReads[6] == 1 && pinReads[7] == 1 && pinReads[8] == 1);
  ++fakeMillis; loop(); assert(pinReads[6] == 1); //10ms minimum polling interval.
  fakeMillis += 9; loop(); assert(pinReads[6] == 2);
}
static void beginPartialAudioPacket() {
  fixture();
  // Stop just after the PLAY command byte reaches the real audio dispatcher.
  // The UART fake records byte times; it does not assume decoder acceptance.
  for (; fakeMillis < 4000; ++fakeMillis) {
    Serial1.now = Serial2.now = Serial3.now = fakeMillis;
    audio.update(fakeMillis, false);
    if (Serial1.bytes.size() % 10 == 4 && Serial1.bytes.back() == 0x0f) {
      assert(!audio.transportIdle()); return;
    }
  }
  assert(false);
}
static void testSonarWaitsForAudioPacket() {
  beginPartialAudioPacket();
  const size_t prefix = Serial1.bytes.size();
  sonarNext = micros();
  while (!audio.transportIdle()) {
    Serial1.now = Serial2.now = Serial3.now = fakeMillis;
    loop();
    assert(sonarPhase == 0); // A due ping cannot split a partially sent PLAY.
    ++fakeMillis;
  }
  assert(Serial1.bytes.size() == prefix + 6 && Serial1.bytes.back() == 0xef);
  loop(); assert(sonarPhase == 1); // Sampling resumes as soon as the packet drains.
}
static void assertReportWindow() {
  assert(!sonarPhase && audio.transportIdle() && !ir.transmitting());
}
static void testDeferredReports() {
  fixture(); advance(4000);
  Serial = HostSerial{}; Serial.printDelay = 1;
  sonarPhase = 2; sonarIndex = 0; sonarAt = micros(); pins[3] = LOW;
  const uint32_t requestedAt = fakeMillis;
  send("STATUS"); send("HELLO");
  assert(Serial.text.empty() && fakeMillis == requestedAt);
  loop(); assert(sonarPhase == 2 && Serial.text.empty());
  fakeMillis += 31; loop(); // The echo timeout, not reporting, ends the acquisition.
  assert(!sonarPhase && Serial.text.empty());
  afterPrint = assertReportWindow;
  loop(); loop();
  afterPrint = nullptr;
  assert(Serial.text.find("\"type\":\"status\"") != std::string::npos);
  assert(Serial.text.find("\"type\":\"hello\"") != std::string::npos);
  assert(fakeMillis > requestedAt + 31); // Logging really stalls this test clock.

  beginPartialAudioPacket();
  Serial = HostSerial{}; Serial.printDelay = 1;
  const uint32_t packetAt = fakeMillis;
  send("STATUS"); assert(Serial.text.empty() && fakeMillis == packetAt);
  sonarNext = micros() + 60000;
  afterPrint = assertReportWindow;
  for (uint8_t i = 0; Serial.text.empty() && i < 20; ++i) { loop(); ++fakeMillis; }
  afterPrint = nullptr;
  assert(Serial.text.find("\"type\":\"status\"") != std::string::npos);
  assert(Serial1.bytes.size() % 10 == 0); // Report follows the final PLAY byte.

  beginPartialAudioPacket(); Serial.text.clear();
  send("STATUS"); assert(Serial.text.empty());
  send("STOP");
  assert(!engine.running && !outputMask);
  const size_t stopAck = Serial.text.find("\"command\":\"STOP\"");
  assert(stopAck != std::string::npos && Serial.text.find("\"type\":\"status\"") == std::string::npos);
  for (uint8_t i = 0; i < 20 && Serial.text.find("\"type\":\"status\"") == std::string::npos; ++i) { loop(); ++fakeMillis; }
  assert(Serial.text.find("\"type\":\"status\"") > stopAck);
  assert(Serial.text.find("\"running\":false") != std::string::npos);
}
static void feedbackControllerFixture() {
  fixture(); EEPROM.bytes[3] = '2';
  EEPROM.bytes[51] = 7; EEPROM.bytes[55] = 8; EEPROM.bytes[59] = 9;
  EEPROM.bytes[89] = EEPROM.bytes[105] = 1;
  pins[6] = pins[7] = pins[8] = HIGH;
  word(6, image.crc(image.u16(4))); assert(image.valid(4096, 4)); setupScene();
  advance(4000); send("TRIGGER 1"); advance(5000);
  assert(engine.currentState == 1);
}
static void feedbackLoop(uint32_t at) { fakeMillis = at; sonarPhase = 0; sonarNext = micros() + 60000; loop(); }
static void testAudioEndControllerPriority() {
  feedbackControllerFixture();
  pins[7] = LOW; feedbackLoop(5000); feedbackLoop(5100);
  assert(audio.feedbackStatus(1) == cpc::AudioFeedback::Playing);
  pins[7] = HIGH; feedbackLoop(5200); assert(engine.currentState == 1);
  feedbackLoop(5300); assert(engine.currentState == 0 && engine.enteredAt == 5300);

  feedbackControllerFixture();
  pins[7] = LOW; feedbackLoop(5000); feedbackLoop(5100);
  pins[7] = HIGH; feedbackLoop(5200);
  pins[4] = LOW; feedbackLoop(5300); // Physical transition to2 wins over old track ending to0.
  assert(engine.currentState == 2 && engine.enteredAt == 5300);

  feedbackControllerFixture();
  pins[7] = LOW; feedbackLoop(5000); feedbackLoop(5100);
  pins[7] = HIGH; feedbackLoop(5200);
  changedSensor = 0; exitedZone = 255; enteredZone = 0;
  feedbackLoop(5300); assert(engine.currentState == 2); // Zone actions beat old foreground completion too.

  feedbackControllerFixture(); feedbackLoop(11000);
  assert(engine.currentState == 1 && audio.feedbackStatus(1) == cpc::AudioFeedback::Failed);
  Serial.text.clear(); send("STATUS");
  assert(Serial.text.find("\"feedback\":\"failed\",\"busy\":false") != std::string::npos);
}
static void loadParallelFixture(const char* path) {
  stop(); memset(EEPROM.bytes, 0, sizeof(EEPROM.bytes));
  FILE* file = fopen(path, "rb"); assert(file);
  const size_t length = fread(EEPROM.bytes, 1, sizeof(EEPROM.bytes), file); fclose(file);
  assert(length == 188);
  // Controller tests use three hardware UART fakes. Convert only board/pins;
  // the native core test validates the unmodified Uno compiler fixture too.
  EEPROM.bytes[8] = 4; EEPROM.bytes[image.player(0) + 1] = 18; EEPROM.bytes[image.player(0) + 2] = 19;
  word(6, image.crc(static_cast<uint16_t>(length))); assert(image.valid(4096, 4));
  Serial = HostSerial{}; Serial1 = HardwareSerial{}; Serial2 = HardwareSerial{}; Serial3 = HardwareSerial{};
  fakeMillis = 0; validScene = true; uploading = virtualMagic = beginPending = false; setupScene();
}
static void controllerAdvance(uint32_t to) {
  while (fakeMillis < to) {
    Serial1.now = Serial2.now = Serial3.now = fakeMillis;
    loop(); ++fakeMillis;
  }
  loop();
}
static void approachReady(const char* path) {
  loadParallelFixture(path); controllerAdvance(4000); send("TRIGGER 0"); controllerAdvance(5000);
  assert(engine.currentState == 1 && engine.enteredAt == 4000 && outputMask == 1);
  assert(Serial1.bytes.size() % 10 == 0);
}
static void testParallelControllerAndAudio(const char* path) {
  approachReady(path);
  const size_t audioBytes = Serial1.bytes.size();
  Serial.text.clear(); send("TRIGGER 1");
  assert(outputMask == 3 && pins[9] == HIGH); // Manual launch writes child outputs immediately.
  assert(engine.currentState == 1 && engine.enteredAt == 4000 && engine.activeChildren() == 8);
  assert(Serial.text.find("\"type\":\"state\"") == std::string::npos);
  send("STATUS");
  assert(Serial.text.find("\"activeChildren\":8,\"coolingChildren\":0") != std::string::npos);
  assert(Serial.text.find("\"parallelChildren\":true") != std::string::npos);
  assert(Serial.text.find("\"firmware\":\"0.7.2\"") != std::string::npos);
  controllerAdvance(5100); send("TRIGGER 2"); controllerAdvance(5200); assert(outputMask == 7);
  controllerAdvance(5249); assert(outputMask == 7);
  controllerAdvance(5250); assert(outputMask == 5 && pins[9] == LOW);
  Serial.text.clear(); send("STATUS");
  assert(Serial.text.find("\"activeChildren\":16,\"coolingChildren\":8") != std::string::npos);
  controllerAdvance(5500); assert(outputMask == 0); // Parent and second pulse retain their own deadlines.
  controllerAdvance(6000); assert(Serial1.bytes.size() == audioBytes); // No STOP/PLAY/volume/loop packet from children.
  assert(engine.currentState == 1 && engine.enteredAt == 4000);
  send("TRIGGER 1"); assert(engine.childAt[3] == 5000); // Ignored during cooldown.
  controllerAdvance(7250); send("TRIGGER 1"); assert(engine.childAt[3] == 7250 && pins[9] == HIGH);
  send("TRIGGER 3"); assert(engine.currentState == 2 && pins[9] == HIGH && engine.activeChildren() == 8);
  controllerAdvance(7500); assert(pins[9] == LOW); // Parent transition did not restart the pulse.
  send("STOP"); assert(!engine.busyChildren && !outputMask && !engine.running);

  approachReady(path); const size_t physicalAudioBytes = Serial1.bytes.size();
  pins[8] = LOW; loop(); assert(pins[9] == HIGH && engine.currentState == 1 && engine.enteredAt == 4000);
  pins[8] = HIGH; ++fakeMillis; loop();
  controllerAdvance(5250); assert(pins[9] == LOW && Serial1.bytes.size() == physicalAudioBytes);
  // RUN/RESET cancel both running and cooling children, clearing all leases.
  send("RESET"); assert(!engine.busyChildren && !outputMask && engine.currentState == 0);
  send("TRIGGER 0"); send("TRIGGER 1"); assert(engine.activeChildren() == 8);
  send("RUN"); assert(!engine.busyChildren && !outputMask && engine.currentState == 0);
  send("TRIGGER 0"); send("TRIGGER 1"); beginTest();
  assert(testingOutputs && !engine.running && !engine.busyChildren && !outputMask);
  send("TEST 2"); assert(outputMask == 2 && !engine.busyChildren);
  send("STOP"); assert(!testingOutputs && !outputMask);
}
static void testCpc3UploadCancelsChildren(const char* path) {
  approachReady(path); send("TRIGGER 1"); assert(engine.activeChildren() == 8);
  uint8_t saved[188]; memcpy(saved, EEPROM.bytes, sizeof(saved));
  const uint16_t length = image.u16(4), crc = image.u16(6);
  char text[96]; sprintf(text, "BEGIN %u %u", length, crc); send(text);
  assert(!engine.running && !engine.busyChildren && !outputMask && uploading && !validScene);
  controllerAdvance(6000); assert(!beginPending);
  for (uint16_t offset = 0; offset < length;) {
    const uint8_t count = length - offset > 32 ? 32 : static_cast<uint8_t>(length - offset);
    int written = sprintf(text, "DATA %u ", offset);
    for (uint8_t i = 0; i < count; ++i) written += sprintf(text + written, "%02x", saved[offset + i]);
    send(text); offset += count;
  }
  assert(uploadVersion == '3' && image.b(3) == '3' && EEPROM.bytes[0] == 0);
  send("COMMIT"); assert(validScene && !uploading && !virtualMagic && engine.running);
  assert(!engine.busyChildren && !outputMask && engine.currentState == 0);
  assert(!memcmp(saved, EEPROM.bytes, sizeof(saved)) && image.valid(4096, 4));
}
static void testManualAdvanceWithIndependentBeam(const char* path) {
  loadParallelFixture(path); stop();
  const uint16_t manual = image.trigger(0), length = image.u16(4);
  memset(EEPROM.bytes + manual, 0, 8);
  EEPROM.bytes[manual] = 4; EEPROM.bytes[manual + 1] = EEPROM.bytes[manual + 2] = 255;
  // One app-only trigger advances idle -> approach -> outro -> idle. The beam
  // remains a separate physical input and never owns a main-state transition.
  EEPROM.bytes[image.transition(3)] = 0;
  EEPROM.bytes[length] = 0; EEPROM.bytes[length + 1] = 0;
  ++EEPROM.bytes[image.state(2) + 10];
  for (uint8_t i = 3; i < image.b(12); ++i) word(image.state(i) + 8, image.u16(image.state(i) + 8) + 1);
  word(4, length + 2); word(6, image.crc(length + 2)); assert(image.valid(4096, 4));
  Serial = HostSerial{}; Serial1 = HardwareSerial{}; Serial2 = HardwareSerial{}; Serial3 = HardwareSerial{};
  fakeMillis = 0; memset(pinReads, 0, sizeof(pinReads)); setupScene();
  controllerAdvance(4000); assert(engine.currentState == 0 && !engine.busyChildren && !pinReads[4]);
  pins[8] = LOW; loop(); assert(engine.currentState == 0 && !engine.busyChildren);
  pins[8] = HIGH; ++fakeMillis; loop();
  send("HELLO"); assert(Serial.text.find("\"manualTriggers\":true") != std::string::npos);
  fakeMillis = 4100; send("TRIGGER 0"); controllerAdvance(5000);
  assert(engine.currentState == 1 && engine.enteredAt == 4100);
  const size_t audioBytes = Serial1.bytes.size();
  pins[8] = LOW; loop(); assert(engine.currentState == 1 && engine.enteredAt == 4100 && pins[9] == HIGH);
  pins[8] = HIGH; ++fakeMillis; loop(); controllerAdvance(5100);
  assert(Serial1.bytes.size() == audioBytes); // Beam preserves the approach audio.
  send("TRIGGER 0"); assert(engine.currentState == 2 && engine.activeChildren() == 8 && pins[9] == HIGH);
  controllerAdvance(5250); assert(pins[9] == LOW && engine.currentState == 2);
  send("TRIGGER 0"); assert(engine.currentState == 0);
  controllerAdvance(6000); assert(engine.currentState == 0 && !pinReads[4]);
  send("RESET"); assert(engine.currentState == 0 && !engine.busyChildren && !pinReads[4]);
  send("STOP"); send("TRIGGER 0"); assert(!engine.running && engine.currentState == 0);
  Serial.text.clear(); send("STATUS"); assert(Serial.text.find("\"manualTriggers\":true") != std::string::npos);
}
int main(int argc, char** argv) {
  testOrderedActionTimestamps(); testCommandsAndResetBaseline(); testResidentFadeTimestamp();
  if (argc > 1) { testIrCommands(argv[1]); testIrCompletionTimestamps(argv[1]); }
  testOutputTestMode(); testCpc2UploadCommit();
  testFeedbackEchoScheduling(); testSonarWaitsForAudioPacket(); testDeferredReports();
  testAudioEndControllerPriority();
  if (argc > 2) { testParallelControllerAndAudio(argv[2]); testCpc3UploadCancelsChildren(argv[2]); testManualAdvanceWithIndependentBeam(argv[2]); }
  puts("Controller host tests passed: output-test identity/watchdog/polarity/EEPROM preservation, CPC2/CPC3 upload, parallel physical/manual triggers with uninterrupted foreground packets/timeline, STOP/reset/upload/test child cancellation, sonar/MP3 packet arbitration, deferred reports and priority STOP, BUSY scheduling and end priority, ordered timestamps, RESET/RUN baseline, IR learning/staged playback.");
}
