#pragma once
#include <assert.h>
#include <stdint.h>

struct FakeEEPROM {
  uint8_t bytes[4096] = {};
  int length() const { return sizeof(bytes); }
  uint8_t read(uint16_t address) const { assert(address < sizeof(bytes)); return bytes[address]; }
  void update(uint16_t address, uint8_t value) { assert(address < sizeof(bytes)); bytes[address] = value; }
};
extern FakeEEPROM EEPROM;
