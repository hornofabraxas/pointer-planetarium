// What the watch and the phone agree on: sky ladder layers, card types and
// confidence words (matcher.js LAYER, TYPE and WORD), and a result card.
#pragma once
#include <pebble.h>

enum { L_ANY, L_PLANES, L_SATS, L_PLANETS, L_STARS, L_FIND, L_COUNT };

// A chart card draws R_CHART, a fact card R_FACT; both follow the answer
// they are about.
enum { T_NOTHING, T_PLANE, T_SAT, T_PLANET, T_MOON, T_STAR, T_CONST, T_SUN, T_CHART, T_FACT };
enum { W_NONE, W_THATS, W_PROBABLY, W_MAYBE };

// How something can be seen (matcher.SEE), and Find it's flags on top
// (find.js): by eye but near the Sun, block it first; too near to find.
enum { SEE_EASY, SEE_CLOSE, SEE_BINOCULARS, SEE_TELESCOPE, SEE_HOW = 3, SEE_BLOCK_SUN = 4, SEE_NEAR_SUN = 8 };

#define MAX_CARDS 7

typedef struct {
  uint8_t type, word;
  char l1[32], l2[32], l3[32], hint[32];
} Card;

// Little-endian numbers in the phone's byte messages and the resource.
static inline uint16_t rd_u16(const uint8_t *b) {
  return (uint16_t)(b[0] | (b[1] << 8));
}

static inline int16_t rd_i16(const uint8_t *b) {
  return (int16_t)rd_u16(b);
}

static inline uint32_t rd_u32(const uint8_t *b) {
  return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}
