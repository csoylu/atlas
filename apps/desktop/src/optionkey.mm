// Push-to-talk « hold ⌥ » (card #75), macOS only. Electron's globalShortcut can't take a modifier alone, so a
// listen-only Quartz event tap watches modifier changes, key presses and mouse clicks in every app and hands them to
// JS (optionkey.ts decides what a hold is). Listen-only: nothing is blocked or changed. Needs the Input Monitoring
// permission (System Settings → Privacy & Security → Input Monitoring).
//
// Node-API (ABI-stable: no rebuild per Electron version). Built by build.mjs with clang into dist/native/optionkey.node.
//   access()            → boolean   Input Monitoring allowed (CGPreflightListenEventAccess)
//   request()           → boolean   asks macOS once (adds Atlas to the Input Monitoring list); true when allowed
//   start(cb)           → true | error string   cb(kind, flags): kind 0 = modifiers changed, 1 = key down, 2 = click
//   stop()
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>

struct Ev {
  int kind;
  double flags;
};

static CFMachPortRef tap = nullptr;
static CFRunLoopSourceRef source = nullptr;
static napi_threadsafe_function tsfn = nullptr;

static void callJs(napi_env env, napi_value cb, void *, void *data) {
  Ev *ev = static_cast<Ev *>(data);
  if (env && cb) {
    napi_value args[2], undef;
    napi_create_int32(env, ev->kind, &args[0]);
    napi_create_double(env, ev->flags, &args[1]);
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, cb, 2, args, nullptr);
  }
  delete ev;
}

static CGEventRef onEvent(CGEventTapProxy, CGEventType type, CGEventRef event, void *) {
  // macOS turns a tap off when it is slow or on secure input: turn it back on
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (tap) CGEventTapEnable(tap, true);
    return event;
  }
  int kind = type == kCGEventFlagsChanged ? 0 : type == kCGEventKeyDown ? 1 : 2;
  if (tsfn) napi_call_threadsafe_function(tsfn, new Ev{kind, (double)CGEventGetFlags(event)}, napi_tsfn_nonblocking);
  return event;
}

static napi_value str(napi_env env, const char *s) {
  napi_value v;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v);
  return v;
}

static napi_value boolean(napi_env env, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}

static napi_value Access(napi_env env, napi_callback_info) { return boolean(env, CGPreflightListenEventAccess()); }
static napi_value Request(napi_env env, napi_callback_info) { return boolean(env, CGRequestListenEventAccess()); }

static void stopTap() {
  if (source) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
    CFRelease(source);
    source = nullptr;
  }
  if (tap) {
    CGEventTapEnable(tap, false);
    CFMachPortInvalidate(tap);
    CFRelease(tap);
    tap = nullptr;
  }
  if (tsfn) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_abort);
    tsfn = nullptr;
  }
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value cb;
  napi_get_cb_info(env, info, &argc, &cb, nullptr, nullptr);
  if (argc < 1) return str(env, "start(cb): no callback");
  stopTap();
  if (!CGPreflightListenEventAccess()) return str(env, "Input Monitoring is not allowed");
  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventLeftMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventOtherMouseDown);
  tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, onEvent, nullptr);
  if (!tap) return str(env, "macOS refused the keyboard event tap (Input Monitoring not allowed yet)");
  napi_value name;
  napi_create_string_utf8(env, "atlas-optionkey", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, cb, nullptr, name, 0, 1, nullptr, nullptr, nullptr, callJs, &tsfn) != napi_ok) {
    stopTap();
    return str(env, "could not create the event callback");
  }
  napi_unref_threadsafe_function(env, tsfn); // never keeps the process alive
  source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  return boolean(env, true);
}

static napi_value Stop(napi_env env, napi_callback_info) {
  stopTap();
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"access", nullptr, Access, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
