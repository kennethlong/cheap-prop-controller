#include <Arduino.h>
#include <EEPROM.h>
#include <stdlib.h>
#include <string.h>
#include "scene_image.hpp"
#include "audio_engine.hpp"

namespace {
bool virtualMagic = false;
uint8_t readScene(uint16_t address) {
  if (virtualMagic && address < 4) return "CPC1"[address];
  return EEPROM.read(address);
}
cpc::SceneImage image{readScene};
cpc::SceneRuntime engine;
cpc::AudioEngine audio;
cpc::DebouncedInput inputs[cpc::MaxTriggers];
bool sensorActive[cpc::MaxTriggers];
bool validScene = false, uploading = false, beginPending = false;
uint16_t expectedLength = 0, receivedLength = 0, expectedCrc = 0;
uint32_t outputMask = 0;
char line[96];
uint8_t lineLength = 0;
bool lineOverflow = false;
// One ultrasonic transducer at a time, with quiet time to avoid cross-talk.
uint8_t sonarIndex = 0, sonarPhase = 0;
uint32_t sonarAt = 0, sonarNext = 0;

const __FlashStringHelper* boardName() {
#if CPC_BOARD_ID == 4
  return F("mega");
#elif CPC_BOARD_ID == 3
  return F("pro-mini");
#elif CPC_BOARD_ID == 2
  return F("nano");
#else
  return F("uno");
#endif
}
void error(const __FlashStringHelper* message) {
  Serial.print(F("{\"type\":\"error\",\"message\":\"")); Serial.print(message); Serial.println(F("\"}"));
}
void ack(const __FlashStringHelper* command) {
  Serial.print(F("{\"type\":\"ack\",\"command\":\"")); Serial.print(command); Serial.println(F("\"}"));
}
void status(bool hello) {
  Serial.print(F("{\"type\":\"")); Serial.print(hello ? F("hello") : F("status"));
  Serial.print(F("\",\"protocol\":1,\"firmware\":\"0.3.0\",\"board\":\"")); Serial.print(boardName());
  Serial.print(F("\",\"capacity\":")); Serial.print(EEPROM.length());
  Serial.print(F(",\"valid\":")); Serial.print(validScene ? F("true") : F("false"));
  Serial.print(F(",\"running\":")); Serial.print(engine.running ? F("true") : F("false"));
  Serial.print(F(",\"state\":")); if (validScene) Serial.print(engine.currentState); else Serial.print(F("null"));
  Serial.print(F(",\"elapsed\":")); Serial.print(engine.running ? millis() - engine.enteredAt : 0);
  Serial.print(F(",\"outputs\":")); Serial.print(outputMask);
  Serial.println(F(",\"audioFeedback\":false,\"audioFadeThrough\":true,\"audioAmbientMix\":true}"));
}
void stateChanged() {
  Serial.print(F("{\"type\":\"state\",\"state\":")); Serial.print(engine.currentState); Serial.println(F(",\"elapsed\":0}"));
  audio.enter(engine.currentState, millis());
}
void writeOutputs(uint32_t mask, bool force = false) {
  if (!validScene) return;
  for (uint8_t i = 0; i < image.b(9); ++i) {
    const uint32_t bit = static_cast<uint32_t>(1) << i;
    if (force || ((mask ^ outputMask) & bit)) {
      const uint16_t p = image.output(i);
      digitalWrite(image.b(p), static_cast<bool>(mask & bit) ^ static_cast<bool>(image.b(p + 1) & 1));
    }
  }
  outputMask = mask;
}
void stop() {
  engine.stop(); writeOutputs(0, true); audio.stop(millis());
  if (validScene && sonarPhase == 1) digitalWrite(image.b(image.trigger(sonarIndex) + 1), LOW);
  sonarPhase = 0;
}
void setupScene() {
  const uint32_t now = millis();
  engine.begin(&image); outputMask = 0; sonarPhase = 0; sonarIndex = 0; sonarNext = micros();
  for (uint8_t i = 0; i < image.b(9); ++i) {
    const uint16_t p = image.output(i);
    digitalWrite(image.b(p), image.b(p + 1) & 1 ? HIGH : LOW);
    pinMode(image.b(p), OUTPUT);
  }
  for (uint8_t i = 0; i < image.b(10); ++i) {
    const uint16_t p = image.trigger(i);
    if (image.b(p) == 2) {
      digitalWrite(image.b(p + 1), LOW); pinMode(image.b(p + 1), OUTPUT);
      pinMode(image.b(p + 2), INPUT);
      sensorActive[i] = true; // unarmed until first inactive sensor reading
      inputs[i].reset(true, now);
    } else {
      pinMode(image.b(p + 1), image.b(p + 3) & 2 ? INPUT_PULLUP : INPUT);
      sensorActive[i] = static_cast<bool>(digitalRead(image.b(p + 1))) ^ static_cast<bool>(image.b(p + 3) & 1);
      inputs[i].reset(sensorActive[i], now);
    }
  }
  audio.begin(&image, now);
  engine.run(now); audio.enter(engine.currentState, now);
  writeOutputs(engine.activeOutputs(now), true);
}

void sonarMeasurement(bool hasEcho, uint32_t pulseUs) {
  const uint16_t p = image.trigger(sonarIndex);
  // Approximately 58us round trip per centimetre. Invalid/no echo releases.
  const uint16_t distance = pulseUs / 58;
  if (!hasEcho || distance < 2 || distance > 400) sensorActive[sonarIndex] = false;
  else if (distance <= image.u16(p + 4)) sensorActive[sonarIndex] = true;
  else if (distance >= image.u16(p + 4) + image.b(p + 6)) sensorActive[sonarIndex] = false;
  sonarPhase = 0; sonarNext = micros() + 60000UL;
  sonarIndex = (sonarIndex + 1) % image.b(10);
}
void updateSonar() {
  if (!validScene || !engine.running || !image.b(10)) return;
  const uint32_t now = micros();
  if (!sonarPhase) {
    if (static_cast<int32_t>(now - sonarNext) < 0) return;
    bool found = false;
    for (uint8_t n = 0; n < image.b(10); ++n) {
      if (image.b(image.trigger(sonarIndex)) == 2) { found = true; break; }
      sonarIndex = (sonarIndex + 1) % image.b(10);
    }
    if (!found) { sonarNext = now + 60000UL; return; }
    digitalWrite(image.b(image.trigger(sonarIndex) + 1), HIGH);
    sonarAt = now; sonarPhase = 1; return;
  }
  const uint16_t p = image.trigger(sonarIndex);
  if (sonarPhase == 1 && static_cast<uint32_t>(now - sonarAt) >= 10) {
    digitalWrite(image.b(p + 1), LOW); sonarAt = now; sonarPhase = 2;
  } else if (sonarPhase == 2) {
    if (digitalRead(image.b(p + 2))) { sonarAt = now; sonarPhase = 3; }
    else if (static_cast<uint32_t>(now - sonarAt) > 30000UL) sonarMeasurement(false, 0);
  } else if (sonarPhase == 3) {
    if (!digitalRead(image.b(p + 2))) sonarMeasurement(true, now - sonarAt);
    else if (static_cast<uint32_t>(now - sonarAt) > 30000UL) sonarMeasurement(false, 0);
  }
}
uint8_t readTriggerEdges(uint32_t now) {
  uint8_t edges = 0;
  for (uint8_t i = 0; i < image.b(10); ++i) {
    const uint16_t p = image.trigger(i);
    if (image.b(p) != 2)
      sensorActive[i] = static_cast<bool>(digitalRead(image.b(p + 1))) ^ static_cast<bool>(image.b(p + 3) & 1);
    if (inputs[i].update(sensorActive[i], now, image.b(p + 7) * 50U)) edges |= 1 << i;
  }
  return edges;
}
bool number(const char* input, uint32_t maximum, uint32_t& result) {
  if (!input || !*input) return false;
  result = 0;
  while (*input) {
    if (*input < '0' || *input > '9') return false;
    const uint8_t digit = *input++ - '0';
    if (result > maximum / 10 || (result == maximum / 10 && digit > maximum % 10)) return false;
    result = result * 10 + digit;
  }
  return true;
}
int8_t hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
void command() {
  char* args[4] = {nullptr, nullptr, nullptr, nullptr};
  uint8_t count = 0;
  char* token = strtok(line, " ");
  while (token && count < 4) { args[count++] = token; token = strtok(nullptr, " "); }
  if (!count) return;
  if (token) { error(F("Too many arguments")); return; }
  if (!strcmp(args[0], "HELLO") && count == 1) { status(true); return; }
  if (!strcmp(args[0], "STATUS") && count == 1) { status(false); return; }
  if (!strcmp(args[0], "STOP") && count == 1) { stop(); ack(F("STOP")); return; }
  if ((!strcmp(args[0], "RUN") || !strcmp(args[0], "RESET")) && count == 1) {
    if (!validScene || uploading) { error(F("No valid scene")); return; }
    engine.run(millis()); writeOutputs(engine.activeOutputs(millis()), true); stateChanged();
    ack(!strcmp(args[0], "RUN") ? F("RUN") : F("RESET")); return;
  }
  uint32_t value = 0, second = 0;
  if (!strcmp(args[0], "TRIGGER") && count == 2) {
    if (!validScene || !engine.running || !number(args[1], 7, value) || value >= image.b(10)) { error(F("Trigger unavailable")); return; }
    if (engine.trigger(1 << value, millis())) { writeOutputs(engine.activeOutputs(millis()), true); stateChanged(); }
    ack(F("TRIGGER")); return;
  }
  if (!strcmp(args[0], "BEGIN") && count == 3) {
    if (!number(args[1], EEPROM.length(), value) || value < cpc::HeaderSize || !number(args[2], 65535, second)) { error(F("Invalid image length or CRC")); return; }
    stop(); validScene = false; EEPROM.update(0, 0);
    virtualMagic = uploading = true; expectedLength = value; expectedCrc = second; receivedLength = 0;
    // A subsequent COMMIT may assign fewer decoders or move their pins. Drain
    // every old STOP packet before accepting payload, without blocking loop().
    beginPending = true; return;
  }
  if (!strcmp(args[0], "DATA") && count == 3) {
    if (beginPending) { error(F("Wait for BEGIN acknowledgement")); return; }
    if (!uploading || !number(args[1], expectedLength, value) || value != receivedLength) { error(F("Unexpected DATA offset")); return; }
    const size_t characters = strlen(args[2]);
    if (!characters || characters > 64 || characters % 2 || receivedLength + characters / 2 > expectedLength) { error(F("Invalid DATA length")); return; }
    uint8_t bytes[32];
    for (uint8_t i = 0; i < characters / 2; ++i) {
      const int8_t high = hexDigit(args[2][i * 2]), low = hexDigit(args[2][i * 2 + 1]);
      if (high < 0 || low < 0) { error(F("Invalid DATA hex")); return; }
      bytes[i] = (high << 4) | low;
      if (receivedLength + i < 4 && bytes[i] != static_cast<uint8_t>("CPC1"[receivedLength + i])) { error(F("Invalid image magic")); return; }
    }
    for (uint8_t i = 0; i < characters / 2; ++i)
      if (receivedLength + i >= 4) EEPROM.update(receivedLength + i, bytes[i]);
    receivedLength += characters / 2;
    Serial.print(F("{\"type\":\"ack\",\"command\":\"DATA\",\"offset\":")); Serial.print(receivedLength); Serial.println('}'); return;
  }
  if (!strcmp(args[0], "COMMIT") && count == 1) {
    if (!uploading || receivedLength != expectedLength || image.u16(4) != expectedLength || image.u16(6) != expectedCrc || !image.valid(EEPROM.length(), CPC_BOARD_ID)) { error(F("Image incomplete or invalid")); return; }
    // First byte remains invalid until every remaining byte is durable.
    EEPROM.update(1, 'P'); EEPROM.update(2, 'C'); EEPROM.update(3, '1'); EEPROM.update(0, 'C');
    uploading = virtualMagic = false; validScene = true;
    setupScene(); ack(F("COMMIT")); return;
  }
  error(F("Unknown command or arguments"));
}
void serialInput() {
  uint8_t budget = 32;
  while (budget-- && Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      if (lineOverflow) error(F("Command too long"));
      else { line[lineLength] = 0; command(); }
      lineLength = 0; lineOverflow = false; return;
    }
    if (c < 32 || c > 126) { lineOverflow = true; continue; }
    if (lineLength < sizeof(line) - 1 && !lineOverflow) line[lineLength++] = c;
    else lineOverflow = true;
  }
}
}

void setup() {
  Serial.begin(115200);
  engine.begin(&image);
  validScene = image.valid(EEPROM.length(), CPC_BOARD_ID);
  if (validScene) setupScene();
  status(true);
}
void loop() {
  serialInput();
  const uint32_t now = millis();
  if (validScene) {
    updateSonar();
    if (engine.trigger(readTriggerEdges(now), now)) stateChanged();
    writeOutputs(engine.activeOutputs(now));
  }
  audio.update(now, sonarPhase != 0);
  if (beginPending && audio.stopped()) { beginPending = false; ack(F("BEGIN")); }
}
