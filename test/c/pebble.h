// A stand-in for the Pebble SDK's pebble.h, so the watch code can be
// compiled and type-checked on a computer without the SDK
// (tools/check_c.sh), and the pure parts (src/c/sky.c) unit tested.
//
// Signatures follow the SDK as exported by Core Devices' PebbleOS
// (tools/generate_native_sdk/exported_symbols.json and the fw/applib
// headers). Only what Pointer Planetarium uses is here. `pebble build` is the real
// check.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _TIME_H_
// As the SDK builds (-D_TIME_H_ -Dtime_t=long): newlib's time.h is skipped
// and pebble.h declares what's used.
time_t time(time_t *tloc);
#ifndef __APPLE__   // macOS's time.h defines it whatever the guard
struct tm {
  int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year, tm_wday, tm_yday, tm_isdst;
  int tm_gmtoff;
  char *tm_zone;
};
#endif
struct tm *localtime(const time_t *timep);
#endif
bool clock_is_24h_style(void);

typedef int32_t status_t;

// ---------------------------------------------------------------- graphics
typedef union GColor8 {
  uint8_t argb;
} GColor8;
typedef GColor8 GColor;
#define GColorBlack ((GColor8){ .argb = 0xC0 })
#define GColorWhite ((GColor8){ .argb = 0xFF })
#define GColorDarkGray ((GColor8){ .argb = 0xD5 })
#define GColorLightGray ((GColor8){ .argb = 0xEA })
#define GColorDarkGreen ((GColor8){ .argb = 0xC4 })
#define GColorBulgarianRose ((GColor8){ .argb = 0xD0 })
#define GColorCobaltBlue ((GColor8){ .argb = 0xC6 })
#define GColorPictonBlue ((GColor8){ .argb = 0xDB })
#define GColorRed ((GColor8){ .argb = 0xF0 })
#define GColorDarkCandyAppleRed ((GColor8){ .argb = 0xE0 })
#define GColorFolly ((GColor8){ .argb = 0xF1 })
#define GColorChromeYellow ((GColor8){ .argb = 0xF8 })
#define GColorYellow ((GColor8){ .argb = 0xFC })
#define GColorClear ((GColor8){ .argb = 0x00 })

typedef struct GPoint { int16_t x, y; } GPoint;
#define GPoint(x, y) ((GPoint){ (x), (y) })
#define GPointZero GPoint(0, 0)
typedef struct GSize { int16_t w, h; } GSize;
typedef struct GRect { GPoint origin; GSize size; } GRect;
#define GRect(x, y, w, h) ((GRect){ { (x), (y) }, { (w), (h) } })

typedef enum { GCornerNone = 0, GCornerTopLeft = 1, GCornerTopRight = 2, GCornerBottomLeft = 4,
               GCornerBottomRight = 8, GCornersAll = 15 } GCornerMask;
typedef enum { GTextAlignmentLeft, GTextAlignmentCenter, GTextAlignmentRight } GTextAlignment;
typedef enum { GTextOverflowModeWordWrap, GTextOverflowModeTrailingEllipsis, GTextOverflowModeFill } GTextOverflowMode;
typedef enum { GOvalScaleModeFitCircle, GOvalScaleModeFillCircle } GOvalScaleMode;

typedef struct GContext GContext;
typedef struct FontInfo *GFont;
typedef void *GTextAttributes;
typedef struct GPath {
  uint32_t num_points;
  GPoint *points;
  int32_t rotation;
  GPoint offset;
} GPath;

#define FONT_KEY_GOTHIC_14 "RESOURCE_ID_GOTHIC_14"
#define FONT_KEY_GOTHIC_14_BOLD "RESOURCE_ID_GOTHIC_14_BOLD"
#define FONT_KEY_GOTHIC_18 "RESOURCE_ID_GOTHIC_18"
#define FONT_KEY_GOTHIC_18_BOLD "RESOURCE_ID_GOTHIC_18_BOLD"
#define FONT_KEY_GOTHIC_24 "RESOURCE_ID_GOTHIC_24"
#define FONT_KEY_GOTHIC_24_BOLD "RESOURCE_ID_GOTHIC_24_BOLD"
#define FONT_KEY_GOTHIC_28 "RESOURCE_ID_GOTHIC_28"
#define FONT_KEY_GOTHIC_28_BOLD "RESOURCE_ID_GOTHIC_28_BOLD"

GFont fonts_get_system_font(const char *font_key);
void graphics_context_set_fill_color(GContext *ctx, GColor color);
void graphics_context_set_stroke_color(GContext *ctx, GColor color);
void graphics_context_set_stroke_width(GContext *ctx, uint8_t stroke_width);
void graphics_context_set_text_color(GContext *ctx, GColor color);
void graphics_draw_circle(GContext *ctx, GPoint p, uint16_t radius);
void graphics_fill_circle(GContext *ctx, GPoint p, uint16_t radius);
void graphics_draw_arc(GContext *ctx, GRect rect, GOvalScaleMode scale_mode, int32_t angle_start, int32_t angle_end);
void graphics_draw_line(GContext *ctx, GPoint p0, GPoint p1);
void graphics_draw_pixel(GContext *ctx, GPoint point);
void graphics_draw_rect(GContext *ctx, GRect rect);
void graphics_draw_round_rect(GContext *ctx, GRect rect, uint16_t radius);
void graphics_fill_rect(GContext *ctx, GRect rect, uint16_t corner_radius, GCornerMask corner_mask);
void graphics_fill_radial(GContext *ctx, GRect rect, GOvalScaleMode scale_mode, uint16_t inset_thickness,
                          int32_t angle_start, int32_t angle_end);
void graphics_draw_text(GContext *ctx, const char *text, GFont const font, const GRect box,
                        const GTextOverflowMode overflow_mode, const GTextAlignment alignment,
                        GTextAttributes text_attributes);
GSize graphics_text_layout_get_content_size(const char *text, GFont const font, const GRect box,
                                            const GTextOverflowMode overflow_mode, const GTextAlignment alignment);
typedef enum { GCompOpAssign, GCompOpAssignInverted, GCompOpOr, GCompOpAnd, GCompOpClear, GCompOpSet } GCompOp;
typedef enum { GBitmapFormat1Bit = 0, GBitmapFormat8Bit, GBitmapFormat1BitPalette, GBitmapFormat2BitPalette,
               GBitmapFormat4BitPalette, GBitmapFormat8BitCircular } GBitmapFormat;
typedef struct GBitmap GBitmap;
GBitmap *gbitmap_create_with_resource(uint32_t resource_id);
void gbitmap_destroy(GBitmap *bitmap);
GBitmapFormat gbitmap_get_format(const GBitmap *bitmap);
GColor *gbitmap_get_palette(const GBitmap *bitmap);
GRect gbitmap_get_bounds(const GBitmap *bitmap);
uint8_t *gbitmap_get_data(const GBitmap *bitmap);
uint16_t gbitmap_get_bytes_per_row(const GBitmap *bitmap);
void graphics_context_set_compositing_mode(GContext *ctx, GCompOp mode);
void graphics_draw_bitmap_in_rect(GContext *ctx, const GBitmap *bitmap, GRect rect);
void gpath_draw_filled(GContext *ctx, GPath *path);
void gpath_draw_outline(GContext *ctx, GPath *path);

// ---------------------------------------------------------------- trig
#define TRIG_MAX_RATIO 0xffff
#define TRIG_MAX_ANGLE 0x10000
int32_t sin_lookup(int32_t angle);
int32_t cos_lookup(int32_t angle);
int32_t atan2_lookup(int16_t y, int16_t x);

// ---------------------------------------------------------------- windows, layers, clicks
typedef struct Layer Layer;
typedef struct Window Window;
typedef void (*LayerUpdateProc)(struct Layer *layer, GContext *ctx);
typedef void (*WindowHandler)(struct Window *window);
typedef struct WindowHandlers {
  WindowHandler load, appear, disappear, unload;
} WindowHandlers;
// Touch (SDK 4.33).
typedef enum { TouchEvent_Touchdown, TouchEvent_Liftoff, TouchEvent_PositionUpdate } TouchEventType;
typedef struct TouchEvent { TouchEventType type; bool non_navigational; int16_t x; int16_t y; } TouchEvent;
typedef void (*TouchServiceHandler)(const TouchEvent *event, void *context);
void touch_service_subscribe(TouchServiceHandler handler, void *context);
void touch_service_unsubscribe(void);

typedef void *ClickRecognizerRef;
typedef void (*ClickHandler)(ClickRecognizerRef recognizer, void *context);
typedef void (*ClickConfigProvider)(void *context);
typedef enum { BUTTON_ID_BACK, BUTTON_ID_UP, BUTTON_ID_SELECT, BUTTON_ID_DOWN, NUM_BUTTONS } ButtonId;

Layer *layer_create(GRect frame);
void layer_destroy(Layer *layer);
void layer_add_child(Layer *parent, Layer *child);
GRect layer_get_bounds(const Layer *layer);
void layer_mark_dirty(Layer *layer);
void layer_set_frame(Layer *layer, GRect frame);
void layer_set_update_proc(Layer *layer, LayerUpdateProc update_proc);
Window *window_create(void);
void window_destroy(Window *window);
struct Layer *window_get_root_layer(const Window *window);
void window_set_background_color(Window *window, GColor background_color);
void window_set_click_config_provider(Window *window, ClickConfigProvider click_config_provider);
void window_set_touch_bridge_disabled(Window *window, bool disabled);
void window_set_window_handlers(Window *window, WindowHandlers handlers);
void window_single_click_subscribe(ButtonId button_id, ClickHandler handler);
void window_long_click_subscribe(ButtonId button_id, uint16_t delay_ms, ClickHandler down_handler,
                                 ClickHandler up_handler);
void window_stack_pop_all(const bool animated);
void window_stack_push(Window *window, bool animated);
void light_enable_interaction(void);
void light_enable(bool enable);
bool light_is_on(void);
typedef void (*BacklightHandler)(bool on);
void backlight_service_subscribe(BacklightHandler handler);
void backlight_service_unsubscribe(void);
typedef struct {
  uint8_t charge_percent;
  bool is_charging;
  bool is_plugged;
} BatteryChargeState;
BatteryChargeState battery_state_service_peek(void);
void light_set_color(GColor color);
void app_event_loop(void);

// ---------------------------------------------------------------- timers, time
typedef struct AppTimer AppTimer;
typedef void (*AppTimerCallback)(void *data);
AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data);
void app_timer_cancel(AppTimer *timer_handle);
bool app_timer_reschedule(AppTimer *timer_handle, uint32_t new_timeout_ms);
uint16_t time_ms(time_t *t_utc, uint16_t *out_ms);

// ---------------------------------------------------------------- storage, resources
bool persist_exists(const uint32_t key);
bool persist_read_bool(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
status_t persist_write_bool(const uint32_t key, const bool value);
status_t persist_write_int(const uint32_t key, const int32_t value);
int persist_read_data(const uint32_t key, void *buffer, const size_t buffer_size);
int persist_write_data(const uint32_t key, const void *data, const size_t size);
status_t persist_delete(const uint32_t key);
#define PERSIST_DATA_MAX_LENGTH 256

typedef void *ResHandle;
ResHandle resource_get_handle(uint32_t resource_id);
size_t resource_size(ResHandle h);
size_t resource_load_byte_range(ResHandle h, uint32_t start_offset, uint8_t *buffer, size_t num_bytes);

// ---------------------------------------------------------------- vibes
typedef struct {
  const uint32_t *durations;
  uint32_t num_segments;
} VibePattern;
void vibes_short_pulse(void);
void vibes_long_pulse(void);
void vibes_double_pulse(void);
void vibes_cancel(void);
void vibes_enqueue_custom_pattern(VibePattern pattern);

// ---------------------------------------------------------------- sensors
typedef struct {
  int16_t x, y, z;
  bool did_vibrate;
  uint64_t timestamp;
} AccelData;
typedef void (*AccelDataHandler)(AccelData *data, uint32_t num_samples);
typedef enum { ACCEL_SAMPLING_10HZ = 10, ACCEL_SAMPLING_25HZ = 25, ACCEL_SAMPLING_50HZ = 50,
               ACCEL_SAMPLING_100HZ = 100 } AccelSamplingRate;
void accel_data_service_subscribe(uint32_t samples_per_update, AccelDataHandler handler);
int accel_service_set_sampling_rate(AccelSamplingRate rate);
int accel_service_set_samples_per_update(uint32_t num_samples);

typedef enum { CompassStatusUnavailable = -1, CompassStatusDataInvalid = 0, CompassStatusCalibrating,
               CompassStatusCalibrated } CompassStatus;
typedef int32_t CompassHeading;
typedef struct {
  CompassHeading magnetic_heading;
  CompassHeading true_heading;
  CompassStatus compass_status;
  bool is_declination_valid;
} CompassHeadingData;
typedef void (*CompassHeadingHandler)(CompassHeadingData heading);
int compass_service_set_heading_filter(CompassHeading filter);
void compass_service_subscribe(CompassHeadingHandler handler);
void compass_service_unsubscribe(void);

typedef void (*ConnectionHandler)(bool connected);
typedef struct {
  ConnectionHandler pebble_app_connection_handler;
  ConnectionHandler pebblekit_connection_handler;
} ConnectionHandlers;
bool connection_service_peek_pebble_app_connection(void);
void connection_service_subscribe(ConnectionHandlers conn_handlers);
void connection_service_unsubscribe(void);

typedef void (*AppFocusHandler)(bool in_focus);
typedef struct {
  AppFocusHandler will_focus, did_focus;
} AppFocusHandlers;
void app_focus_service_subscribe_handlers(AppFocusHandlers handlers);
void app_focus_service_unsubscribe(void);

// ---------------------------------------------------------------- app messages
typedef enum { APP_MSG_OK = 0, APP_MSG_SEND_TIMEOUT = 2, APP_MSG_SEND_REJECTED = 4, APP_MSG_NOT_CONNECTED = 8,
               APP_MSG_APP_NOT_RUNNING = 16, APP_MSG_INVALID_ARGS = 32, APP_MSG_BUSY = 64,
               APP_MSG_BUFFER_OVERFLOW = 128 } AppMessageResult;
typedef enum { DICT_OK = 0, DICT_NOT_ENOUGH_STORAGE = 2, DICT_INVALID_ARGS = 4 } DictionaryResult;
typedef enum { TUPLE_BYTE_ARRAY = 0, TUPLE_CSTRING = 1, TUPLE_UINT = 2, TUPLE_INT = 3 } TupleType;
typedef struct __attribute__((__packed__)) {
  uint32_t key;
  TupleType type : 8;
  uint16_t length;
  union {
    uint8_t data[0];
    char cstring[0];
    uint8_t uint8;
    uint16_t uint16;
    uint32_t uint32;
    int8_t int8;
    int16_t int16;
    int32_t int32;
  } value[];
} Tuple;
typedef struct DictionaryIterator DictionaryIterator;
typedef void (*AppMessageInboxReceived)(DictionaryIterator *iterator, void *context);
typedef void (*AppMessageOutboxFailed)(DictionaryIterator *iterator, AppMessageResult reason, void *context);
AppMessageResult app_message_open(const uint32_t size_inbound, const uint32_t size_outbound);
uint32_t app_message_inbox_size_maximum(void);
AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator);
AppMessageResult app_message_outbox_send(void);
AppMessageInboxReceived app_message_register_inbox_received(AppMessageInboxReceived received_callback);
AppMessageOutboxFailed app_message_register_outbox_failed(AppMessageOutboxFailed failed_callback);
Tuple *dict_find(const DictionaryIterator *iter, const uint32_t key);
DictionaryResult dict_write_uint8(DictionaryIterator *iter, const uint32_t key, const uint8_t value);
DictionaryResult dict_write_uint16(DictionaryIterator *iter, const uint32_t key, const uint16_t value);
DictionaryResult dict_write_int16(DictionaryIterator *iter, const uint32_t key, const int16_t value);
DictionaryResult dict_write_int32(DictionaryIterator *iter, const uint32_t key, const int32_t value);
DictionaryResult dict_write_cstring(DictionaryIterator *iter, const uint32_t key, const char * const cstring);
DictionaryResult dict_write_data(DictionaryIterator *iter, const uint32_t key, const uint8_t * const data,
                                 const uint16_t size);

// ---------------------------------------------------------------- logging
typedef enum { APP_LOG_LEVEL_ERROR = 1, APP_LOG_LEVEL_WARNING = 50, APP_LOG_LEVEL_INFO = 100,
               APP_LOG_LEVEL_DEBUG = 200 } AppLogLevel;
void app_log(uint8_t log_level, const char *src_filename, int src_line_number, const char *fmt, ...);
#define APP_LOG(level, fmt, args...) app_log(level, __FILE__, __LINE__, fmt, ##args)

// ---------------------------------------------------------------- message keys (from package.json)
#include "message_keys.h"
