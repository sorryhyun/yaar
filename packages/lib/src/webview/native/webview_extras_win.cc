// What a desktop window needs from Win32 and WebView2 that webview/webview.h does not do.
//
// The Windows twin of webview_extras.mm: the same C API, compiled into the same DLL as the
// vendored header (see scripts/build/webview-native.ts) and kept in its own file so
// webview/webview.h stays byte-identical to its upstream tag. Everything here is called on
// the UI thread, between webview_create() and webview_run(), on the HWND
// webview_get_window() returns or the ICoreWebView2Controller
// webview_get_native_handle(…BROWSER_CONTROLLER) returns — except the clipboard and
// open-URL calls, which a binding handler makes from inside the loop (also the UI thread),
// and the parent-exit wait, which fires on a thread-pool thread and only exits.
//
// WebView2's defaults already cover much of what the macOS file adds by hand: a download
// flyout (blob: included), the native file chooser, popups, a clipboard-read prompt. What
// is left is the binding gate, links out to the default browser, capture permission,
// the loopback TLS pin, and a remembered window placement.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <bcrypt.h>
#include <commctrl.h>
#include <shellapi.h>
#include <urlmon.h>
#include <wincrypt.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <functional>
#include <string>
#include <utility>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"

#define EXTRAS_API extern "C" __declspec(dllexport)

// ---- Strings ----------------------------------------------------------------------------

static std::wstring widen(const char *utf8, int len = -1) {
  if (!utf8) return {};
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, len, nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, len, out.data(), n);
  if (len < 0 && !out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

static std::string narrow(const wchar_t *w) {
  if (!w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
  out.pop_back();  // the NUL
  return out;
}

static bool iequals(const std::wstring &a, const wchar_t *b) {
  return _wcsicmp(a.c_str(), b) == 0;
}

// A WebView2 string out-parameter, freed with CoTaskMemFree.
struct CoString {
  LPWSTR p = nullptr;
  ~CoString() { CoTaskMemFree(p); }
  LPWSTR *out() { return &p; }
  std::wstring str() const { return p ? p : L""; }
};

// ---- URLs -------------------------------------------------------------------------------

struct Origin {
  std::wstring scheme;  // lower case
  std::wstring host;    // lower case, IPv6 without brackets
  DWORD port = 0;       // the scheme's default when the URL names none
  bool ok = false;
};

// scheme://host:port of `url`, through urlmon's IUri — the same parser Explorer uses, so
// an odd URL cannot parse one way here and another way in the web view's address.
static Origin origin_of(const wchar_t *url) {
  Origin o;
  if (!url || !*url) return o;
  IUri *uri = nullptr;
  if (FAILED(CreateUri(url, Uri_CREATE_CANONICALIZE, 0, &uri)) || !uri) return o;
  BSTR scheme = nullptr, host = nullptr;
  DWORD port = 0;
  if (SUCCEEDED(uri->GetSchemeName(&scheme)) && scheme) o.scheme = scheme;
  if (SUCCEEDED(uri->GetHost(&host)) && host) o.host = host;
  if (SUCCEEDED(uri->GetPort(&port))) o.port = port;
  SysFreeString(scheme);
  SysFreeString(host);
  uri->Release();
  for (auto &c : o.scheme) c = static_cast<wchar_t>(towlower(c));
  for (auto &c : o.host) c = static_cast<wchar_t>(towlower(c));
  if (o.host.size() > 1 && o.host.front() == L'[' && o.host.back() == L']') {
    o.host = o.host.substr(1, o.host.size() - 2);
  }
  o.ok = !o.scheme.empty();
  return o;
}

static bool same_origin(const Origin &a, const Origin &b) {
  return a.ok && b.ok && a.scheme == b.scheme && a.host == b.host && a.port == b.port;
}

static bool is_loopback_host(const std::wstring &h) {
  return h == L"localhost" || h == L"127.0.0.1" || h == L"::1";
}

static bool is_http(const Origin &o) { return o.scheme == L"http" || o.scheme == L"https"; }

// The only schemes anything here hands to another program. `file:` or a custom scheme
// from a page would launch whatever claims it, which is a page choosing a program to run.
static bool open_external(const wchar_t *url) {
  Origin o = origin_of(url);
  if (!is_http(o) && o.scheme != L"mailto") return false;
  auto r = reinterpret_cast<INT_PTR>(
      ShellExecuteW(nullptr, L"open", url, nullptr, nullptr, SW_SHOWNORMAL));
  return r > 32;
}

// ---- COM event handlers -----------------------------------------------------------------
//
// Every WebView2 event takes a one-method COM object. One template makes them from
// lambdas; the web view holds the reference, this file holds none.

template <typename Iface, typename Sender, typename Args>
class EventHandler final : public Iface {
 public:
  using Fn = std::function<void(Sender *, Args *)>;
  explicit EventHandler(Fn fn) : fn_(std::move(fn)) {}

  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG left = --refs_;
    if (left == 0) delete this;
    return left;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(Iface)) {
      *ppv = static_cast<Iface *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Invoke(Sender *sender, Args *args) override {
    fn_(sender, args);
    return S_OK;
  }

 private:
  std::atomic<ULONG> refs_{1};
  Fn fn_;
};

// `webview->add_X(handler, &token)` with a fresh handler, the web view keeping the only
// reference. False when the registration was refused.
template <typename Iface, typename Sender, typename Args, typename Target, typename Add,
          typename Fn>
static bool subscribe(Target *target, Add add, Fn fn) {
  auto *h = new EventHandler<Iface, Sender, Args>(std::move(fn));
  EventRegistrationToken token{};
  HRESULT hr = (target->*add)(h, &token);
  h->Release();
  return SUCCEEDED(hr);
}

// ---- The environment ---------------------------------------------------------------------
//
// webview.h creates the WebView2 environment itself, inside webview_create(), with a
// profile folder of %APPDATA%\<exe name> (`bun.exe` from a source checkout) and no
// environment options — and with a folder passed explicitly, the loader ignores
// WEBVIEW2_USER_DATA_FOLDER and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (measured). So
// webview.cc renames the header's one loader call to the function below, which substitutes
// what webview_extras_environment() was given and calls the real loader.

static std::wstring g_user_data_dir;
static std::wstring g_browser_args;

// Before webview_create(): the profile folder (null keeps webview.h's) and extra Chromium
// switches (null or "" for none) for the environment it is about to create.
EXTRAS_API void webview_extras_environment(const char *user_data_dir, const char *browser_args) {
  g_user_data_dir = widen(user_data_dir);
  g_browser_args = widen(browser_args);
}

extern "C" HRESULT STDAPICALLTYPE yaar_create_webview2_environment(
    PCWSTR browser_dir, PCWSTR user_data_dir, ICoreWebView2EnvironmentOptions *options,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *handler) {
  PCWSTR dir = g_user_data_dir.empty() ? user_data_dir : g_user_data_dir.c_str();
  if (options || g_browser_args.empty()) {
    return CreateCoreWebView2EnvironmentWithOptions(browser_dir, dir, options, handler);
  }
  auto ours = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
  ours->put_AdditionalBrowserArguments(g_browser_args.c_str());
  return CreateCoreWebView2EnvironmentWithOptions(browser_dir, dir, ours.Get(), handler);
}

// ---- The window --------------------------------------------------------------------------

static const wchar_t kPlacementKey[] = L"Software\\YAAR\\WindowPlacement";
static std::wstring g_autosave;  // registry value name; empty: placement not remembered

static void save_placement(HWND hwnd) {
  if (g_autosave.empty()) return;
  WINDOWPLACEMENT wp{sizeof(wp)};
  if (!GetWindowPlacement(hwnd, &wp)) return;
  HKEY key;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, kPlacementKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr,
                      &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  RegSetValueExW(key, g_autosave.c_str(), 0, REG_BINARY, reinterpret_cast<const BYTE *>(&wp),
                 sizeof(wp));
  RegCloseKey(key);
}

// The saved placement, if one exists and its normal rectangle is still on a monitor — a
// laptop undocked from the screen the window was last on gets the default size instead.
static void restore_placement(HWND hwnd) {
  if (g_autosave.empty()) return;
  WINDOWPLACEMENT wp{};
  DWORD size = sizeof(wp);
  if (RegGetValueW(HKEY_CURRENT_USER, kPlacementKey, g_autosave.c_str(), RRF_RT_REG_BINARY,
                   nullptr, &wp, &size) != ERROR_SUCCESS ||
      size != sizeof(wp) || wp.length != sizeof(wp)) {
    return;
  }
  if (!MonitorFromRect(&wp.rcNormalPosition, MONITOR_DEFAULTTONULL)) return;
  // Never come back minimized: the window is the whole app.
  if (wp.showCmd != SW_SHOWMAXIMIZED) wp.showCmd = SW_SHOWNORMAL;
  wp.flags = 0;
  SetWindowPlacement(hwnd, &wp);
}

static LRESULT CALLBACK placement_subclass(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp,
                                           UINT_PTR id, DWORD_PTR) {
  if (msg == WM_CLOSE) save_placement(hwnd);
  if (msg == WM_NCDESTROY) RemoveWindowSubclass(hwnd, placement_subclass, id);
  return DefSubclassProc(hwnd, msg, wp, lp);
}

// Make `hwnd` the app's window: the exe's own icon, a remembered placement, and the
// foreground. `app_name` is unused on Windows — the title bar is the title (webview_set_title).
//
// `autosave_name` restores the window's last placement (position, size, maximized) and
// saves it when the window closes, under HKCU\Software\YAAR\WindowPlacement; null keeps
// whatever size the caller set.
EXTRAS_API void webview_extras_configure(void *hwnd_ptr, const char *app_name,
                                         const char *autosave_name) {
  (void)app_name;
  HWND hwnd = static_cast<HWND>(hwnd_ptr);
  if (!hwnd) return;

  // webview.h asks the exe for IDI_APPLICATION, which a Bun-compiled exe does not carry
  // under that id; its first icon is the one Explorer shows for it.
  wchar_t exe[MAX_PATH];
  if (GetModuleFileNameW(nullptr, exe, MAX_PATH)) {
    HICON big = nullptr, little = nullptr;
    if (ExtractIconExW(exe, 0, &big, &little, 1) > 0) {
      if (big) SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(big));
      if (little) SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(little));
    }
  }

  if (autosave_name && *autosave_name) {
    g_autosave = widen(autosave_name);
    restore_placement(hwnd);
    SetWindowSubclass(hwnd, placement_subclass, 1, 0);
  }

  SetForegroundWindow(hwnd);
}

// Exit as soon as process `pid` does, however it went — including TerminateProcess, which
// nothing in that process would see. The window is a view onto that process's server;
// without it the window is a dead page.
//
// A thread-pool wait on the process handle, so nothing polls. Returns 0 when armed, -1 when
// `pid` is already gone or cannot be opened (the caller decides what that means).
static HANDLE g_parent;
static HANDLE g_parent_wait;

static void CALLBACK parent_exited(void *, BOOLEAN) { ExitProcess(0); }

EXTRAS_API int webview_extras_exit_with_process(int pid) {
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
  if (!h) return -1;
  if (WaitForSingleObject(h, 0) == WAIT_OBJECT_0) {
    CloseHandle(h);
    return -1;
  }
  if (!RegisterWaitForSingleObject(&g_parent_wait, h, parent_exited, nullptr, INFINITE,
                                   WT_EXECUTEONLYONCE)) {
    CloseHandle(h);
    return -1;
  }
  g_parent = h;  // held for the process lifetime
  return 0;
}

// ---- Loopback TLS -----------------------------------------------------------------------
//
// The local h2 socket's certificate is self-signed. Chrome is told to trust it by SPKI on
// its command line; here the pin is checked when WebView2 reports the certificate error —
// for a loopback host only, and for that one key only. Everything else gets WebView2's
// default handling, which is to say an error page.

// base64(sha256(SPKI DER)) of a PEM certificate — the format of @yaar/lib/tls's spkiHash()
// and of Chromium's --ignore-certificate-errors-spki-list — or "".
static std::string spki_sha256_of_pem(const std::wstring &pem) {
  std::string result;
  DWORD der_len = 0;
  if (!CryptStringToBinaryW(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER, nullptr, &der_len,
                            nullptr, nullptr)) {
    return result;
  }
  std::string der(der_len, '\0');
  if (!CryptStringToBinaryW(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER,
                            reinterpret_cast<BYTE *>(der.data()), &der_len, nullptr, nullptr)) {
    return result;
  }
  PCCERT_CONTEXT cert = CertCreateCertificateContext(
      X509_ASN_ENCODING, reinterpret_cast<const BYTE *>(der.data()), der_len);
  if (!cert) return result;

  BYTE *spki = nullptr;
  DWORD spki_len = 0;
  if (CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO,
                          &cert->pCertInfo->SubjectPublicKeyInfo, CRYPT_ENCODE_ALLOC_FLAG,
                          nullptr, &spki, &spki_len)) {
    BYTE digest[32];
    if (BCRYPT_SUCCESS(BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, spki, spki_len, digest,
                                  sizeof digest))) {
      DWORD b64_len = 0;
      DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
      if (CryptBinaryToStringA(digest, sizeof digest, flags, nullptr, &b64_len)) {
        result.assign(b64_len, '\0');
        if (CryptBinaryToStringA(digest, sizeof digest, flags, result.data(), &b64_len)) {
          result.resize(b64_len);
        } else {
          result.clear();
        }
      }
    }
    LocalFree(spki);
  }
  CertFreeCertificateContext(cert);
  return result;
}

// ---- The web view -----------------------------------------------------------------------

static ICoreWebView2 *g_webview;  // one reference, held for the process lifetime
static Origin g_binding_origin;   // !ok: any top-level page may call the bindings
static std::string g_trusted_spki;

// The binding gate. webview.h delivers binding calls through
// ICoreWebView2::WebMessageReceived, which WebView2 raises for the *top-level* document
// only — a subframe's chrome.webview.postMessage goes to that frame's own
// ICoreWebView2Frame event, which nothing here subscribes to. So what is left to gate is
// which page the top level is: the desktop origin, and nothing else. A top-level
// navigation anywhere else is cancelled — sent to the default browser when it is a link
// to the web or mail, dropped otherwise — so no other page ever holds the top frame, and
// with it the bindings. (macOS gates each message instead; WebKit exposes its message
// handler to every frame, WebView2 does not.)
static void on_navigation_starting(ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *a) {
  if (!g_binding_origin.ok) return;
  CoString uri;
  if (FAILED(a->get_Uri(uri.out()))) return;
  Origin o = origin_of(uri.p);
  if (same_origin(o, g_binding_origin)) return;
  a->put_Cancel(TRUE);
  if ((is_http(o) && !is_loopback_host(o.host)) || o.scheme == L"mailto") {
    open_external(uri.p);
    return;
  }
  fprintf(stderr, "[yaar] refused a top-level navigation to %s\n", narrow(uri.p).c_str());
}

// New windows (window.open, target=_blank). The rule, as on macOS:
//  - http(s) off this machine → the user's browser, and no window here. A link out of
//    YAAR is a link to the web, which belongs in a browser with an address bar.
//  - mailto: → the mail app.
//  - about:blank / empty → WebView2's own popup. That is a script that opens a window first
//    and navigates it afterwards — market-apps' GitHub sign-in does window.open('',
//    '_blank') and then sets its location, and the popup must stay attached to its opener.
//  - loopback http(s), blob: → a popup too: YAAR's own pages, and a blob only this web
//    view can resolve.
//  - anything else → nothing.
// A popup is a separate web view: it gets neither the bindings nor the init scripts.
static void on_new_window(ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *a) {
  CoString uri;
  if (FAILED(a->get_Uri(uri.out()))) return;
  std::wstring u = uri.str();
  if (u.empty() || iequals(u, L"about:blank")) return;
  Origin o = origin_of(uri.p);
  if (is_http(o) && is_loopback_host(o.host)) return;
  if (o.scheme == L"blob") return;
  a->put_Handled(TRUE);  // no window; window.open() returns null
  if (is_http(o) || o.scheme == L"mailto") open_external(uri.p);
}

// Microphone and camera: granted to this machine's own pages only (the desktop on
// localhost, isolated apps on 127.0.0.1), with no WebView2 prompt on top of Windows' own
// privacy switch. Anything else, including a popup on someone else's site, is refused.
static void on_permission(ICoreWebView2 *, ICoreWebView2PermissionRequestedEventArgs *a) {
  COREWEBVIEW2_PERMISSION_KIND kind;
  if (FAILED(a->get_PermissionKind(&kind))) return;
  if (kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE &&
      kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA) {
    return;
  }
  CoString uri;
  if (FAILED(a->get_Uri(uri.out()))) return;
  Origin o = origin_of(uri.p);
  a->put_State(is_http(o) && is_loopback_host(o.host) ? COREWEBVIEW2_PERMISSION_STATE_ALLOW
                                                      : COREWEBVIEW2_PERMISSION_STATE_DENY);
}

static void on_certificate_error(ICoreWebView2 *,
                                 ICoreWebView2ServerCertificateErrorDetectedEventArgs *a) {
  CoString uri;
  if (FAILED(a->get_RequestUri(uri.out()))) return;
  Origin o = origin_of(uri.p);
  if (o.scheme != L"https" || !is_loopback_host(o.host)) return;
  ICoreWebView2Certificate *cert = nullptr;
  if (FAILED(a->get_ServerCertificate(&cert)) || !cert) return;
  CoString pem;
  std::string spki;
  if (SUCCEEDED(cert->ToPemEncoding(pem.out()))) spki = spki_sha256_of_pem(pem.str());
  cert->Release();
  if (!spki.empty() && spki == g_trusted_spki) {
    a->put_Action(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW);
    return;
  }
  fprintf(stderr, "[yaar] refusing %s: its key is not the pinned one\n",
          narrow(uri.p).c_str());
}

// Take over what webview.h leaves at WebView2's defaults. `controller` is
// webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER).
//
//  - `binding_origin`: the only origin the top-level page may have (scheme://host:port) —
//    see on_navigation_starting. Null leaves top-level navigation alone.
//  - `downloads_dir`: where downloads go. WebView2 downloads through its own flyout
//    either way; null leaves its default folder (the user's Downloads).
//  - `trusted_spki`: base64(sha256(SPKI)) of the one certificate key a loopback HTTPS
//    server may present; null leaves TLS to the system trust store.
//
// Returns 0, or -1 when an event the gate depends on could not be subscribed — the caller
// should then not expose bindings, since nothing would keep another page from calling them.
EXTRAS_API int webview_extras_attach(void *controller_ptr, const char *binding_origin,
                                     const char *downloads_dir, const char *trusted_spki) {
  auto *controller = static_cast<ICoreWebView2Controller *>(controller_ptr);
  if (!controller || g_webview) return -1;
  ICoreWebView2 *wv = nullptr;
  if (FAILED(controller->get_CoreWebView2(&wv)) || !wv) return -1;
  g_webview = wv;

  if (binding_origin) {
    std::wstring o = widen(binding_origin);
    g_binding_origin = origin_of(o.c_str());
    if (!g_binding_origin.ok) return -1;
  }
  if (!subscribe<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2,
                 ICoreWebView2NavigationStartingEventArgs>(
          wv, &ICoreWebView2::add_NavigationStarting, on_navigation_starting)) {
    return -1;
  }
  subscribe<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2,
            ICoreWebView2NewWindowRequestedEventArgs>(
      wv, &ICoreWebView2::add_NewWindowRequested, on_new_window);
  subscribe<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2,
            ICoreWebView2PermissionRequestedEventArgs>(
      wv, &ICoreWebView2::add_PermissionRequested, on_permission);

  if (downloads_dir) {
    ICoreWebView2_13 *wv13 = nullptr;
    if (SUCCEEDED(wv->QueryInterface(__uuidof(ICoreWebView2_13), reinterpret_cast<void **>(&wv13)))) {
      ICoreWebView2Profile *profile = nullptr;
      if (SUCCEEDED(wv13->get_Profile(&profile)) && profile) {
        profile->put_DefaultDownloadFolderPath(widen(downloads_dir).c_str());
        profile->Release();
      }
      wv13->Release();
    }
  }

  if (trusted_spki) {
    g_trusted_spki = trusted_spki;
    ICoreWebView2_14 *wv14 = nullptr;
    if (FAILED(wv->QueryInterface(__uuidof(ICoreWebView2_14), reinterpret_cast<void **>(&wv14)))) {
      return -1;
    }
    bool ok = subscribe<ICoreWebView2ServerCertificateErrorDetectedEventHandler, ICoreWebView2,
                        ICoreWebView2ServerCertificateErrorDetectedEventArgs>(
        wv14, &ICoreWebView2_14::add_ServerCertificateErrorDetected, on_certificate_error);
    wv14->Release();
    if (!ok) return -1;
  }
  return 0;
}

// The page's close key. On macOS ⌘W belongs to the native window until it is handed to the
// page; on Windows WebView2 binds no close key at all, so Ctrl+W already reaches the page
// (the shell's own handler) and there is nothing to route. The name is still checked, so a
// caller gets the same answer on both platforms.
EXTRAS_API int webview_extras_route_close_key(const char *event_name) {
  if (!g_webview || !event_name || !*event_name) return -1;
  for (const char *c = event_name; *c; c++) {
    bool ok = (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') ||
              *c == ':' || *c == '_' || *c == '-';
    if (!ok) return -1;
  }
  return 0;
}

// Nothing to tell on Windows: no shell surface bounces for a finished download the way the
// Dock's Downloads stack does, and the page already says where the file went.
EXTRAS_API void webview_extras_note_download(const char *path) { (void)path; }

// ---- Clipboard and URLs, for binding handlers -------------------------------------------

// Another program can hold the clipboard open for a moment; retry briefly before giving up.
static bool open_clipboard() {
  for (int i = 0; i < 10; i++) {
    if (OpenClipboard(nullptr)) return true;
    Sleep(10);
  }
  return false;
}

// The clipboard's text as malloc'd UTF-8 (free with webview_extras_free), or null when it
// holds none.
EXTRAS_API char *webview_extras_clipboard_read_text(void) {
  if (!open_clipboard()) return nullptr;
  char *out = nullptr;
  if (HANDLE h = GetClipboardData(CF_UNICODETEXT)) {
    if (auto *w = static_cast<const wchar_t *>(GlobalLock(h))) {
      std::string s = narrow(w);
      GlobalUnlock(h);
      out = static_cast<char *>(malloc(s.size() + 1));
      if (out) memcpy(out, s.c_str(), s.size() + 1);
    }
  }
  CloseClipboard();
  return out;
}

// Replace the clipboard with `len` bytes of UTF-8 text. 0, or -1 on bad UTF-8 or a refusal.
EXTRAS_API int webview_extras_clipboard_write_text(const char *utf8, int len) {
  if (!utf8 || len < 0) return -1;
  std::wstring w;
  if (len > 0) {
    w = widen(utf8, len);
    if (w.empty()) return -1;  // not UTF-8
  }
  size_t bytes = (w.size() + 1) * sizeof(wchar_t);
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!mem) return -1;
  void *dst = GlobalLock(mem);
  memcpy(dst, w.c_str(), bytes);
  GlobalUnlock(mem);
  if (!open_clipboard()) {
    GlobalFree(mem);
    return -1;
  }
  EmptyClipboard();
  bool ok = SetClipboardData(CF_UNICODETEXT, mem) != nullptr;
  CloseClipboard();
  if (!ok) GlobalFree(mem);  // on success the clipboard owns it
  return ok ? 0 : -1;
}

EXTRAS_API void webview_extras_free(void *p) { free(p); }

// Open an http(s) or mailto: URL in the program that handles it. 0, or -1 when refused.
EXTRAS_API int webview_extras_open_external(const char *url) {
  if (!url) return -1;
  return open_external(widen(url).c_str()) ? 0 : -1;
}
