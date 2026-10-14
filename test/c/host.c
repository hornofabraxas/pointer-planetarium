// The SDK functions the pure watch code (src/c/sky.c) calls, for running
// its tests on a computer: the trig lookups as the SDK defines them, and
// resources read from the files in resources/.
#include <math.h>
#include "pebble.h"

int32_t sin_lookup(int32_t angle) {
  return (int32_t)lround(sin(2 * M_PI * (angle & 0xffff) / TRIG_MAX_ANGLE) * TRIG_MAX_RATIO);
}

int32_t cos_lookup(int32_t angle) {
  return (int32_t)lround(cos(2 * M_PI * (angle & 0xffff) / TRIG_MAX_ANGLE) * TRIG_MAX_RATIO);
}

int32_t atan2_lookup(int16_t y, int16_t x) {
  double a = atan2((double)y, (double)x);
  if (a < 0) a += 2 * M_PI;
  return (int32_t)lround(a / (2 * M_PI) * TRIG_MAX_ANGLE) & 0xffff;
}

static FILE *s_res;
ResHandle resource_get_handle(uint32_t resource_id) {
  if (!s_res) s_res = fopen("resources/data/sky.bin", "rb");
  return s_res;
}

size_t resource_size(ResHandle h) {
  if (!h) return 0;
  fseek((FILE *)h, 0, SEEK_END);
  return (size_t)ftell((FILE *)h);
}

size_t resource_load_byte_range(ResHandle h, uint32_t start_offset, uint8_t *buffer, size_t num_bytes) {
  if (!h) return 0;
  fseek((FILE *)h, (long)start_offset, SEEK_SET);
  return fread(buffer, 1, num_bytes, (FILE *)h);
}
