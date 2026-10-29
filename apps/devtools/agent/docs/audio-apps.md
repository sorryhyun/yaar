---
name: audio-apps
description: Read before tuning or debugging an app that makes sound — checking a mix you cannot hear, and when to ask the user to listen.
audience: agent
---

## Apps That Make Sound

You cannot hear the preview, and its `AudioContext` usually stays suspended without a user
gesture, so live meters read nothing. Check sound by **rendering it to a file and measuring the
file**:

1. Have the app render offline (`OfflineAudioContext`, or Tone's `Tone.Offline`) and save a WAV.
   An app that makes sound should own a render command, so the agent driving it can check its
   own work the same way. A preview saves to `yaar://apps/preview--{projectId}/storage/…`, or under
   `shared/preview--{projectId}/` through `sharedStorage`.
2. `inspect/audio` with `{ uri }`. It reports integrated / max short-term loudness (BS.1770
   LUFS) and loudness range, sample peak, RMS, crest factor, clipped samples, DC offset,
   leading/trailing silence, stereo correlation and side-to-mid, each band's share of the energy
   in dB (sub 20-60 Hz, bass, lowMid, mid, upperMid, presence, brilliance 6k+), spectral
   centroid, a loudness/peak timeline, and a tempo estimate (wrong, when wrong, by half or double
   time); the image is a waveform over a log-frequency spectrogram. Render one stem at a time
   (solo a track) to tell which voice owns a problem.
3. Change one thing, render again, `inspect/audio` with `{ uri: before, compareTo: after }`. The
   `delta` is the finding. A change that moved nothing is a wrong hypothesis, so drop it rather
   than stacking another change on top.

**Measure a voice, not the mix, when one sound is wrong.** Expose the engine through
`defineApp({ debug: () => ({ Tone, buildVoice, engine }) })` and drive it from `preview/eval` as
`__debug` (the `preview-debugging` topic). Don't re-implement the signal chain inside an eval to
measure it: that measures your copy, not the app.

**Live and offline can disagree.** A live analyser reads a short window at whatever moment you
sample it. The offline render is the reference. If the two differ by several dB, suspect the
live meter's windowing before the mix.

**Numbers are not taste.** Loudness, balance and clipping are facts. Whether a pad is "too
bright" or a kick "lands" is not. For a subjective call, render the candidates, play them for
the user (ask the monitor to open the preview or the files), and let the user pick. Don't spend
many render cycles chasing a target you made up.

**Binary assets:** a sample that decodes in storage but not in the bundle was usually corrupted
on the way in. `inspect/audio` names the byte size when it cannot decode, and a file about
twice its expected size went through a text read.
