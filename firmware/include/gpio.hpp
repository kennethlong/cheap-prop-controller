#pragma once
#include <Arduino.h>
#if defined(__AVR__)
#include <avr/interrupt.h>
#endif

namespace cpc { namespace gpio {
// Arduino digitalRead/digitalWrite disable PWM with an unprotected RMW of
// TCCRnA. A sensor/output on another Timer1 channel can therefore overwrite
// the IR ISR's waveform mode, leaving a frame permanently in flight. Scene
// GPIO never uses analogWrite: access PIN/PORT without touching timer control.
#if defined(__AVR__)
inline int read(uint8_t pin) {
  const uint8_t port = digitalPinToPort(pin);
  if (port == NOT_A_PIN) return LOW;
  return (*portInputRegister(port) & digitalPinToBitMask(pin)) ? HIGH : LOW;
}
inline void write(uint8_t pin, uint8_t value) {
  const uint8_t port = digitalPinToPort(pin);
  if (port == NOT_A_PIN) return;
  const uint8_t mask = digitalPinToBitMask(pin);
  volatile uint8_t* out = portOutputRegister(port);
  // Audio's Timer2 ISR can update a different bit in this same PORT register.
  const uint8_t saved = SREG; cli();
  if (value == LOW) *out &= static_cast<uint8_t>(~mask);
  else *out |= mask;
  SREG = saved;
}
#else
// Host controller tests retain their existing GPIO observation hooks.
template <typename Pin> inline int read(Pin pin) { return digitalRead(pin); }
template <typename Pin, typename Value> inline void write(Pin pin, Value value) { digitalWrite(pin, value); }
#endif
} }
