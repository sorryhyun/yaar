// The translation unit that turns the vendored header into a shared library, exactly as
// upstream's core/src/webview.cc does. WEBVIEW_BUILD_SHARED (set by the build script) is
// what makes the header emit its C API with default visibility instead of inline.
#include "webview/webview.h"
