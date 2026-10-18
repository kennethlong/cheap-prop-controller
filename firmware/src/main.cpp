#include <Arduino.h>
#include <EEPROM.h>
#include <stdlib.h>
#include <string.h>
#include "scene_image.hpp"
#include "audio_engine.hpp"
#include "zone_engine.hpp"
#include "ir_engine.hpp"

namespace {
bool virtualMagic = false;
uint8_t uploadVersion = '1';
uint8_t readScene(uint16_t address) {
  if (virtualMagic && address < 4) return address == 3 ? uploadVersion : "CPC"[address];
  return EEPROM.read(address);
}
cpc::SceneImage image{readScene};
cpc::SceneRuntime engine;
cpc::AudioEngine audio;
cpc::IrEngine ir;
cpc::DebouncedInput inputs[cpc::MaxTriggers];
cpc::ZoneInput zones[cpc::MaxTriggers];
uint8_t changedSensor = 255, exitedZone = 255, enteredZone = 255;
uint8_t zoneSensorMask = 0;
bool sensorActive[cpc::MaxTriggers];
bool validScene = false, uploading = false, beginPending = false;
bool testingOutputs = false;
uint32_t testAt = 0;
uint32_t feedbackAt = 0;
bool busyLevels[cpc::MaxPlayers];
uint16_t expectedLength = 0, receivedLength = 0, expectedCrc = 0;
uint32_t outputMask = 0;
char line[96];
uint8_t lineLength = 0;
bool lineOverflow = false;
uint8_t pendingReports = 0;
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
bool busyInput(uint8_t index) {
  const uint8_t config = image.b(image.player(index) + 3), pin = (config & 127) - 1;
  bool high;
#if CPC_BOARD_ID == 2 || CPC_BOARD_ID == 3
  if (pin == 20 || pin == 21) high = analogRead(pin) >= 512;
  else
#endif
  high = digitalRead(pin) != LOW;
  return high ^ !(config & 128);
}
const __FlashStringHelper* feedbackName(uint8_t value) {
  switch (value) {
    case cpc::AudioFeedback::Waiting: return F("starting");
    case cpc::AudioFeedback::Playing: return F("playing");
    case cpc::AudioFeedback::Finished: return F("finished");
    case cpc::AudioFeedback::Failed: return F("failed");
    case cpc::AudioFeedback::Stopped: return F("stopped");
    default: return F("disabled");
  }
}
void status(bool hello) {
  const uint32_t now = millis();
  engine.updateChildren(now);
  Serial.print(F("{\"type\":\"")); Serial.print(hello ? F("hello") : F("status"));
  Serial.print(F("\",\"protocol\":1,\"firmware\":\"0.7.2\",\"board\":\"")); Serial.print(boardName());
  Serial.print(F("\",\"capacity\":")); Serial.print(EEPROM.length());
  Serial.print(F(",\"valid\":")); Serial.print(validScene ? F("true") : F("false"));
  Serial.print(F(",\"running\":")); Serial.print(engine.running ? F("true") : F("false"));
  Serial.print(F(",\"state\":")); if (validScene) Serial.print(engine.currentState); else Serial.print(F("null"));
  Serial.print(F(",\"elapsed\":")); Serial.print(engine.running ? millis() - engine.enteredAt : 0);
  Serial.print(F(",\"outputs\":")); Serial.print(outputMask);
  Serial.print(F(",\"activeChildren\":")); Serial.print(engine.activeChildren());
  Serial.print(F(",\"coolingChildren\":")); Serial.print(engine.coolingChildren());
  Serial.print(F(",\"testingOutputs\":")); Serial.print(testingOutputs ? F("true") : F("false"));
  Serial.print(F(",\"players\":["));
  for (uint8_t i = 0; validScene && i < image.b(11); ++i) {
    if (i) Serial.print(',');
    Serial.print(F("{\"index\":")); Serial.print(i); Serial.print(F(",\"feedback\":\"")); Serial.print(feedbackName(audio.feedbackStatus(i)));
    Serial.print(F("\",\"busy\":"));
    if (image.b(image.player(i) + 3)) Serial.print(busyLevels[i] ? F("true") : F("false")); else Serial.print(F("null"));
    Serial.print('}');
  }
  Serial.println(F("],\"sceneControls\":true,\"parallelChildren\":true,\"manualTriggers\":true,\"outputTest\":true,\"audioFeedback\":true,\"audioFadeThrough\":true,\"audioAmbientMix\":true,\"distanceZones\":true,\"irLearning\":true,\"irReplay\":true}"));
}
void reportPending() {
  // Long USB reports must not interrupt a polled echo or split an MP3 packet.
  // Requests remain parseable while reports wait, including priority STOP.
  if (!pendingReports || sonarPhase || !audio.transportIdle() || ir.transmitting()) return;
  const uint8_t reports = pendingReports; pendingReports = 0;
  if (reports & 1) status(false);
  if (reports & 2) status(true);
}
void stateChanged(uint32_t now) {
  // Use the state/action timestamp, even if serial logging crosses a millis
  // boundary. The same loop's audio.update must never precede this fade start.
  audio.enter(engine.currentState, now);
  // IR quiet time starts when frame completion is observed, independently of
  // the scene/action clock retained for ordered audio fades and timeline cues.
  ir.enter(engine.currentState, now, millis());
  Serial.print(F("{\"type\":\"state\",\"state\":")); Serial.print(engine.currentState); Serial.println(F(",\"elapsed\":0}"));
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
  testingOutputs = false;
  engine.stop(); writeOutputs(0, true); audio.stop(millis()); ir.stop();
  if (validScene && sonarPhase == 1) digitalWrite(image.b(image.trigger(sonarIndex) + 1), LOW);
  sonarPhase = 0; changedSensor = 255;
}
void expireOutputTest(uint32_t now) { if (testingOutputs && static_cast<uint32_t>(now - testAt) >= 1500) stop(); }
void resetZones() {
  changedSensor = 255;
  for (uint8_t i = 0; i < cpc::MaxTriggers; ++i) zones[i].reset();
  if (validScene && sonarPhase == 1) digitalWrite(image.b(image.trigger(sonarIndex) + 1), LOW);
  sonarPhase = 0; sonarIndex = 0; sonarNext = micros();
}
void resetInputBaselines(uint32_t now) {
  for (uint8_t i = 0; i < image.b(10); ++i) {
    const uint16_t p = image.trigger(i);
    if (image.b(p) >= 3) continue;
    sensorActive[i] = image.b(p) == 2 || (static_cast<bool>(digitalRead(image.b(p + 1))) ^ static_cast<bool>(image.b(p + 3) & 1));
    inputs[i].reset(sensorActive[i], now);
  }
}
void setupScene() {
  const uint32_t now = millis();
  engine.begin(&image); outputMask = 0; resetZones(); ir.begin(&image);
  // Cache ownership so the echo timing loop never scans the EEPROM zone table.
  zoneSensorMask = 0;
  for (uint8_t i = 0; i < image.zoneCount(); ++i) zoneSensorMask |= 1 << image.b(image.zone(i));
  for (uint8_t i = 0; i < image.b(9); ++i) {
    const uint16_t p = image.output(i);
    digitalWrite(image.b(p), image.b(p + 1) & 1 ? HIGH : LOW);
    pinMode(image.b(p), OUTPUT);
  }
  for (uint8_t i = 0; i < image.b(10); ++i) {
    const uint16_t p = image.trigger(i);
    if (image.b(p) >= 3) continue;
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
  for (uint8_t i = 0; i < image.b(11); ++i) if (image.b(image.player(i) + 3)) {
    const uint8_t pin = (image.b(image.player(i) + 3) & 127) - 1;
#if CPC_BOARD_ID == 2 || CPC_BOARD_ID == 3
    if (pin == 20 || pin == 21) continue; // ADC-only pads have no digital input buffer.
#endif
    pinMode(pin, INPUT);
  }
  audio.begin(&image, now);
  feedbackAt = now - 10;
  for (uint8_t i = 0; i < image.b(11); ++i) busyLevels[i] = image.b(image.player(i) + 3) ? busyInput(i) : false;
  engine.run(now); audio.enter(engine.currentState, now);
  ir.enter(engine.currentState, now);
  writeOutputs(engine.activeOutputs(now), true);
}

void sonarMeasurement(bool hasEcho, uint32_t pulseUs) {
  const uint16_t p = image.trigger(sonarIndex);
  // Approximately 58us round trip per centimetre. Legacy thresholds release
  // on invalid echo; zoned sensors retain their baseline and cancel dwell.
  const uint16_t distance = pulseUs / 58;
  if (zoneSensorMask & (1 << sonarIndex)) {
    if (zones[sonarIndex].sample(image, sonarIndex, hasEcho, distance, millis(), exitedZone)) {
      changedSensor = sonarIndex; enteredZone = zones[sonarIndex].current;
    }
  } else if (!hasEcho || distance < 2 || distance > 400) { /* Invalid samples do not synthesize a release. */ }
  else if (distance <= image.u16(p + 4)) sensorActive[sonarIndex] = true;
  else if (distance >= image.u16(p + 4) + image.b(p + 6)) sensorActive[sonarIndex] = false;
  sonarPhase = 0; sonarNext = micros() + 60000UL;
  sonarIndex = (sonarIndex + 1) % image.b(10);
}
void updateSonar() {
  if (!validScene || !engine.running || !image.b(10) || ir.transmitting()) return;
  const uint32_t now = micros();
  if (!sonarPhase) {
    if (static_cast<int32_t>(now - sonarNext) < 0 || !audio.transportIdle()) return;
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
uint8_t readTriggerEdges(uint32_t now, uint8_t& releases) {
  uint8_t edges = 0;
  releases = 0;
  for (uint8_t i = 0; i < image.b(10); ++i) {
    const uint16_t p = image.trigger(i);
    if (image.b(p) >= 3 || (zoneSensorMask & (1 << i))) continue;
    if (image.b(p) != 2)
      sensorActive[i] = static_cast<bool>(digitalRead(image.b(p + 1))) ^ static_cast<bool>(image.b(p + 3) & 1);
    const uint8_t edge = inputs[i].updateEdges(sensorActive[i], now, image.b(p + 7) * 50U);
    if (edge & 1) edges |= 1 << i;
    if (edge & 2) releases |= 1 << i;
  }
  return edges;
}
bool zoneActions(uint8_t zone, bool entering, uint32_t now) {
  if (zone == cpc::ZoneInput::None || !engine.running) return false;
  bool changed = false;
  const uint16_t z = image.zone(zone);
  const uint8_t start = image.b(z + (entering ? 6 : 8)), count = image.b(z + (entering ? 7 : 9));
  for (uint8_t i = 0; i < count && engine.running; ++i) {
    const uint16_t a = image.zoneAction(start + i);
    if (image.b(a) == 0) { engine.enter(image.b(a + 1), now); stateChanged(now); changed = true; }
    else if (image.b(a) == 1) audio.volume(image.b(a + 1), image.b(a + 2), image.u16(a + 4) * 50U, now);
    else ir.enqueue(image.b(a + 1));
  }
  return changed;
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
  expireOutputTest(millis());
  char* args[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
  uint8_t count = 0;
  char* token = strtok(line, " ");
  while (token && count < 6) { args[count++] = token; token = strtok(nullptr, " "); }
  if (!count) return;
  if (token) { error(F("Too many arguments")); return; }
  if (!strcmp(args[0], "HELLO") && count == 1) { pendingReports |= 2; reportPending(); return; }
  if (!strcmp(args[0], "STATUS") && count == 1) { pendingReports |= 1; reportPending(); return; }
  if (!strcmp(args[0], "STOP") && count == 1) { stop(); ack(F("STOP")); return; }
  uint32_t value = 0, second = 0;
  if (!strcmp(args[0], "TESTBEGIN") && count == 3) {
    if (!validScene || uploading || testingOutputs || (ir.busy() && !engine.running)) { error(F("Output test unavailable")); return; }
    if (!number(args[1], EEPROM.length(), value) || !number(args[2], 65535, second) || value != image.u16(4) || second != image.u16(6)) { error(F("Upload this scene before testing outputs")); return; }
    stop(); testingOutputs = true; testAt = millis(); ack(F("TESTBEGIN")); return;
  }
  if (!strcmp(args[0], "TEST") && count == 2) {
    if (!testingOutputs || !number(args[1], 0xffffffffUL, value) || (image.b(9) < 32 && (value >> image.b(9)))) { error(F("Invalid output test mask or expired lease")); return; }
    writeOutputs(value, true); testAt = millis(); ack(F("TEST")); return;
  }
  if (testingOutputs) { error(F("Send STOP to exit output test first")); return; }
  if (!strcmp(args[0], "IRLEARN") && count == 1) {
    if (!validScene || uploading || !image.hasIr()) { error(F("Upload an IR-enabled scene first")); return; }
    if (ir.busy() && !engine.running) { error(F("IR busy; send STOP first")); return; }
    stop(); ir.learn(millis()); return; // One final capture/error response, no early ACK.
  }
  if (!strcmp(args[0], "IRBEGIN") && count == 6) {
    if (!validScene || uploading || !image.hasIr()) { error(F("Upload an IR-enabled scene first")); return; }
    if (ir.busy() && !engine.running) { error(F("IR busy; send STOP first")); return; }
    uint32_t kind, pulses, repeats, gap, code;
    if (!number(args[1], 1, kind) || !number(args[2], 127, pulses) || !number(args[3], 10, repeats) || !number(args[4], 2000, gap) || !number(args[5], 0xffffffffUL, code)
        || !repeats || gap < 50 || gap % 50 || (!kind && pulses) || (kind && (pulses < 5 || !(pulses & 1) || code))) { error(F("Invalid IR test parameters")); return; }
    stop(); ir.stage(kind, pulses, repeats, gap, code); ack(F("IRBEGIN")); return;
  }
  if (!strcmp(args[0], "IRDATA") && count == 3) {
    uint32_t offset;
    const size_t chars = strlen(args[2]); uint8_t values[32];
    if (!ir.staging() || !number(args[1], 127, offset) || !chars || chars > 64 || chars % 2) { error(F("Invalid IR data offset or length")); return; }
    for (uint8_t i = 0; i < chars / 2; ++i) {
      const int8_t high = hexDigit(args[2][i * 2]), low = hexDigit(args[2][i * 2 + 1]);
      if (high < 0 || low < 0) { error(F("Invalid IR data hex")); return; }
      values[i] = (high << 4) | low;
    }
    if (!ir.data(offset, values, chars / 2)) { error(F("Invalid IR pulse data")); return; }
    Serial.print(F("{\"type\":\"ack\",\"command\":\"IRDATA\",\"offset\":")); Serial.print(ir.stagedOffset()); Serial.println('}'); return;
  }
  if (!strcmp(args[0], "IRPLAY") && count == 1) {
    if (!ir.play(millis())) { error(F("IR test is incomplete or invalid")); return; }
    ack(F("IRPLAY")); return;
  }
  if ((!strcmp(args[0], "RUN") || !strcmp(args[0], "RESET")) && count == 1) {
    if (!validScene || uploading) { error(F("No valid scene")); return; }
    if (!engine.running && ir.busy()) { error(F("IR busy; send STOP first")); return; }
    const uint32_t now = millis();
    resetZones(); resetInputBaselines(now); engine.run(now); writeOutputs(engine.activeOutputs(now), true); stateChanged(now);
    ack(!strcmp(args[0], "RUN") ? F("RUN") : F("RESET")); return;
  }
  if (!strcmp(args[0], "TRIGGER") && count == 2) {
    if (!validScene || !engine.running || !number(args[1], 7, value) || value >= image.b(10)) { error(F("Trigger unavailable")); return; }
    if (zoneSensorMask & (1 << value)) { error(F("Distance zones require a sensor reading")); return; }
    const uint32_t now = millis();
    engine.resetExternalTimers(now);
    const bool changed = engine.trigger(1 << value, now);
    writeOutputs(engine.activeOutputs(now), true);
    if (changed) stateChanged(now);
    ack(F("TRIGGER")); return;
  }
  if (!strcmp(args[0], "BEGIN") && count == 3) {
    if (!number(args[1], EEPROM.length(), value) || value < cpc::HeaderSize || !number(args[2], 65535, second)) { error(F("Invalid image length or CRC")); return; }
    stop(); validScene = false; EEPROM.update(0, 0);
    virtualMagic = uploading = true; uploadVersion = '1'; expectedLength = value; expectedCrc = second; receivedLength = 0;
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
      if (receivedLength + i < 3 && bytes[i] != static_cast<uint8_t>("CPC"[receivedLength + i])) { error(F("Invalid image magic")); return; }
      if (receivedLength + i == 3 && (bytes[i] < '1' || bytes[i] > '3')) { error(F("Invalid image version")); return; }
    }
    for (uint8_t i = 0; i < characters / 2; ++i)
      if (receivedLength + i >= 4) EEPROM.update(receivedLength + i, bytes[i]);
      else if (receivedLength + i == 3) uploadVersion = bytes[i];
    receivedLength += characters / 2;
    Serial.print(F("{\"type\":\"ack\",\"command\":\"DATA\",\"offset\":")); Serial.print(receivedLength); Serial.println('}'); return;
  }
  if (!strcmp(args[0], "COMMIT") && count == 1) {
    if (!uploading || receivedLength != expectedLength || image.u16(4) != expectedLength || image.u16(6) != expectedCrc || !image.valid(EEPROM.length(), CPC_BOARD_ID)) { error(F("Image incomplete or invalid")); return; }
    // First byte remains invalid until every remaining byte is durable.
    EEPROM.update(1, 'P'); EEPROM.update(2, 'C'); EEPROM.update(3, uploadVersion); EEPROM.update(0, 'C');
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
  expireOutputTest(millis());
  serialInput();
  // Report before starting another ping, then refresh the scene/audio clock.
  reportPending();
  const uint32_t now = millis();
  ir.update(now, audio.transportIdle(), sonarPhase == 0);
  if (validScene) {
    updateSonar();
    uint8_t releases;
    uint8_t activations = readTriggerEdges(now, releases);
    activations |= engine.timerEdges(now, activations || (changedSensor != 255 && enteredZone != 255));
    bool changed = engine.trigger(activations, now, releases);
    if (changed) stateChanged(now);
    if (changedSensor != 255) {
      changedSensor = 255;
      changed = zoneActions(exitedZone, false, now) || changed;
      changed = zoneActions(enteredZone, true, now) || changed;
    }
    audio.pollFeedbackReady(now);
    // ADC-only BUSY pads take roughly 100us to sample. Keep every feedback
    // read out of the polled HC-SR04 echo window; STATUS uses this cache too.
    if (!sonarPhase && static_cast<uint32_t>(now - feedbackAt) >= 10) {
      feedbackAt = now;
      for (uint8_t i = 0; i < image.b(11); ++i) if (image.b(image.player(i) + 3)) {
        busyLevels[i] = busyInput(i); audio.sampleFeedback(i, busyLevels[i], now);
      }
    }
    if (audio.takeForegroundFinished() && engine.running && !changed) {
      const uint8_t target = image.b(image.state(engine.currentState) + 13);
      if (target) { engine.enter(target - 1, now); stateChanged(now); }
    }
    if (engine.running) ir.timeline(now);
    if (!testingOutputs) writeOutputs(engine.activeOutputs(now));
  }
  ir.update(millis(), audio.transportIdle(), sonarPhase == 0);
  if (!ir.transmitting()) audio.update(now, sonarPhase != 0);
  const uint8_t capture = ir.pollLearn(now, micros(), audio.stopped());
  if (capture == 1) {
    Serial.print(F("{\"type\":\"ir-capture\",\"pulsesUs\":["));
    for (uint8_t i = 0; i < ir.captureLength(); ++i) { if (i) Serial.print(','); Serial.print(ir.captureMicros(i)); }
    Serial.println(F("]}"));
  } else if (capture) error(capture == 4 ? F("IR learning timed out; press the remote button once") : capture == 3 ? F("IR capture overflow; command is too long") : F("IR capture invalid or repeat-only; press once again"));
  if (ir.takeOverflow()) error(F("IR command queue full; space commands farther apart"));
  if (beginPending && audio.stopped()) { beginPending = false; ack(F("BEGIN")); }
}
