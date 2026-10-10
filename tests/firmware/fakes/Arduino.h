#pragma once
#include <stdint.h>
#include <stddef.h>
#include <vector>
class HardwareSerial {
public:
  std::vector<uint8_t> bytes;
  std::vector<uint32_t> emittedAt;
  uint32_t now = 0;
  void begin(unsigned long) {}
  int availableForWrite() const { return 64; }
  size_t write(uint8_t byte) { bytes.push_back(byte); emittedAt.push_back(now); return 1; }
};
extern HardwareSerial Serial1, Serial2, Serial3;
#ifndef __AVR_ATmega2560__
extern volatile uint8_t SREG, TIMSK2, TCCR2A, TCCR2B, OCR2A, TCNT2, TIFR2, fakePorts[4];
enum { WGM21 = 1, CS21 = 1, OCF2A = 1, OCIE2A = 1 };
#define _BV(bit) (1 << (bit))
inline uint8_t digitalPinToPort(uint8_t pin) { return pin >> 3; }
inline uint8_t digitalPinToBitMask(uint8_t pin) { return 1 << (pin & 7); }
inline volatile uint8_t* portOutputRegister(uint8_t port) { return &fakePorts[port]; }
#endif
