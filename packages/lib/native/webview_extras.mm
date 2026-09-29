// What a desktop window needs from Cocoa that webview/webview.h does not do.
//
// Compiled into the same dylib as the vendored header (see scripts/build/webview-native.ts)
// and kept in its own file so webview/webview.h stays byte-identical to its upstream tag.
// Everything here is called on the main thread, between webview_create() and webview_run(),
// on the NSWindow webview_get_window() returns or the WKWebView
// webview_get_native_handle(…BROWSER_CONTROLLER) returns — except the clipboard and
// open-URL calls, which a binding handler makes from inside the loop (also the main thread).
//
// macOS only. The other platforms get their equivalents when their hosts land.

#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>
#import <Security/Security.h>
#import <WebKit/WebKit.h>
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <objc/runtime.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXTRAS_API extern "C" __attribute__((visibility("default")))

static NSMenuItem *item(NSString *title, SEL action, NSString *key,
                        NSEventModifierFlags mods = NSEventModifierFlagCommand) {
  NSMenuItem *it = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
  it.keyEquivalentModifierMask = mods;
  return it;
}

static NSMenu *submenu(NSMenu *bar, NSString *title) {
  NSMenuItem *holder = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
  NSMenu *menu = [[NSMenu alloc] initWithTitle:title];
  holder.submenu = menu;
  [bar addItem:holder];
  return menu;
}

static const NSInteger kCloseItemTag = 0x77;  // 'w'

// The main menu. Without one, WKWebView gets no Cut/Copy/Paste/Select All/Undo at all:
// those reach the web view only as menu key equivalents sent down the responder chain, so
// a window with no Edit menu cannot paste. Quit, Hide and Minimize are the same story.
static void install_main_menu(NSString *appName) {
  NSMenu *bar = [[NSMenu alloc] init];

  NSMenu *app = submenu(bar, appName);
  [app addItem:item([@"Hide " stringByAppendingString:appName], @selector(hide:), @"h")];
  [app addItem:item(@"Hide Others", @selector(hideOtherApplications:), @"h",
                    NSEventModifierFlagCommand | NSEventModifierFlagOption)];
  [app addItem:item(@"Show All", @selector(unhideAllApplications:), @"", 0)];
  [app addItem:[NSMenuItem separatorItem]];
  [app addItem:item([@"Quit " stringByAppendingString:appName], @selector(terminate:), @"q")];

  NSMenu *edit = submenu(bar, @"Edit");
  [edit addItem:item(@"Undo", @selector(undo:), @"z")];
  [edit addItem:item(@"Redo", @selector(redo:), @"z",
                     NSEventModifierFlagCommand | NSEventModifierFlagShift)];
  [edit addItem:[NSMenuItem separatorItem]];
  [edit addItem:item(@"Cut", @selector(cut:), @"x")];
  [edit addItem:item(@"Copy", @selector(copy:), @"c")];
  [edit addItem:item(@"Paste", @selector(paste:), @"v")];
  [edit addItem:item(@"Select All", @selector(selectAll:), @"a")];

  NSMenu *view = submenu(bar, @"View");
  [view addItem:item(@"Enter Full Screen", @selector(toggleFullScreen:), @"f",
                     NSEventModifierFlagCommand | NSEventModifierFlagControl)];

  NSMenu *window = submenu(bar, @"Window");
  [window addItem:item(@"Minimize", @selector(performMiniaturize:), @"m")];
  [window addItem:item(@"Zoom", @selector(performZoom:), @"", 0)];
  [window addItem:[NSMenuItem separatorItem]];
  // ⌘W closes this window until `webview_extras_route_close_key` hands the key to the page.
  NSMenuItem *close = item(@"Close Window", @selector(performClose:), @"w");
  close.tag = kCloseItemTag;
  [window addItem:close];
  NSApp.windowsMenu = window;

  NSApp.mainMenu = bar;
}

// Make `nswindow` a first-class app window: a Dock icon, a menu bar, a remembered frame.
//
// The activation policy is set unconditionally. webview.h sets it only for an *unbundled*
// process, on the assumption that a bundle's Info.plist already asks for a regular app —
// but a bundle that marks itself LSUIElement (so its headless server process stays out of
// the Dock) would then leave the window process as an accessory: no Dock icon, no menu.
//
// `autosave_name` restores the window's last frame and saves it on every move and resize;
// null keeps whatever size the caller set.
EXTRAS_API void webview_extras_configure(void *nswindow, const char *app_name,
                                         const char *autosave_name) {
  @autoreleasepool {
    NSWindow *win = (__bridge NSWindow *)nswindow;
    NSString *name = [NSString stringWithUTF8String:app_name ? app_name : "App"];

    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    install_main_menu(name);

    win.styleMask |= NSWindowStyleMaskMiniaturizable;
    win.collectionBehavior |= NSWindowCollectionBehaviorFullScreenPrimary;
    if (autosave_name) {
      NSString *key = [NSString stringWithUTF8String:autosave_name];
      [win setFrameUsingName:key];
      [win setFrameAutosaveName:key];
    }

    [win makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
  }
}

// Exit as soon as process `pid` does, however it went — including SIGKILL, which no
// signal handler in that process would see. The window is a view onto that process's
// server; without it the window is a dead page.
//
// A kqueue proc source on the main queue, which the Cocoa run loop inside webview_run()
// services, so nothing polls. Returns 0 when armed, -1 when `pid` is already gone or the
// source could not be made (the caller decides what that means).
static dispatch_source_t parent_watch;  // held for the process lifetime

EXTRAS_API int webview_extras_exit_with_process(int pid) {
  dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid,
                                                 DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  if (!src) return -1;
  dispatch_source_set_event_handler(src, ^{
    exit(0);
  });
  dispatch_resume(src);
  parent_watch = src;
  // kqueue arms against a live pid only, so a parent that died before this call would
  // never fire. Checked after arming so the gap between the two cannot lose an exit.
  if (kill(pid, 0) != 0 && errno == ESRCH) return -1;
  return 0;
}

// ---------------------------------------------------------------------------------------
// The web view's delegates: downloads, new windows, capture permission, loopback TLS, and
// a gate on who may call the page bindings.
//
// webview.h sets a UI delegate of its own (for the file chooser) and no navigation
// delegate, and the header stays unedited — so one proxy object takes both slots, answers
// the methods below itself, and forwards everything else to whatever was there before.
// ---------------------------------------------------------------------------------------

static BOOL is_loopback_host(NSString *host) {
  if (!host) return NO;
  NSString *h = host.lowercaseString;
  return [h isEqualToString:@"localhost"] || [h isEqualToString:@"127.0.0.1"] ||
         [h isEqualToString:@"::1"] || [h isEqualToString:@"[::1]"];
}

static BOOL scheme_is(NSURL *url, NSString *scheme) {
  return url.scheme && [url.scheme caseInsensitiveCompare:scheme] == NSOrderedSame;
}

// The only schemes anything here hands to another app. `file:` or a custom scheme from a
// page would launch whatever claims it, which is a page choosing a program to run.
static BOOL is_external_scheme(NSURL *url) {
  return scheme_is(url, @"http") || scheme_is(url, @"https") || scheme_is(url, @"mailto");
}

static BOOL open_external(NSURL *url) {
  if (!url || !is_external_scheme(url)) return NO;
  return [[NSWorkspace sharedWorkspace] openURL:url];
}

// `dir/name`, or `dir/name (1).ext`, `(2)`… — the first that does not exist yet. The
// same rule the TypeScript side uses for bridge downloads, so both kinds of download
// land side by side under the names a browser would give them.
static NSURL *unique_destination(NSString *dir, NSString *suggested) {
  // The last path segment, no colons, no leading dots (a page does not get to drop a
  // hidden file) — the same cleaning as the bridge's safeFileName().
  NSString *name = [[suggested ?: @"" stringByReplacingOccurrencesOfString:@"\\" withString:@"/"]
      lastPathComponent];
  name = [name stringByReplacingOccurrencesOfString:@":" withString:@"_"];
  NSCharacterSet *strip = [NSCharacterSet characterSetWithCharactersInString:@". \t\r\n"];
  while (name.length && [strip characterIsMember:[name characterAtIndex:0]])
    name = [name substringFromIndex:1];
  name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (name.length == 0 || [name isEqualToString:@"/"]) name = @"download";
  NSString *ext = name.pathExtension;
  NSString *base = ext.length ? name.stringByDeletingPathExtension : name;

  NSFileManager *fm = NSFileManager.defaultManager;
  [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  for (int i = 0; i < 10000; i++) {
    NSString *candidate =
        i == 0 ? name
               : (ext.length ? [NSString stringWithFormat:@"%@ (%d).%@", base, i, ext]
                             : [NSString stringWithFormat:@"%@ (%d)", base, i]);
    NSString *path = [dir stringByAppendingPathComponent:candidate];
    if (![fm fileExistsAtPath:path]) return [NSURL fileURLWithPath:path];
  }
  return nil;
}

// Bounce the Dock's Downloads stack for a file that just landed, as Safari does — the
// one sign the user gets that a download happened in a window with no download UI.
static void note_download(NSString *path) {
  [[NSDistributedNotificationCenter defaultCenter]
      postNotificationName:@"com.apple.DownloadFileFinished"
                    object:path];
}

// base64(sha256(SPKI DER)) of the leaf certificate — the format of @yaar/lib/tls's
// spkiHash() and of Chromium's --ignore-certificate-errors-spki-list — or nil.
//
// Security.framework hands out a key's raw form, not its SPKI, so the DER is rebuilt:
// for an EC P-256 key it is a fixed 26-byte header and the 65-byte uncompressed point.
// Only P-256 is recognised because that is the only key the local certificate is ever
// minted with (ensureSelfSignedCert); any other key simply fails to match the pin.
static NSString *leaf_spki_sha256(SecTrustRef trust) {
  static const uint8_t kP256SpkiHeader[] = {
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};
  NSString *result = nil;
  CFArrayRef chain = SecTrustCopyCertificateChain(trust);
  if (!chain) return nil;
  if (CFArrayGetCount(chain) > 0) {
    SecCertificateRef leaf = (SecCertificateRef)CFArrayGetValueAtIndex(chain, 0);
    SecKeyRef key = SecCertificateCopyKey(leaf);
    if (key) {
      NSDictionary *attrs = CFBridgingRelease(SecKeyCopyAttributes(key));
      NSData *raw = CFBridgingRelease(SecKeyCopyExternalRepresentation(key, NULL));
      BOOL p256 = [attrs[(__bridge id)kSecAttrKeyType]
                      isEqual:(__bridge id)kSecAttrKeyTypeECSECPrimeRandom] &&
                  [attrs[(__bridge id)kSecAttrKeySizeInBits] integerValue] == 256;
      if (p256 && raw.length == 65) {
        NSMutableData *der = [NSMutableData dataWithBytes:kP256SpkiHeader
                                                   length:sizeof kP256SpkiHeader];
        [der appendData:raw];
        uint8_t digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(der.bytes, (CC_LONG)der.length, digest);
        result = [[NSData dataWithBytes:digest length:sizeof digest] base64EncodedStringWithOptions:0];
      }
      CFRelease(key);
    }
  }
  CFRelease(chain);
  return result;
}

// Ask macOS for each capture device the request needs, in turn, then decide. WebKit on
// its own asks macOS only for the main frame — the first request from an isolated app
// frame was refused with no system prompt at all (measured 2026-09-29) — so the app asks first.
static void authorize_capture(NSArray<AVMediaType> *types, NSUInteger i,
                              void (^decide)(WKPermissionDecision)) API_AVAILABLE(macos(12.0)) {
  if (i == types.count) {
    decide(WKPermissionDecisionGrant);
    return;
  }
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:types[i]];
  if (status == AVAuthorizationStatusAuthorized) {
    authorize_capture(types, i + 1, decide);
  } else if (status == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:types[i]
                             completionHandler:^(BOOL granted) {
                               // Called on an arbitrary queue; WebKit wants its answer on
                               // the main thread.
                               dispatch_async(dispatch_get_main_queue(), ^{
                                 if (granted)
                                   authorize_capture(types, i + 1, decide);
                                 else
                                   decide(WKPermissionDecisionDeny);
                               });
                             }];
  } else {  // denied in System Settings, or restricted
    decide(WKPermissionDecisionDeny);
  }
}

@interface YaarPopup : NSObject <NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@end

@interface YaarWebViewDelegate : NSObject <WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property(nonatomic, strong) id innerUI;
@property(nonatomic, strong) id innerNavigation;
@property(nonatomic, copy) NSString *downloadsDir;
@property(nonatomic, copy) NSString *trustedSpki;
@end

// Process-lifetime state. WKWebView and WKDownload hold their delegates weakly, so these
// strong references are what keeps the delegates alive.
static YaarWebViewDelegate *g_delegate;
static WKWebView *g_primary;
static NSMutableSet<YaarPopup *> *g_popups;
static NSMapTable<WKDownload *, NSURL *> *g_downloads;
static NSURL *g_binding_origin;  // nil: any top frame of the primary web view

@implementation YaarPopup
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
  // A popup has no address bar, and it is where an OAuth provider asks for a password:
  // the title bar says whose page it is.
  NSURL *url = self.webView.URL;
  NSString *where = url.host.length ? url.host : url.absoluteString;
  self.window.title = where.length ? where : @"";
}
- (void)windowWillClose:(NSNotification *)note {
  [self.webView removeObserver:self forKeyPath:@"URL"];
  [g_popups removeObject:self];
}
@end

// A real window for a script popup. Built with the configuration WebKit hands over (it
// refuses any other), but with a fresh user content controller: the shared one carries
// the desktop's bindings and init scripts, and a popup is an ordinary browser window —
// for an OAuth popup, one showing someone else's site.
static WKWebView *open_popup(WKWebView *opener, WKWebViewConfiguration *config,
                             WKWindowFeatures *features) {
  config.userContentController = [[WKUserContentController alloc] init];
  CGFloat w = features.width ? features.width.doubleValue : 820;
  CGFloat h = features.height ? features.height.doubleValue : 720;
  NSRect rect = NSMakeRect(0, 0, w, h);

  YaarPopup *popup = [[YaarPopup alloc] init];
  popup.window = [[NSWindow alloc]
      initWithContentRect:rect
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  popup.window.releasedWhenClosed = NO;  // g_popups owns it
  popup.webView = [[WKWebView alloc] initWithFrame:rect configuration:config];
  popup.webView.UIDelegate = g_delegate;
  popup.webView.navigationDelegate = g_delegate;
  popup.window.contentView = popup.webView;
  popup.window.delegate = popup;
  [popup.webView addObserver:popup forKeyPath:@"URL" options:0 context:nil];

  NSWindow *parent = opener.window;
  if (parent) {
    NSPoint origin = parent.frame.origin;
    [popup.window setFrameTopLeftPoint:NSMakePoint(origin.x + 40, NSMaxY(parent.frame) - 40)];
  } else {
    [popup.window center];
  }
  if (!g_popups) g_popups = [NSMutableSet set];
  [g_popups addObject:popup];
  [popup.window makeKeyAndOrderFront:nil];
  return popup.webView;
}

@implementation YaarWebViewDelegate

// Everything not implemented here goes to the delegate webview.h installed.
- (BOOL)respondsToSelector:(SEL)sel {
  return [super respondsToSelector:sel] || [self.innerUI respondsToSelector:sel] ||
         [self.innerNavigation respondsToSelector:sel];
}
- (id)forwardingTargetForSelector:(SEL)sel {
  if ([self.innerUI respondsToSelector:sel]) return self.innerUI;
  if ([self.innerNavigation respondsToSelector:sel]) return self.innerNavigation;
  return [super forwardingTargetForSelector:sel];
}

// ---- Downloads -------------------------------------------------------------------------
//
// With no navigation delegate, WKWebView never downloads anything: `<a download>` (a
// blob: from an app frame included) and an attachment response are silently dropped.

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  if (action.shouldPerformDownload && self.downloadsDir) {
    decisionHandler(WKNavigationActionPolicyDownload);
    return;
  }
  // A mailto: link cannot load in a web view; hand it to the mail app instead.
  if (scheme_is(action.request.URL, @"mailto")) {
    open_external(action.request.URL);
    decisionHandler(WKNavigationActionPolicyCancel);
    return;
  }
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationResponse:(WKNavigationResponse *)response
                      decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
  BOOL attachment = NO;
  if ([response.response isKindOfClass:NSHTTPURLResponse.class]) {
    NSString *cd =
        [(NSHTTPURLResponse *)response.response valueForHTTPHeaderField:@"Content-Disposition"];
    cd = [cd stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    attachment = cd && [cd.lowercaseString hasPrefix:@"attachment"];
  }
  if (self.downloadsDir && (attachment || !response.canShowMIMEType)) {
    decisionHandler(WKNavigationResponsePolicyDownload);
    return;
  }
  decisionHandler(WKNavigationResponsePolicyAllow);
}

- (void)webView:(WKWebView *)webView
    navigationAction:(WKNavigationAction *)action
    didBecomeDownload:(WKDownload *)download {
  download.delegate = self;
}

- (void)webView:(WKWebView *)webView
    navigationResponse:(WKNavigationResponse *)response
     didBecomeDownload:(WKDownload *)download {
  download.delegate = self;
}

- (void)download:(WKDownload *)download
    decideDestinationUsingResponse:(NSURLResponse *)response
                 suggestedFilename:(NSString *)suggestedFilename
                 completionHandler:(void (^)(NSURL *))completionHandler {
  NSURL *dest = self.downloadsDir ? unique_destination(self.downloadsDir, suggestedFilename) : nil;
  if (dest) [g_downloads setObject:dest forKey:download];
  completionHandler(dest);  // nil cancels
}

- (void)downloadDidFinish:(WKDownload *)download {
  NSURL *dest = [g_downloads objectForKey:download];
  [g_downloads removeObjectForKey:download];
  if (!dest) return;
  fprintf(stderr, "[yaar] downloaded %s\n", dest.path.fileSystemRepresentation);
  note_download(dest.path);
}

- (void)download:(WKDownload *)download
    didFailWithError:(NSError *)error
          resumeData:(NSData *)resumeData {
  [g_downloads removeObjectForKey:download];
  fprintf(stderr, "[yaar] download failed: %s\n", error.localizedDescription.UTF8String);
}

// ---- New windows -----------------------------------------------------------------------
//
// With no UI delegate method, window.open() returns null and target=_blank does nothing.
// The rule:
//  - http(s) off this machine → the user's browser, and no window here. A link out of
//    YAAR is a link to the web, which belongs in a browser with an address bar.
//  - mailto: → the mail app.
//  - about:blank / empty → a real popup. That is a script that opens a window first and
//    navigates it afterwards — market-apps' GitHub sign-in does window.open('', '_blank')
//    and then sets its location, and the popup must stay attached to its opener.
//  - loopback http(s), blob: → a popup too: YAAR's own pages, and a blob only this web
//    view can resolve.
//  - anything else → nothing.

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)action
                    windowFeatures:(WKWindowFeatures *)features {
  NSURL *url = action.request.URL;
  NSString *abs = url.absoluteString ?: @"";
  BOOL blank = abs.length == 0 || [abs isEqualToString:@"about:blank"];
  if (!blank) {
    if (scheme_is(url, @"http") || scheme_is(url, @"https")) {
      if (!is_loopback_host(url.host)) {
        open_external(url);
        return nil;
      }
    } else if (scheme_is(url, @"mailto")) {
      open_external(url);
      return nil;
    } else if (!scheme_is(url, @"blob")) {
      return nil;
    }
  }
  return open_popup(webView, configuration, features);
}

// window.close() from a popup. The desktop's own window.close() is ignored, as before.
- (void)webViewDidClose:(WKWebView *)webView {
  for (YaarPopup *popup in [g_popups copy]) {
    if (popup.webView == webView) [popup.window close];
  }
}

// ---- Microphone and camera -------------------------------------------------------------
//
// Granted to this machine's own pages only (the desktop on localhost, isolated apps on
// 127.0.0.1) — and only once macOS has said yes — so no WebKit prompt stacks on top of
// the system one. Anything else, including a popup on someone else's site, is refused.

- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision))decisionHandler
    API_AVAILABLE(macos(12.0)) {
  if (!is_loopback_host(origin.host) || !is_loopback_host(frame.securityOrigin.host)) {
    decisionHandler(WKPermissionDecisionDeny);
    return;
  }
  NSMutableArray<AVMediaType> *types = [NSMutableArray array];
  if (type == WKMediaCaptureTypeMicrophone || type == WKMediaCaptureTypeCameraAndMicrophone)
    [types addObject:AVMediaTypeAudio];
  if (type == WKMediaCaptureTypeCamera || type == WKMediaCaptureTypeCameraAndMicrophone)
    [types addObject:AVMediaTypeVideo];
  authorize_capture(types, 0, decisionHandler);
}

// ---- Loopback TLS ----------------------------------------------------------------------
//
// The local h2 socket's certificate is self-signed. Chromium is told to trust it by SPKI
// on its command line; WebKit has no such flag, so the pin is checked here — for a
// loopback host only, and for that one key only. Everything else gets WebKit's default
// handling, which is to say the system trust store.

- (void)webView:(WKWebView *)webView
    didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
                    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition,
                                                NSURLCredential *))completionHandler {
  NSURLProtectionSpace *space = challenge.protectionSpace;
  if (self.trustedSpki &&
      [space.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust] &&
      is_loopback_host(space.host) && space.serverTrust) {
    NSString *spki = leaf_spki_sha256(space.serverTrust);
    if ([spki isEqualToString:self.trustedSpki]) {
      completionHandler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:space.serverTrust]);
      return;
    }
    fprintf(stderr, "[yaar] refusing %s:%ld: its key is not the pinned one\n",
            space.host.UTF8String, (long)space.port);
  }
  completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}

@end

// ---- The binding gate ------------------------------------------------------------------
//
// webview.h registers one script message handler, `__webview__`, and every binding call
// arrives through it. Its user scripts are main-frame only (WKUserScript
// forMainFrameOnly:YES), so a subframe never gets the binding *functions* — but
// `window.webkit.messageHandlers.__webview__` is exposed to every frame, and an app iframe
// could post a hand-built call to it directly. So the header's handler is wrapped: a
// message reaches it only from the top frame of the primary web view, and only from the
// binding origin when one is set.

static IMP g_header_on_message;

static NSInteger effective_port(NSString *scheme, NSInteger port) {
  if (port) return port;
  if ([scheme caseInsensitiveCompare:@"https"] == NSOrderedSame) return 443;
  if ([scheme caseInsensitiveCompare:@"http"] == NSOrderedSame) return 80;
  return 0;
}

static BOOL message_allowed(WKScriptMessage *msg) {
  if (!g_primary || msg.webView != g_primary || !msg.frameInfo.isMainFrame) return NO;
  if (!g_binding_origin) return YES;
  WKSecurityOrigin *o = msg.frameInfo.securityOrigin;
  return [o.protocol caseInsensitiveCompare:g_binding_origin.scheme] == NSOrderedSame &&
         [o.host caseInsensitiveCompare:g_binding_origin.host] == NSOrderedSame &&
         effective_port(o.protocol, o.port) ==
             effective_port(g_binding_origin.scheme, g_binding_origin.port.integerValue);
}

static void gated_on_message(id self, SEL cmd, WKUserContentController *ucc,
                             WKScriptMessage *msg) {
  if (!message_allowed(msg)) {
    WKSecurityOrigin *o = msg.frameInfo.securityOrigin;
    fprintf(stderr, "[yaar] dropped a binding call from %s://%s:%ld (%s frame)\n",
            o.protocol.UTF8String, o.host.UTF8String, (long)o.port,
            msg.frameInfo.isMainFrame ? "main" : "sub");
    return;
  }
  ((void (*)(id, SEL, WKUserContentController *, WKScriptMessage *))g_header_on_message)(
      self, cmd, ucc, msg);
}

static BOOL install_binding_gate(void) {
  if (g_header_on_message) return YES;
  Class cls = objc_lookUpClass("WebviewWKScriptMessageHandler");
  Method m = cls ? class_getInstanceMethod(cls, @selector(userContentController:
                                                              didReceiveScriptMessage:))
                 : NULL;
  if (!m) return NO;
  g_header_on_message = method_setImplementation(m, (IMP)gated_on_message);
  return YES;
}

// Take over the web view's delegates (see above). `wkwebview` is
// webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER).
//
//  - `binding_origin`: only the top frame of this origin (scheme://host:port) may call
//    bindings; null allows any top frame of this web view.
//  - `downloads_dir`: where downloads go; null leaves downloads off, as webview.h has them.
//  - `trusted_spki`: base64(sha256(SPKI)) of the one certificate key a loopback HTTPS
//    server may present; null leaves TLS to the system trust store.
//
// Returns 0, or -1 when the binding gate could not be installed (a webview.h whose
// message handler is not the one this file knows) — the caller should then not expose
// bindings, since nothing would keep app frames from calling them.
EXTRAS_API int webview_extras_attach(void *wkwebview, const char *binding_origin,
                                     const char *downloads_dir, const char *trusted_spki) {
  @autoreleasepool {
    WKWebView *webView = (__bridge WKWebView *)wkwebview;
    if (!webView || g_primary) return -1;
    if (!install_binding_gate()) return -1;
    g_primary = webView;
    g_binding_origin =
        binding_origin ? [NSURL URLWithString:[NSString stringWithUTF8String:binding_origin]]
                       : nil;
    g_downloads = [NSMapTable strongToStrongObjectsMapTable];

    YaarWebViewDelegate *d = [[YaarWebViewDelegate alloc] init];
    d.innerUI = webView.UIDelegate;
    d.innerNavigation = webView.navigationDelegate;
    d.downloadsDir = downloads_dir ? [NSString stringWithUTF8String:downloads_dir] : nil;
    d.trustedSpki = trusted_spki ? [NSString stringWithUTF8String:trusted_spki] : nil;
    g_delegate = d;
    webView.UIDelegate = d;
    webView.navigationDelegate = d;
    // webview.h's destructor sends -release to whatever UI delegate the web view has,
    // assuming it is the one it created. This is the reference that release returns.
    (void)CFBridgingRetain(d);
    return 0;
  }
}

// ⌘W as the page's close key rather than the native window's.
//
// A page that is itself a desktop of windows (YAAR's) wants ⌘W to close *its* top window,
// the way every Mac app closes its front document; closing the native window instead
// takes the whole page with it on one stray keystroke. So the Close Window item stops
// sending performClose: and dispatches `event_name` on the primary web view's top frame.
// The key still reaches the page first as a keydown — WKWebView offers key equivalents to
// the page before the menu — so a frame that handles ⌘W itself and cancels it keeps it.
// The window's own close button is untouched.
@interface YaarCloseKeyTarget : NSObject
@property(nonatomic, copy) NSString *script;
@end

@implementation YaarCloseKeyTarget
- (void)closeKey:(id)sender {
  [g_primary evaluateJavaScript:self.script completionHandler:nil];
}
@end

static YaarCloseKeyTarget *g_close_target;

// Returns 0, or -1 before `webview_extras_attach`, without a menu, or for a name that is
// not a plain event name ([A-Za-z0-9:_-]+ — it is spliced into a script).
EXTRAS_API int webview_extras_route_close_key(const char *event_name) {
  @autoreleasepool {
    if (!g_primary || !event_name) return -1;
    NSString *name = [NSString stringWithUTF8String:event_name];
    NSMutableCharacterSet *allowed = [NSMutableCharacterSet alphanumericCharacterSet];
    [allowed addCharactersInString:@":_-"];
    if (name.length == 0 ||
        [name rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) {
      return -1;
    }
    NSMenuItem *close = nil;
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
      close = [top.submenu itemWithTag:kCloseItemTag];
      if (close) break;
    }
    if (!close) return -1;
    g_close_target = [[YaarCloseKeyTarget alloc] init];
    g_close_target.script =
        [NSString stringWithFormat:@"window.dispatchEvent(new Event('%@'))", name];
    close.target = g_close_target;
    close.action = @selector(closeKey:);
    return 0;
  }
}

EXTRAS_API void webview_extras_note_download(const char *path) {
  if (!path) return;
  @autoreleasepool {
    note_download([NSString stringWithUTF8String:path]);
  }
}

// ---- Clipboard and URLs, for binding handlers -------------------------------------------
//
// A page in WKWebView can write the clipboard but not read it (navigator.clipboard.readText
// is NotAllowedError without a user paste gesture), so reads come through a binding.

// The clipboard's text as malloc'd UTF-8 (free with webview_extras_free), or null when
// it holds no text.
EXTRAS_API char *webview_extras_clipboard_read_text(void) {
  @autoreleasepool {
    NSString *s = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
    return s ? strdup(s.UTF8String) : NULL;
  }
}

// Replace the clipboard with `len` bytes of UTF-8 text. 0, or -1 on bad UTF-8 or a refusal.
EXTRAS_API int webview_extras_clipboard_write_text(const char *utf8, int len) {
  @autoreleasepool {
    if (!utf8 || len < 0) return -1;
    NSString *s = [[NSString alloc] initWithBytes:utf8
                                           length:(NSUInteger)len
                                         encoding:NSUTF8StringEncoding];
    if (!s) return -1;
    NSPasteboard *pb = NSPasteboard.generalPasteboard;
    [pb clearContents];
    return [pb setString:s forType:NSPasteboardTypeString] ? 0 : -1;
  }
}

EXTRAS_API void webview_extras_free(void *p) { free(p); }

// Open an http(s) or mailto: URL in the app that handles it. 0, or -1 when refused.
EXTRAS_API int webview_extras_open_external(const char *url) {
  @autoreleasepool {
    if (!url) return -1;
    NSURL *u = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    return open_external(u) ? 0 : -1;
  }
}
