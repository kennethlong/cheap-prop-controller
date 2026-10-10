#pragma once
#include <Arduino.h>

#if !defined(__AVR_ATmega2560__)
#include <avr/interrupt.h>

namespace cpc {
// Transmit-only software UART using Timer2 CTC. USB UART reception and Timer0
// remain interruptible throughout a byte. Timer2 PWM/tone are unavailable;
// all scene outputs are digital, so D3/D11 remain normal assignable GPIO.
namespace timerUart {
static volatile uint8_t* volatile outputRegister = nullptr;
static volatile uint8_t outputMask = 0;
static volatile uint16_t frame = 0;
static volatile uint8_t remaining = 0;
inline bool busy() { return remaining != 0; }
inline void begin() {
  const uint8_t saved = SREG; cli();
  TIMSK2 = 0;
  TCCR2A = _BV(WGM21);
  TCCR2B = _BV(CS21); // F_CPU/8: 2MHz on the supported 16MHz boards
  OCR2A = static_cast<uint8_t>((F_CPU + 38400UL) / 76800UL - 1);
  TCNT2 = 0; remaining = 0;
  SREG = saved;
}
inline bool write(uint8_t pin, uint8_t value) {
  if (busy()) return false;
  const uint8_t saved = SREG; cli();
  outputRegister = portOutputRegister(digitalPinToPort(pin));
  outputMask = digitalPinToBitMask(pin);
  frame = (static_cast<uint16_t>(value) << 1) | 0x200;
  remaining = 11; // ten UART bits, then hold the stop bit for a full period
  TCNT2 = 0;
  TIFR2 = _BV(OCF2A);
  TIMSK2 = _BV(OCIE2A);
  SREG = saved;
  return true;
}
}
}
ISR(TIMER2_COMPA_vect) {
  using namespace cpc::timerUart;
  if (remaining == 1) {
    remaining = 0; TIMSK2 = 0; return;
  }
  if (frame & 1) *outputRegister |= outputMask;
  else *outputRegister &= static_cast<uint8_t>(~outputMask);
  frame >>= 1;
  --remaining;
}
#endif
