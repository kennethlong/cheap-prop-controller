#include <assert.h>
#include <stdio.h>
#define ARDUINO 10819
#define __AVR__
#include "ir_driver.hpp"

volatile uint8_t SREG = 0x80, TIMSK1 = 0, TCCR1A = 0, TCCR1B = 0, TIFR1 = 0;
volatile uint16_t TCNT1 = 0, ICR1 = 0, OCR1A = 0;
volatile uint8_t inputPorts[9] = {}, outputPorts[9] = {};
static void (*duringPwmRead)() = nullptr;
static unsigned arduinoIoCalls = 0;
#ifdef CPC_GPIO_TEST_MEGA
// The Arduino Mega variant maps D12 to TIMER1B. D13 is TIMER0A even though
// the MCU pad also has an alternate OC1C function; do not model it as TIMER1C.
static const uint8_t tx = 11, siblings[] = {12};
#else
static const uint8_t tx = 9, siblings[] = {10};
#endif

static uint8_t timerMask(uint8_t pin) {
  if (pin == tx) return _BV(COM1A1);
  if (pin == siblings[0]) return _BV(COM1B1);
  return 0;
}
// Match the actual AVR core's turnOffPWM instruction ordering: LDS, ANDI,
// STS without cli. The hook models an ISR landing between LDS and STS.
static void turnOffPwm(uint8_t pin) {
  const uint8_t mask = timerMask(pin);
  if (!mask) return;
  const uint8_t saved = TCCR1A;
  if ((SREG & 0x80) && duringPwmRead) {
    void (*isr)() = duringPwmRead; duringPwmRead = nullptr; isr();
  }
  TCCR1A = saved & static_cast<uint8_t>(~mask);
}
int digitalRead(uint8_t pin) {
  ++arduinoIoCalls; turnOffPwm(pin);
  return inputPorts[pin >> 3] & digitalPinToBitMask(pin) ? HIGH : LOW;
}
void digitalWrite(uint8_t pin, uint8_t value) {
  ++arduinoIoCalls; turnOffPwm(pin);
  if (value) outputPorts[pin >> 3] |= digitalPinToBitMask(pin);
  else outputPorts[pin >> 3] &= static_cast<uint8_t>(~digitalPinToBitMask(pin));
}
static uint8_t mode() { return (TCCR1A & 3) | ((TCCR1B >> 1) & 12); }
static void timerEvent() {
  // A bounded register scheduler, not a cycle-accurate AVR simulation. Mode12
  // resets at ICR1 and never reaches MAX, so it cannot deliver TOV1 interrupts.
  if (mode() == 14 && (TIMSK1 & _BV(TOIE1))) TIMER1_OVF_vect();
  else if (mode() == 4 && (TIMSK1 & _BV(OCIE1A))) TIMER1_COMPA_vect();
}
static const uint8_t pulses[] = {180, 90, 11, 34, 11};
static void startSpace() {
  cpc::irDriver::begin(tx); cpc::irDriver::send(pulses, sizeof(pulses));
  for (unsigned i = 0; i < 342; ++i) timerEvent();
  assert(cpc::irDriver::position == 1 && mode() == 4);
}
static void reproduceLegacyRace(uint8_t pin, bool write) {
  startSpace(); duringPwmRead = TIMER1_COMPA_vect;
  if (write) digitalWrite(pin, LOW); else (void)digitalRead(pin);
  assert(cpc::irDriver::position == 2 && mode() == 12);
  for (unsigned i = 0; i < 20000; ++i) timerEvent();
  assert(cpc::irDriver::transmitting); // HELLO's IR-idle gate can never open.
  cpc::irDriver::cancel(); assert(!cpc::irDriver::transmitting);
}
static void safeGpioCoexistence(uint8_t pin) {
  startSpace(); const unsigned oldCalls = arduinoIoCalls;
  unsigned budget = 20000;
  while (cpc::irDriver::transmitting && budget--) {
    const uint8_t a = TCCR1A, b = TCCR1B, interruptMask = TIMSK1;
    inputPorts[pin >> 3] = digitalPinToBitMask(pin);
    assert(cpc::gpio::read(pin) == HIGH);
    inputPorts[pin >> 3] = 0; assert(cpc::gpio::read(pin) == LOW);
    outputPorts[pin >> 3] = 0xa5;
    cpc::gpio::write(pin, HIGH);
    assert(outputPorts[pin >> 3] == (0xa5 | digitalPinToBitMask(pin)));
    cpc::gpio::write(pin, LOW);
    assert(outputPorts[pin >> 3] == (0xa5 & ~digitalPinToBitMask(pin)));
    assert(TCCR1A == a && TCCR1B == b && TIMSK1 == interruptMask && SREG == 0x80);
    timerEvent();
  }
  assert(budget && !cpc::irDriver::transmitting && !TIMSK1);
  assert(arduinoIoCalls == oldCalls);
  SREG = 0; cpc::gpio::write(pin, HIGH); assert(SREG == 0); SREG = 0x80;
  assert(cpc::gpio::read(255) == LOW); cpc::gpio::write(255, HIGH);
}
int main() {
  for (uint8_t pin : siblings) {
    reproduceLegacyRace(pin, false); reproduceLegacyRace(pin, true);
    safeGpioCoexistence(pin);
  }
#ifdef CPC_GPIO_TEST_MEGA
  safeGpioCoexistence(13); // Unrelated Timer0 pin also remains usable as GPIO.
#endif
  puts("AVR IR/GPIO register tests passed: legacy timer race reproduced; sibling input/output preserves IR envelope, pin isolation and IRQ state.");
}
