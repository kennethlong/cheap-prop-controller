#define _CRT_SECURE_NO_WARNINGS
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sstream>
#include <string>
#include <vector>
#define F_CPU 16000000UL
#define CPC_BOARD_ID 1
#include <Arduino.h>
#include <EEPROM.h>

static uint32_t fakeMicros = 0;
static uint8_t pins[20], modes[20];
static uint32_t pinReads[20], pinWrites[20], pinHighWrites[20], pinModes[20];
static const uint8_t LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1, INPUT_PULLUP = 2;
static uint32_t millis() { return fakeMicros / 1000; }
static uint32_t micros() { return fakeMicros; }
static void digitalWrite(uint8_t pin, uint8_t value) {
  assert(pin < 20); pins[pin] = value; ++pinWrites[pin];
  if (value) ++pinHighWrites[pin];
}
static int digitalRead(uint8_t pin) { assert(pin < 20); ++pinReads[pin]; return pins[pin]; }
static void pinMode(uint8_t pin, uint8_t mode) {
  assert(pin < 20); modes[pin] = mode; ++pinModes[pin];
  if (mode == INPUT_PULLUP) pins[pin] = HIGH;
}
struct __FlashStringHelper {};
#define F(value) reinterpret_cast<const __FlashStringHelper*>(value)
struct HostSerial {
  std::string text;
  void begin(unsigned long) {}
  int available() const { return 0; }
  int read() { return -1; }
  void print(const __FlashStringHelper* value) { print(reinterpret_cast<const char*>(value)); }
  template <typename T> void print(T value) { std::ostringstream out; out << value; text += out.str(); }
  void print(uint8_t value) { print(static_cast<unsigned>(value)); }
  template <typename T> void println(T value) { print(value); text += '\n'; }
} Serial;
HardwareSerial Serial1, Serial2, Serial3;
FakeEEPROM EEPROM;
volatile uint8_t SREG = 0x80, TIMSK2 = 0, TCCR2A = 0, TCCR2B = 0, OCR2A = 0, TCNT2 = 0, TIFR2 = 0;
volatile uint8_t fakePorts[4] = {};

// Run the Uno controller's real dispatcher, GPIO initialization, upload, and
// Timer2 UART implementation against images produced by the TypeScript compiler.
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable: 4244 4267)
#endif
#include "../../firmware/src/main.cpp"
#ifdef _MSC_VER
#pragma warning(pop)
#endif

static std::vector<uint8_t> loadImage(const char* path) {
  FILE* file = fopen(path, "rb"); assert(file);
  uint8_t buffer[1025]; const size_t size = fread(buffer, 1, sizeof(buffer), file); fclose(file);
  assert(size >= 48 && size <= 1024);
  return std::vector<uint8_t>(buffer, buffer + size);
}
static void coldBoot(const char* path) {
  stop();
  const std::vector<uint8_t> bytes = loadImage(path);
  memset(EEPROM.bytes, 0, sizeof(EEPROM.bytes));
  memcpy(EEPROM.bytes, bytes.data(), bytes.size());
  memset(pins, 0, sizeof(pins)); memset(modes, 255, sizeof(modes));
  memset(pinReads, 0, sizeof(pinReads)); memset(pinWrites, 0, sizeof(pinWrites));
  memset(pinHighWrites, 0, sizeof(pinHighWrites)); memset(pinModes, 0, sizeof(pinModes));
  Serial = HostSerial{}; fakeMicros = 0; pendingReports = 0;
  uploading = virtualMagic = beginPending = testingOutputs = false;
  assert(image.valid(1024, 1)); setup(); assert(validScene && engine.running);
}
static void send(const char* text) { strcpy(line, text); command(); }
static void tick() {
  fakeMicros += 100;
  if (cpc::timerUart::busy()) TIMER2_COMPA_vect();
  loop();
}
static void advance(uint32_t milliseconds) {
  const uint32_t finish = millis() + milliseconds;
  while (millis() < finish) tick();
}
static void commandTrigger(uint8_t index) {
  char text[24]; sprintf(text, "TRIGGER %u", index); send(text);
}
static void beginOutputTest() {
  char text[48]; sprintf(text, "TESTBEGIN %u %u", image.u16(4), image.u16(6)); send(text);
  assert(testingOutputs && !engine.running);
}
static void testFullStandard(const char* full) {
  coldBoot(full);
  assert(image.b(9) == 6 && image.b(10) == 6 && image.b(11) == 1 && image.b(12) == 3);
  const uint8_t outputPins[] = {7, 6, 5, 4, 17, 18};
  for (uint8_t i = 0; i < 6; ++i) {
    assert(image.b(image.output(i)) == outputPins[i]);
    assert(modes[outputPins[i]] == OUTPUT);
  }
  assert(image.hasIr() && image.b(image.irFooter()) == 9 && image.b(image.irFooter() + 1) == 2);
  assert(image.b(image.player(0) + 1) == 3 && image.b(image.player(0) + 2) == 8);
  assert(modes[3] == OUTPUT && modes[8] == INPUT);
  assert(modes[10] == INPUT_PULLUP && modes[11] == INPUT);
  assert(modes[12] == OUTPUT && modes[13] == INPUT);
  assert(modes[14] == INPUT && modes[15] == OUTPUT && modes[16] == INPUT);
  assert(image.zoneCount() == 1 && image.b(image.zone(0)) == 4);
  assert(image.b(image.trigger(5)) == 4); // Manual Next follows five physical records.
  commandTrigger(5); assert(engine.currentState == 1 && pins[7] == HIGH && pins[18] == HIGH);
  commandTrigger(0); assert(engine.currentState == 1 && pins[17] == HIGH); // Parallel air pulse.
  advance(251); assert(pins[17] == LOW && pins[18] == HIGH && engine.currentState == 1);
}
static void testDisabledSlots(const char* sparse) {
  coldBoot(sparse);
  assert(image.b(9) == 5 && image.b(10) == 4 && image.b(12) == 3 && image.zoneCount() == 0);
  const uint8_t outputPins[] = {7, 5, 4, 17, 18};
  for (uint8_t i = 0; i < 5; ++i) assert(image.b(image.output(i)) == outputPins[i]);
  for (uint8_t pin = 14; pin <= 16; ++pin) assert(!pinModes[pin] && !pinWrites[pin] && !pinReads[pin]);
  assert(!pinModes[6] && !pinWrites[6]); // Removed active-low relay has no runtime record.
  assert(image.b(image.trigger(3)) == 4); // Manual Next is compacted to index 3.
  for (unsigned i = 0; i < 25000; ++i) {
    // A disconnected/absent backup can have arbitrary electrical readings.
    pins[14] = pins[16] = static_cast<uint8_t>(i & 1); tick();
  }
  assert(engine.currentState == 0 && !outputMask);
  assert(pinHighWrites[12] > 0 && pinReads[13] > 0); // Primary sonar is actually sampled.
  for (uint8_t pin = 14; pin <= 16; ++pin) assert(!pinModes[pin] && !pinWrites[pin] && !pinReads[pin]);
  pins[11] = HIGH; tick(); assert(engine.currentState == 1); // Primary PIR still works.
  send("RESET"); assert(engine.currentState == 0); // Held PIR does not retrigger at reset.
  commandTrigger(3); assert(engine.currentState == 1 && outputMask == 17);
  commandTrigger(0); assert(engine.currentState == 1 && outputMask == 25);
  assert(pins[17] == HIGH && pins[18] == HIGH);
  beginOutputTest(); assert(!outputMask && pins[17] == LOW && pins[18] == LOW);
  send("TEST 8"); assert(pins[17] == HIGH && pins[18] == LOW && outputMask == 8);
  send("TEST 16"); assert(pins[17] == LOW && pins[18] == HIGH && outputMask == 16);
  Serial.text.clear(); send("TEST 32"); assert(outputMask == 16 && Serial.text.find("error") != std::string::npos);
  send("STOP"); assert(pins[17] == LOW && pins[18] == LOW);
}
static void testUploadDisablesOldOutputs(const char* full, const char* inactive) {
  coldBoot(full);
  commandTrigger(5); commandTrigger(0);
  assert(pins[17] == HIGH && pins[18] == HIGH && pins[6] == LOW);
  const std::vector<uint8_t> bytes = loadImage(inactive);
  const uint16_t crc = bytes[6] | static_cast<uint16_t>(bytes[7]) << 8;
  char text[96]; sprintf(text, "BEGIN %u %u", static_cast<unsigned>(bytes.size()), crc); send(text);
  assert(uploading && !validScene && pins[17] == LOW && pins[18] == LOW && pins[6] == HIGH);
  for (unsigned i = 0; beginPending && i < 20000; ++i) tick();
  assert(!beginPending); // Previous player's STOP fully drains before EEPROM replacement.
  for (size_t offset = 0; offset < bytes.size();) {
    const size_t count = bytes.size() - offset > 32 ? 32 : bytes.size() - offset;
    int written = sprintf(text, "DATA %u ", static_cast<unsigned>(offset));
    for (size_t i = 0; i < count; ++i) written += sprintf(text + written, "%02x", bytes[offset + i]);
    send(text); offset += count;
  }
  send("COMMIT"); assert(validScene && !uploading && image.valid(1024, 1) && engine.running);
  assert(image.b(9) == 3 && image.b(10) == 1 && image.b(12) == 2 && !image.zoneCount());
  assert(image.b(image.trigger(0)) == 4); // Only manual remains; empty child was removed.
  memset(pinReads, 0, sizeof(pinReads)); memset(pinWrites, 0, sizeof(pinWrites));
  memset(pinModes, 0, sizeof(pinModes));
  advance(2500);
  for (uint8_t pin = 10; pin <= 16; ++pin) assert(!pinReads[pin] && !pinWrites[pin] && !pinModes[pin]);
  assert(!pinWrites[17] && !pinWrites[18] && pins[17] == LOW && pins[18] == LOW);
  // Legacy firmware retains inactive output modes. It must never retain an
  // active SSR level or re-drive that slot after its runtime record is removed.
  assert(modes[17] == OUTPUT && modes[18] == OUTPUT && pins[6] == HIGH);
  commandTrigger(0); assert(engine.currentState == 1 && outputMask == 1 && pins[7] == HIGH);
  commandTrigger(0); assert(engine.currentState == 0 && outputMask == 0);
  Serial.text.clear(); commandTrigger(1);
  assert(engine.currentState == 0 && Serial.text.find("Trigger unavailable") != std::string::npos);
}
static void testFixedDualBeam(const char* dualBeam) {
  coldBoot(dualBeam);
  assert(image.b(9) == 5 && image.b(10) == 5);
  assert(modes[10] == INPUT_PULLUP && modes[19] == INPUT_PULLUP);
  assert(modes[17] == OUTPUT && modes[18] == OUTPUT);
  assert(!pinModes[14] && !pinModes[15] && !pinModes[16]);
  uint8_t manualIndex = 255;
  for (uint8_t i = 0; i < image.b(10); ++i)
    if (image.b(image.trigger(i)) == 4) manualIndex = i;
  assert(manualIndex != 255);
  advance(3000); // Finish audio startup without activating a sensor.
  commandTrigger(manualIndex); assert(engine.currentState == 1);
  pins[19] = LOW; tick();
  assert(engine.currentState == 1 && pins[17] == HIGH); // Second beam runs child only.
  advance(251); assert(pins[17] == LOW && engine.currentState == 1);
  advance(1000); assert(pins[17] == LOW); // Held contact does not retrigger.
  pins[19] = HIGH; tick();
  pins[10] = LOW; tick(); assert(pins[17] == HIGH); // Original beam still works.
  advance(251); assert(pins[17] == LOW && engine.currentState == 1);
  send("STOP"); assert(!outputMask && !engine.running);
}
int main(int argc, char** argv) {
  assert(argc == 5);
  testFullStandard(argv[1]); testDisabledSlots(argv[2]); testUploadDisablesOldOutputs(argv[1], argv[3]);
  testFixedDualBeam(argv[4]);
  puts("Standard harness host tests passed: compiler images, fixed Uno pins, disabled backups absent, compact trigger/output indices, child pulses, inactive outputs during scene upload, independent dual-beam inputs on D10/A5.");
}
