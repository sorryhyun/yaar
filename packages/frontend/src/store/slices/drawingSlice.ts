/**
 * Drawing slice - manages drawing overlay state.
 */
import type { SliceCreator } from '../types';

export interface DrawingSliceState {
  hasDrawing: boolean;
  canvasDataUrl: string | null;
  pencilMode: boolean;
}

export interface DrawingSliceActions {
  saveDrawing: (dataUrl: string) => void;
  clearDrawing: () => void;
  consumeDrawing: () => string | null;
  togglePencilMode: () => void;
  setPencilMode: (active: boolean) => void;
}

export type DrawingSlice = DrawingSliceState & DrawingSliceActions;

export const createDrawingSlice: SliceCreator<DrawingSlice> = (set, get) => ({
  hasDrawing: false,
  canvasDataUrl: null,
  pencilMode: false,

  saveDrawing: (dataUrl) =>
    set((state) => {
      state.hasDrawing = true;
      state.canvasDataUrl = dataUrl;
    }),

  clearDrawing: () =>
    set((state) => {
      state.hasDrawing = false;
      state.canvasDataUrl = null;
    }),

  consumeDrawing: () => {
    const dataUrl = get().canvasDataUrl;
    if (dataUrl) {
      set((state) => {
        state.hasDrawing = false;
        state.canvasDataUrl = null;
      });
    }
    return dataUrl;
  },

  togglePencilMode: () =>
    set((state) => {
      state.pencilMode = !state.pencilMode;
    }),

  setPencilMode: (active) =>
    set((state) => {
      state.pencilMode = active;
    }),
});
