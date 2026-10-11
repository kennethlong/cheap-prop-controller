#pragma once
#include <Arduino.h>
#if defined(ARDUINO)
#include <avr/interrupt.h>
#endif

namespace cpc { namespace irDriver {
static volatile bool transmitting = false;
static const uint8_t* pulseData = nullptr;
static volatile uint8_t position = 0, pulseCount = 0;
static volatile uint16_t cycles = 0;
static uint8_t txPin = 9;
static bool configured = false;
static inline uint8_t lock() {
#if defined(ARDUINO)
  const uint8_t saved = SREG; cli(); return saved;
#else
  return 0;
#endif
}
static inline void unlock(uint8_t saved) {
#if defined(ARDUINO)
  SREG = saved;
#else
  (void)saved;
#endif
}
inline void off() {
#if defined(ARDUINO)
  if (configured) { TIMSK1 = 0; TCCR1A = 0; TCCR1B = 0; digitalWrite(txPin, LOW); }
#endif
  transmitting = false;
}
inline void phase() {
  if (position >= pulseCount) { off(); return; }
  const uint8_t ticks = pulseData[position];
  if (!(position & 1)) {
    // 50us storage ticks become complete 38kHz carrier periods. Hardware makes
    // the carrier; the ISR only counts periods, so UART ISR latency cannot
    // distort individual carrier pulses. No EEPROM, allocation or serial here.
    cycles = (static_cast<uint16_t>(ticks) * 19U + 5) / 10;
#if defined(ARDUINO)
    TCCR1B = 0; TCCR1A = 0; TCNT1 = 0;
    ICR1 = 420; OCR1A = 126; // 16MHz / 421 = 38.005kHz, ~30% duty.
    TIFR1 = _BV(TOV1) | _BV(OCF1A); TIMSK1 = _BV(TOIE1);
    TCCR1A = _BV(COM1A1) | _BV(WGM11);
    TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS10);
#endif
  } else {
#if defined(ARDUINO)
    TCCR1A = 0; TCCR1B = 0; digitalWrite(txPin, LOW); TCNT1 = 0;
    OCR1A = static_cast<uint16_t>(ticks) * 100U - 1; // F_CPU/8, 0.5us ticks.
    TIFR1 = _BV(TOV1) | _BV(OCF1A); TIMSK1 = _BV(OCIE1A);
    TCCR1B = _BV(WGM12) | _BV(CS11);
#endif
  }
}
inline void carrierTick() { if (transmitting && !(position & 1) && !--cycles) { ++position; phase(); } }
inline void spaceDone() { if (transmitting && (position & 1)) { ++position; phase(); } }
inline void cancel() { const uint8_t saved = lock(); off(); unlock(saved); }
inline void begin(uint8_t pin) {
  txPin = pin; configured = true;
#if defined(ARDUINO)
  digitalWrite(txPin, LOW); pinMode(txPin, OUTPUT);
#endif
  cancel();
}
inline void end() {
  cancel();
#if defined(ARDUINO)
  if (configured) pinMode(txPin, INPUT);
#endif
  configured = false;
}
inline void send(const uint8_t* data, uint8_t count) {
  const uint8_t saved = lock(); pulseData = data; pulseCount = count; position = 0;
  transmitting = count != 0; if (transmitting) phase(); unlock(saved);
}

struct Capture {
  uint8_t* data = nullptr;
  volatile uint8_t count = 0, result = 0;
  volatile bool active = false, started = false;
  volatile uint32_t lastAt = 0, firstAt = 0;
  void arm(uint8_t* buffer, uint32_t now) {
    const uint8_t saved = lock(); data = buffer; count = result = 0;
    started = false; lastAt = firstAt = now; active = true; unlock(saved);
  }
  void cancel() { const uint8_t saved = lock(); active = false; result = 0; unlock(saved); }
  void edge(bool high, uint32_t now) {
    if (!active || result) return;
    const uint32_t elapsed = now - lastAt;
    if (!started) {
      if (!high && elapsed >= 15000) { started = true; firstAt = now; }
      lastAt = now; return;
    }
    if (elapsed >= 15000 && count & 1) { result = count >= 5 ? 1 : 2; active = false; return; }
    const uint32_t ticks = (elapsed + 25) / 50;
    if (ticks < 2 || ticks > 255 || now - firstAt > 200000) { result = 2; active = false; return; }
    if (count >= 127) { result = 3; active = false; return; }
    data[count++] = static_cast<uint8_t>(ticks); lastAt = now;
  }
  uint8_t poll(uint32_t now) {
    const uint8_t saved = lock();
    // An edge ISR may run after the caller sampled micros() but before this
    // lock. A sample slightly older than lastAt is not a huge elapsed gap.
    if (active && started && static_cast<int32_t>(now - lastAt) >= 15000) {
      result = count >= 5 && (count & 1) ? 1 : 2; active = false;
    }
    const uint8_t value = result; unlock(saved); return value;
  }
};
static Capture capture;
#if defined(ARDUINO)
inline void receiveEdge() { capture.edge(digitalRead(2) != LOW, micros()); }
inline void armReceiver(uint8_t* buffer) { capture.arm(buffer, micros()); attachInterrupt(digitalPinToInterrupt(2), receiveEdge, CHANGE); }
inline void stopReceiver() { detachInterrupt(digitalPinToInterrupt(2)); capture.cancel(); }
#else
inline void armReceiver(uint8_t* buffer) { capture.arm(buffer, 0); }
inline void stopReceiver() { capture.cancel(); }
#endif
} }
#if defined(ARDUINO)
ISR(TIMER1_OVF_vect) { cpc::irDriver::carrierTick(); }
ISR(TIMER1_COMPA_vect) { cpc::irDriver::spaceDone(); }
#endif
