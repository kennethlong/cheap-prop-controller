#pragma once
#include <stdint.h>
#include <stddef.h>

extern volatile uint8_t SREG, TIMSK1, TCCR1A, TCCR1B, TIFR1;
extern volatile uint16_t TCNT1, ICR1, OCR1A;
extern volatile uint8_t inputPorts[9], outputPorts[9];
enum { LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1, CHANGE = 1, NOT_A_PIN = 255 };
enum { TOV1 = 0, OCF1A = 1, TOIE1 = 0, OCIE1A = 1,
       COM1A1 = 7, COM1B1 = 5, COM1C1 = 3, WGM11 = 1, WGM12 = 3, WGM13 = 4, CS10 = 0, CS11 = 1 };
#define _BV(bit) (1 << (bit))
inline uint8_t digitalPinToPort(uint8_t pin) { return pin < 70 ? pin >> 3 : NOT_A_PIN; }
inline uint8_t digitalPinToBitMask(uint8_t pin) { return 1 << (pin & 7); }
inline volatile uint8_t* portInputRegister(uint8_t port) { return &inputPorts[port]; }
inline volatile uint8_t* portOutputRegister(uint8_t port) { return &outputPorts[port]; }
inline uint8_t digitalPinToInterrupt(uint8_t pin) { return pin; }
inline void pinMode(uint8_t, uint8_t) {}
inline void attachInterrupt(uint8_t, void (*)(), int) {}
inline void detachInterrupt(uint8_t) {}
inline uint32_t micros() { return 0; }
int digitalRead(uint8_t pin);
void digitalWrite(uint8_t pin, uint8_t value);
