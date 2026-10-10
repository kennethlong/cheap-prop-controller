#include <assert.h>
#include <stdio.h>
#define F_CPU 16000000UL
#include "timer_uart.hpp"
volatile uint8_t SREG = 0x80, TIMSK2 = 0, TCCR2A = 0, TCCR2B = 0, OCR2A = 0, TCNT2 = 0, TIFR2 = 0;
volatile uint8_t fakePorts[4] = {255, 255, 255, 255};
int main() {
  cpc::timerUart::begin();
  assert(!cpc::timerUart::busy() && SREG == 0x80 && OCR2A == 207);
  for (uint16_t value = 0; value < 256; ++value) {
    assert(cpc::timerUart::write(5, static_cast<uint8_t>(value)));
    assert(SREG == 0x80 && cpc::timerUart::busy());
    assert(!cpc::timerUart::write(6, 0)); // an in-flight byte cannot be replaced
    TIMER2_COMPA_vect(); assert(!(fakePorts[0] & 32)); // start bit
    for (uint8_t bit = 0; bit < 8; ++bit) {
      TIMER2_COMPA_vect(); assert(static_cast<bool>(fakePorts[0] & 32) == static_cast<bool>(value & (1 << bit)));
      assert(SREG == 0x80); // foreground USB UART remains interruptible
    }
    TIMER2_COMPA_vect(); assert(fakePorts[0] & 32); // stop bit
    assert(cpc::timerUart::busy()); // hold stop for its full period
    TIMER2_COMPA_vect(); assert(!cpc::timerUart::busy() && TIMSK2 == 0);
    assert((fakePorts[0] & ~32) == (255 & ~32)); // unrelated GPIO untouched
  }
  SREG = 0;
  assert(cpc::timerUart::write(12, 0xff)); assert(SREG == 0); // caller's IRQ state preserved
  puts("Timer UART host tests passed: all256bytes, start/data/stop framing, busy lifetime, pin isolation, IRQ preservation.");
}
