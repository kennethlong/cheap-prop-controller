#pragma once
#include <stdint.h>
extern volatile uint8_t SREG;
inline void cli() { SREG &= 0x7f; }
#define ISR(vector) void vector()
