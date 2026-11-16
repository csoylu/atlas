// The menu bar orb's resting « breath » (card #56), macOS only. Swapping tray images costs ~6.6 ms of main-thread
// time per frame (AppKit redraws the status item and each of its per-display replicants), ≈3% of a core at 5 fps.
// Instead one Core Animation layer sits over the status item's (static teal disc) image and macOS animates it: the
// disc swells a little and a soft glow comes and goes, with no work left in Atlas between state changes.
//
// Node-API (ABI-stable: no rebuild per Electron version). Built by build.mjs with clang into dist/native/breathe.node.
//   attach({ r, g, b, base, swell, glow, period }) → true | error string   sizes in points, period in seconds
//   detach()
// Replicants (the menu bar on other displays) are still snapshots: they show the static disc, which is the fallback.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

static CALayer *orb = nil;

static NSButton *findButton(NSView *v) {
  if ([v isKindOfClass:[NSButton class]] && [NSStringFromClass([v class]) containsString:@"StatusBarButton"]) return (NSButton *)v;
  for (NSView *s in v.subviews) {
    NSButton *b = findButton(s);
    if (b) return b;
  }
  return nil;
}

// Atlas has one status item (the tray), so the first status bar button in our windows is it.
static NSButton *statusButton() {
  for (NSWindow *w in NSApp.windows) {
    if (![NSStringFromClass([w class]) containsString:@"StatusBarWindow"] || !w.contentView) continue;
    NSButton *b = findButton(w.contentView);
    if (b) return b;
  }
  return nil;
}

static double num(napi_env env, napi_value o, const char *key) {
  napi_value v;
  double d = 0;
  napi_get_named_property(env, o, key, &v);
  napi_get_value_double(env, v, &d);
  return d;
}

static napi_value Detach(napi_env env, napi_callback_info info) {
  [orb removeFromSuperlayer];
  orb = nil;
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value o;
  napi_get_cb_info(env, info, &argc, &o, nullptr, nullptr);
  napi_value res;
  if (argc < 1) {
    napi_get_boolean(env, false, &res);
    return res;
  }
  double r = num(env, o, "r"), g = num(env, o, "g"), b = num(env, o, "b");
  double base = num(env, o, "base"), swell = num(env, o, "swell"), glow = num(env, o, "glow"), period = num(env, o, "period");
  [orb removeFromSuperlayer];
  orb = nil;
  NSButton *button = statusButton();
  if (!button) {
    napi_create_string_utf8(env, "no status bar button in this app's windows", NAPI_AUTO_LENGTH, &res);
    return res;
  }
  button.wantsLayer = YES;
  if (!button.layer) {
    napi_create_string_utf8(env, "the status bar button has no layer", NAPI_AUTO_LENGTH, &res);
    return res;
  }
  NSRect img = [button.cell imageRectForBounds:button.bounds];
  CGColorRef c = CGColorCreateSRGB(r / 255, g / 255, b / 255, 1);
  CGFloat d = 2 * base;
  orb = [CALayer layer];
  orb.frame = CGRectMake(NSMidX(img) - base, NSMidY(img) - base, d, d);
  orb.cornerRadius = base;
  orb.backgroundColor = c;
  orb.shadowColor = c;
  orb.shadowOffset = CGSizeZero;
  orb.shadowRadius = glow;
  orb.shadowOpacity = 0;
  orb.zPosition = 10;
  orb.contentsScale = button.window.backingScaleFactor;
  CGColorRelease(c);
  CABasicAnimation *scale = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
  scale.fromValue = @1.0;
  scale.toValue = @(swell / base);
  CABasicAnimation *halo = [CABasicAnimation animationWithKeyPath:@"shadowOpacity"];
  halo.fromValue = @0;
  halo.toValue = @0.9;
  CAAnimationGroup *breath = [CAAnimationGroup animation];
  breath.animations = @[ scale, halo ];
  breath.duration = period / 2; // in, then out (autoreverses)
  breath.autoreverses = YES;
  breath.repeatCount = HUGE_VALF;
  breath.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
  breath.removedOnCompletion = NO;
  [orb addAnimation:breath forKey:@"breathe"];
  [button.layer addSublayer:orb];
  napi_get_boolean(env, true, &res);
  return res;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, nullptr, &fn);
  napi_set_named_property(env, exports, "attach", fn);
  napi_create_function(env, "detach", NAPI_AUTO_LENGTH, Detach, nullptr, &fn);
  napi_set_named_property(env, exports, "detach", fn);
  return exports;
}
