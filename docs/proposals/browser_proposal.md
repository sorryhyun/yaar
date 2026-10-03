# Proposal: live browser — a video codec for the screencast, and HiDPI frames

> **Status:** proposed (2026-09-30). Measured on macOS and Linux (bench committed); Phase 0 and
> the model-screenshot fix built. Replaces the per-frame JPEG stream with a WebCodecs video stream
> encoded inside the server's own headless Chrome. Issue #148 (live frames are soft on HiDPI
> displays) waits for that stream: live mode stays at 1x until the video path ships.

## Why

The live mode of the `browser` app streams CDP `Page.screencastFrame` JPEGs down a WebSocket
(`websocket/screencast-handlers.ts`, painted by `apps/browser/src/live/paint.ts`). Every frame
is a complete image, so any change re-sends the whole viewport. When the page holds still that
costs nothing, because Chrome emits no frames. When anything moves it costs the most it can:

- A real-site scroll at 60 fps was observed at **~23 Mbps** on the `high` preset.
- The bench below (a text-dense page, 1280×800) reaches **77 Mbps** as JPEG q80.

The 2026-08 spike put the frame rate at ~23 fps and called bandwidth "the remote risk", leaving
open "the only thing that could still argue for a real codec". Chrome now delivers 60 fps, which
roughly triples that exposure. The numbers below settle the question.

The second problem is sharpness. On a Retina display the canvas shows 1280 CSS px as 1280 image
px, so live mode looks soft next to a normal screenshot (#148). The fix the issue suggests does
not work (next section), and the fix that does work quadruples the pixels. That is affordable
with a video codec and not with JPEG. This is why the two are one proposal.

## Findings (headless Chrome 154, macOS, 2026-09-30)

### An emulated device scale factor never enlarges screencast frames

| Chrome setup | page `devicePixelRatio` | `captureScreenshot` | screencast frame |
|---|---|---|---|
| `setDeviceMetricsOverride` DSF 2 | 2 | 2560×1600 | **1280×800** |
| same, with `maxWidth`/`maxHeight` 4096 | 2 | 2560×1600 | **1280×800** |
| launched with `--force-device-scale-factor=2`, emulated DSF 2 | 2 | 2560×1600 | **2560×1600** |
| `--force-device-scale-factor=2`, emulated DSF 1 | 1 | 1280×800 | 2560×1600, upscaled from 1x |

Frame *size* follows the process's real scale factor, and *sharpness* follows the emulated one.
Frame metadata (`deviceWidth`/`deviceHeight`) stays in CSS px in every case. That means the app's
input mapping (`toRemote`, `setRemoteSize`) is already correct for larger frames.

So #148's suggested fix, forwarding `devicePixelRatio` into `Emulation.setDeviceMetricsOverride`,
would ship a no-op. HiDPI needs the launch flag. The flag is process-wide, so every tab in the
server's Chrome renders at the larger backing size.

### A video codec is ~20x smaller than JPEG at 1x, ~8x at 2x

Every number below comes from `scripts/bench/screencast-codec.ts` (`make screencast-bench`).

Setup:
- A 4 s trackpad-like scroll at a 1280×800 CSS viewport: one 30 CSS px wheel event every ~16 ms,
  down and then back up.
- The reference is a lossless PNG screencast of the same scroll. PSNR is luma, measured against
  that reference.
- Encoders are WebCodecs `VideoEncoder` running in a page of the same headless Chrome. Frames are
  fed at their recorded timestamps, with `latencyMode: 'realtime'`, after one discarded warm-up
  session.
- The "bitrate" column is what the encoder actually produced. The configured target is in the
  row label.

**1x** (1280×800 frames, 60 fps captured):

| Stream | Bitrate | PSNR mean (min) | Encode latency p50 / p95 |
|---|---|---|---|
| JPEG q80 (today's `high`) | 77 Mbps | 38.1 (37.2) | — |
| JPEG q45 (today's `medium`) | 50 Mbps | 31.2 (30.3) | — |
| H.264, hardware (VideoToolbox), target 2 Mbps | 2.0 Mbps | 37.9 (31.3) | 12 / 16 ms |
| **H.264, hardware, target 4 Mbps** | **3.7 Mbps** | **48.0 (39.7)** | **13 / 17 ms** |
| H.264, hardware, target 8 Mbps | 4.4 Mbps | 52.0 (43.6) | 13 / 17 ms |
| H.264, software (OpenH264), target 2–8 Mbps | 4.0–6.5 Mbps | 28–40 (26.7) | 4 / 8 ms |
| VP9, software, target 8 Mbps | 7.8 Mbps | 50.0 (33.6) | 5 / 7 ms |

**2x** (`--force-dsf 2`: 2560×1600 frames; Chrome captured only **45 fps**):

| Stream | Bitrate | PSNR mean (min) |
|---|---|---|
| JPEG q80 | 151 Mbps | 40.1 (39.2) |
| H.264, hardware, target 8 Mbps | 6.0 Mbps | 29.0 (27.1) |
| H.264, hardware, target 16 Mbps | 12.6 Mbps | 37.0 (28.6) |
| **H.264, hardware, target 24 Mbps** | **19.1 Mbps** | **42.0 (24.8)** |
| H.264 software / VP9 software, any target | 18–28 Mbps | 27–30 |
| *slower scroll (`--delta 10`)*: H.264 hardware, target 8 Mbps | 3.2 Mbps | 51.5 (36.1) |
| *slower scroll*: H.264 hardware, target 4 Mbps | 2.9 Mbps | 30.0 (27.9) |

What the tables say:

- **Hardware H.264 is the codec to use.** At 1x it carries ~20x less than today's `high` preset
  and looks better than it. At 2x on a fast fling it still carries ~8x less than JPEG at 2x.
- **The bitrate target is a ceiling, and setting it too low is a cliff, not a slope.** Below what
  the motion needs, quality does not degrade gently. It collapses to ~30 dB and stays there, with
  blurred text; a gain/offset fit ruled out a color-range artifact. In the same slow 2x scroll,
  target 8 Mbps used 3.2 Mbps at 51.5 dB, while target 4 Mbps used 2.9 Mbps at 30 dB. VBR spends
  less than a generous ceiling whenever the content allows, so the ceiling should be set high.
- **What fixes a slow link is fewer frames, not a lower target.** See the backpressure design
  below.
- **The cost scales with motion in device px.** The same fling moves twice as many device px per
  frame at 2x, and the hardware encoder needs ~5x the bits there (19 Mbps against 3.7).
- **Software encoders are 1x-only.** OpenH264 ignores its target and mostly sits near 28 dB even
  at 1x. VP9 software is a usable 1x fallback at an 8 Mbps target and collapses at 2x.
- **At 2x, Chrome's capture is the bottleneck, not the encoder.** The screencast delivered 45 fps
  at 2560×1600, as PNG. Unpaced, the encoder page ran ~91 fps at 2x and ~97 fps at 1x, including
  bitmap → `VideoFrame`. The capture rate for JPEG at 2x, which is what live mode actually
  requests, is not measured.
- **Resolved:** a 0.5–1.3 s latency spike from an earlier run was hardware encoder start-up. With
  a discarded warm-up session it does not recur. The encoder tab warms up on creation (below).

Not yet measured: phone-side decode, JPEG capture at 2x, and Android Chrome.

### Linux has no hardware encoder; AV1 software with `contentHint: 'text'` beats it anyway

Headless Chrome 151 on Linux with an NVIDIA RTX 5070 Ti, 2026-10-03. Chrome on Linux encodes in
hardware only through VAAPI, and NVIDIA's driver offers no VAAPI encode. `isConfigSupported`
answers `false` for every `prefer-hardware` codec (H.264, VP8, VP9, AV1, HEVC), with the default
SwiftShader GPU and with ANGLE on the real GPU (`--use-angle=vulkan`, `gl-egl`, the VAAPI feature
flags). Software H.264 and AV1 are available.

The 4 s bench scroll at 1x, 60 fps captured:

| Stream | Bitrate | PSNR mean (min) | Encode latency p50 / p95 |
|---|---|---|---|
| JPEG q80 (today's `high`) | 80 Mbps | 38.1 (37.2) | — |
| H.264 software (OpenH264), target 2–8 Mbps | 4.8–7.7 Mbps | 27–35 (25.5) | 2 / 3 ms |
| VP9 software, target 4 Mbps | 5.2 Mbps | 33.6 (25.2) | 3 / 8 ms |
| VP9 software, target 4 Mbps, `contentHint: 'text'` | 4.1 Mbps | 45.4 (37.3) | 5 / 8 ms |
| AV1 software, target 4 Mbps | 4.7 Mbps | 27.8 (24.0) | 4 / 6 ms |
| AV1 software, target 2 Mbps, `contentHint: 'text'` | 1.2 Mbps | 45.2 (40.4) | 3 / 4 ms |
| **AV1 software, target 4 Mbps, `contentHint: 'text'`** | **1.4 Mbps** | **46.2 (41.7)** | **3 / 4 ms** |

The same scroll on a real page (`en.wikipedia.org/wiki/Web_browser`), target 4 Mbps:

| Stream | Bitrate | PSNR mean (min) |
|---|---|---|
| JPEG q80 | 82 Mbps | 37.8 (37.0) |
| VP9 software, `contentHint: 'text'` | 4.1 Mbps | 40.1 (33.4) |
| **AV1 software, `contentHint: 'text'`** | **3.1 Mbps** | **44.6 (40.6)** |

- **`contentHint: 'text'` is the lever, not the codec.** It switches libaom (and libvpx) to its
  screen-content tools. Without it, AV1 sits on the same ~27 dB floor as OpenH264.
- **AV1 software with the hint is the best stream measured anywhere**, including macOS hardware
  H.264 (3.7 Mbps at 48 dB on the synthetic page). It is ~26x smaller than `high` on a real page
  and looks better. It encodes in 3 ms per frame and keeps up with 60 fps.
- **Not measured:** whether hardware H.264 on macOS gains from the hint, AV1 at 2x, and the encoder's
  CPU share over a long session. Decode is not a concern in Chrome, which ships dav1d everywhere.

## Design

### 1. The encoder lives in a background tab of the server's Chrome

This follows the pattern the ML host already set (`features/ml-host/relay.ts`): the server opens
a headless tab on a page it serves, the page dials back over a WebSocket, and the server relays
binary frames without parsing them.

```
site tab ──CDP screencastFrame (JPEG)──▶ server ──▶ encoder tab (WebCodecs VideoEncoder)
                                                          │ EncodedVideoChunk
viewer canvas ◀── VideoDecoder ◀── screencast socket ◀── server
```

- **Why not ffmpeg:** it would be a new dependency, and it is absent from this machine and from
  every bundled target. The encoder in Chrome gets VideoToolbox for free where it exists.
- **Scope:** one encoder per screencasting *session*, not per viewer, which matches the existing
  refcounted `startScreencast`. A viewer joining, a tab switch (`switchTab`) or a resize forces a
  keyframe. A size change reconfigures the encoder.
- **Compositing:** the encoder tab must never be activated. Chrome composites only the frontmost
  target (`apps/browser/src/live/fallback.ts`), and the handlers already call `bringToFront` on
  the viewed tab. The encoder must therefore be opened in the background. The ML host's tabs set
  the precedent here.
- **Warm-up:** the encoder tab runs one throwaway encode on creation, because the first hardware
  session pays start-up latency.
- **Throttling:** the encoder page is driven by WebSocket `message` events, not timers, so
  background-tab timer throttling should not reach it. That is unverified (see
  [Open questions](#open-questions)).

The JPEG round trip through the encoder costs a decode per frame and some quality. Removing it
needs capture inside Chrome (`getDisplayMedia` with auto-accept flags, or `tabCapture`, which
needs an extension that YAAR's `--disable-extensions` rules out). That is a research track, not
part of this plan.

### 2. Negotiation and fallback

- **The client says what it can decode.** On connect, the app probes
  `VideoDecoder.isConfigSupported` for `avc1` and `vp09` and passes the result on the upgrade
  (`?codecs=avc1,vp09`).
- **The encoder page says what it can encode**, preferring AV1 software with
  `contentHint: 'text'`, then hardware H.264, then VP9 software with the hint. It rejects OpenH264
  outright: a `prefer-software` `avc1` configuration is never used. The order between AV1 and
  hardware H.264 is to be confirmed on macOS with the hint set on both.
- **The server picks the first codec both ends support**, and otherwise stays on JPEG. The JPEG
  path is the permanent fallback, not a transition shim.
- **The receiving side's secure context is not a concern.** The server listens on loopback only,
  and remote access is Tailscale Serve over https, so the app iframe always has WebCodecs.

### 3. Wire format

The frame envelope stays as it is: `[uint32 LE headerLen][JSON header][payload]`. Only the
header gains fields.

- `codec` (`'jpeg' | 'avc1' | 'vp09'`)
- `key` (keyframe)
- `ts` (µs)
- `cw`/`ch` (coded size, next to the CSS-px `w`/`h`)

Also:
- The codec string and decoder config travel once per (re)configuration as a text frame
  `{t:'codec', …}`. H.264 is sent as Annex B, so no `description` blob is needed.
- The client decodes with `VideoDecoder` and paints each `VideoFrame` onto the existing canvas.
  `paint.ts` keeps sizing the backing store to the decoded frame.
- A decode error sends `{t:'keyframe'}` up. A second error in a row sends `{t:'codec', codec:'jpeg'}`
  and the viewer stays on JPEG for that socket.

### 4. Backpressure moves in front of the encoder

Today the socket drops a JPEG when more than 256 KB is unsent (`MAX_BUFFERED_BYTES`). Dropping a
P-frame instead would corrupt every frame until the next keyframe. So the drop moves one step
earlier:

- While the viewer's socket is over budget, screencast frames are **not fed to the encoder**.
  The encoder then simply sees a lower frame rate.
- After a long stall the next frame is forced as a keyframe.
- The byte budget shrinks with the stream. At ~8–16 KB per frame, "two frames in flight" is
  about 32 KB, not 256 KB.
- **The bitrate target is never the lever for a slow link.** Lowering it falls off the quality
  cliff measured above. The target stays a generous ceiling: about 8 Mbps at 1x and 24 Mbps at
  2x, to be retuned on real sites. A slow link loses frame rate first and DPR second.

### 5. HiDPI (#148)

- **Launch Chrome with `--force-device-scale-factor=2`** (`lib/browser/chrome.ts`). A phone at
  DPR 3 gets 2x; the gain beyond that is not worth 2.25x the pixels.
- **The screencast upgrade accepts `?dpr=`**, clamped to 1–2 in `clampedStreamParams`, and so does
  the `viewport` message, so a window moved between displays can re-announce its DPR. The viewer's
  DPR becomes the session's emulated DSF while that viewer is attached.
- **`setViewport(w, h)` preserves the current DSF instead of defaulting to 1.** One live-mode
  resize used to silently drop a mobile session from DSF 3 to 1. Fixed in Phase 0.
- **1x viewers are capped, not upscaled.** A viewer at DPR 1, and every JPEG viewer, gets
  `maxWidth` equal to its CSS width. Under the flag, an emulated-1x tab still produces 2x frames
  that are merely upscaled, which quadruples the bytes for nothing.
- **Model-bound screenshots are normalized to CSS px.** Agents click in CSS px
  (`Input.dispatchMouseEvent`), and a device-px capture capped only at a 1568 long edge put every
  click read off it the scale factor off. Done ahead of the rest (see the plan).

## Plan

**Phase 0 — cheap fixes on the JPEG path** (done, 2026-09-30)
- ~~Make `setViewport` preserve DSF~~: it keeps the session's scale factor unless one is passed.
- ~~Pause the stream while the window is hidden~~. A `visibilitychange` handler alone would not
  have done it: a minimized window, or one on another monitor, stays mounted under
  `visibility: hidden`, and a frame's `document.visibilityState` follows only the top-level page.
  So the desktop now reports per-window `visible` on `yaar.device` (not minimized, on the active
  monitor), and the SDK folds in the page's own `visibilitychange`. The app sends `pause`/`resume`
  on the open socket: the server releases its share of the screencast refcount while the socket,
  the popup tab strip and the counters stay up, and a resume answers with `ready`, so the canvas
  reseeds and the viewport resyncs. A connect asked for while hidden is deferred until the window
  is shown. The detach log reports `pausedSeconds`, and `fps`/`kbps` cover streaming time only.
  Not counted as hidden: a phone card covered by another card, which is still on the active
  monitor.
- ~~Commit the bench~~: done, as `scripts/bench/screencast-codec.ts` (`make screencast-bench`).

**Model-screenshot normalization** (done, 2026-10-03)
- `downscaleForModel` sizes an agent screenshot to the CSS viewport before the long-edge cap. The
  width comes from the emulated viewport, or `Page.getLayoutMetrics` for an adopted tab. It fixed
  mobile sessions (DSF 3), whose 390×844 viewport reached the model as 724×1568.
- The Browser app's `?fresh` still comes from `captureStill()` instead and keeps device px.

**Phase 1 — the WebCodecs video path, at 1x**

The HiDPI plumbing that was Phase 1 moves after it. The launch flag is process-wide, so it would
cost every tab in the server's Chrome, the companion desktop and ML host included, while JPEG
viewers stayed at 1x and gained nothing. Software encoders are also the only ones on Linux, and
the 2x data so far says software stays at 1x.

- Build the encoder tab and its relay, codec negotiation, the wire-format fields, the client
  decoder, backpressure in front of the encoder, and fallback to JPEG.
- Keep the per-viewer counters (`fps`, `kbps`, `dropped`), add `codec`, and log them per detach
  as today.
- Verification: the scroll from the bench, driven live in the app, runs at ≤ 5 Mbps at 1x with no
  visible text blur. A forced decoder failure lands on JPEG without a dead canvas.

**Phase 2 — HiDPI for video viewers (#148)**
- Launch flag, `dpr` negotiation, and 1x capping for JPEG and DPR-1 viewers (section 5).
- Measure AV1 software with the hint at 2x first. If it does not hold up, HiDPI is limited to
  hosts with a hardware encoder.
- Video viewers get their DPR (up to 2). JPEG viewers stay at 1x.
- The quality presets become frame-rate and DPR caps for the video path, not bitrate targets
  (see the cliff above). JPEG quality applies to the fallback only.
- Verification: record the capture frame rate at 2560×1600 with JPEG capture (45 fps as PNG), and
  the real-site bitrate of a fast fling at 2x against the ~19 Mbps measured on the synthetic page.

## Open questions

1. **Termux and Android encoders.** Linux is answered: no hardware encoder, and AV1 software with
   the hint is the codec. Android still needs measuring, along with the encoder's CPU cost on a
   phone at 1280×800 and 60 fps.
2. ~~**The 2 Mbps hardware latency spike.**~~ Resolved: encoder start-up, handled by warming
   the encoder up.
3. **A background encoder tab.** Confirm that it neither throttles nor steals compositing from the
   viewed tab while the companion desktop and ML host tabs are open in the same Chrome.
4. **Frame rate at 2x.** The encoder keeps up (~91 fps unpaced), but Chrome captured only 45 fps
   at 2560×1600 as PNG. If JPEG capture is no faster, choose between 45 fps at 2x and 60 fps at
   1.5x.
5. **Multiple viewers.** One encoder at the first viewer's bitrate matches today's rule. The first
   viewer on a slower link should set the rate, not the first to join.
6. **Capture without the JPEG hop.** Does `getDisplayMedia` work in `--headless=new` with
   auto-accept flags? If so, the encode path skips a lossy decode and the CDP ack loop entirely.
