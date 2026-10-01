# Camera — photos and video into storage

A test app for camera capture. The window shows a live preview; photos and recordings are saved
under `captures/` in this app's storage (`yaar://apps/camera/storage/captures/`), where any agent
can `list` and `read` them.

## Flow

1. `openCamera` (optionally `facing: 'user'` for the front camera). The first time, the browser
   or the Android app asks the user; a denial fails the command with the reason.
2. `takePhoto` saves one JPEG frame. `startRecording` / `stopRecording` record a clip —
   `stopRecording` resolves once the last chunk is on the server, with the final path.
3. `closeCamera` when done, so the camera light goes off.

## Limits

- The camera belongs to the device showing the window. Needs a secure context: `localhost`,
  `127.0.0.1` or https — a phone reaching YAAR over a LAN IP has no camera access.
- Android stops the camera when YAAR goes to the background or the screen turns off; a
  recording ends there, keeping what was uploaded.
- Videos are WebM (MP4 only where WebM cannot be recorded). MediaRecorder's WebM has no duration
  header, so a player may show the length as unknown.
