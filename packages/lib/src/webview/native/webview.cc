// The translation unit that turns the vendored header into a shared library, exactly as
// upstream's core/src/webview.cc does. WEBVIEW_BUILD_SHARED (set by the build script) is
// what makes the header emit its C API with default visibility instead of inline.
//
// Windows only, one rename: webview.h creates its WebView2 environment with a fixed
// profile folder (%APPDATA%\<exe name>) and no environment options, and the loader then
// ignores the WEBVIEW2_* variables that would override them. So the one loader call it
// makes is routed to webview_extras_win.cc, which supplies both (see
// webview_extras_environment there). The macro renames the prototype in WebView2.h and the
// call in webview.h alike; the header itself stays byte-identical to upstream.
#ifdef _WIN32
#define CreateCoreWebView2EnvironmentWithOptions yaar_create_webview2_environment
#endif
#include "webview/webview.h"
