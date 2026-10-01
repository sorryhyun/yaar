// Commands call the same actions the UI does.
import { defineAppCommand } from '@bundled/yaar';
import * as z from '@bundled/zod';
import {
  deleteCapture,
  refreshCaptures,
  startCamera,
  startRecording,
  stopCamera,
  stopRecording,
  takePhoto,
} from './actions';
import { captures, facing, lastError, recProgress, recording, stream, withAudio } from './store';

export const appState = {
  status: {
    description:
      'Camera on/off, which camera (facing), whether audio is captured, the recording in progress ' +
      '(path, bytes on the server, durationMs) or null, and the last error.',
    get: () => {
      const rec = recording();
      return {
        cameraOn: stream() !== null,
        facing: facing(),
        audio: withAudio(),
        recording: rec ? { path: rec.path, mimeType: rec.mimeType, ...recProgress() } : null,
        lastError: lastError() || null,
      };
    },
  },
  captures: {
    description:
      "Photos and videos taken, newest first: { path, kind, size }. Paths are relative to this app's storage (yaar://apps/camera/storage/{path}).",
    get: () => captures(),
  },
};

export const appCommands = {
  openCamera: defineAppCommand({
    description:
      "Turn the camera on. facing 'environment' is the back camera, 'user' the front. The first time, the browser or Android asks the user.",
    params: z.object({
      facing: z.optional(z.enum(['user', 'environment'])),
    }),
    run: async (p) => {
      await startCamera(p.facing);
      return { cameraOn: true, facing: facing() };
    },
  }),

  closeCamera: defineAppCommand({
    description: 'Turn the camera off (stops a recording in progress first, keeping the file).',
    params: z.object({}),
    run: async () => {
      await stopCamera();
      return { cameraOn: false };
    },
  }),

  takePhoto: defineAppCommand({
    description: 'Save one JPEG frame from the open camera. Resolves with the saved capture.',
    params: z.object({}),
    run: async () => takePhoto(),
  }),

  startRecording: defineAppCommand({
    description:
      'Start recording the open camera into storage. Chunks are uploaded every 2s while it runs.',
    params: z.object({}),
    run: async () => startRecording(),
  }),

  stopRecording: defineAppCommand({
    description:
      'Stop the recording and wait for the last chunk to land. Resolves with { path, bytes, durationMs, mimeType }.',
    params: z.object({}),
    run: async () => stopRecording(),
  }),

  deleteCapture: defineAppCommand({
    description: 'Delete one capture by its path (as listed in the captures state).',
    params: z.object({ path: z.string() }),
    run: async (p) => {
      await deleteCapture(p.path);
      return { deleted: p.path };
    },
  }),

  refresh: defineAppCommand({
    description: 'Re-read the capture list from storage.',
    params: z.object({}),
    run: async () => refreshCaptures(),
  }),
};
