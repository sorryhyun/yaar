/**
 * Drawing slice - manages drawing overlay state.
 */
import type { SliceCreator, DrawingSlice } from '../types'

export const createDrawingSlice: SliceCreator<DrawingSlice> = (set, get) => ({
  hasDrawing: false,
  canvasDataUrl: null,

  saveDrawing: (dataUrl) => set((state) => {
    state.hasDrawing = true
    state.canvasDataUrl = dataUrl
  }),

  clearDrawing: () => set((state) => {
    state.hasDrawing = false
    state.canvasDataUrl = null
  }),

  consumeDrawing: () => {
    const dataUrl = get().canvasDataUrl
    if (dataUrl) {
      set((state) => {
        state.hasDrawing = false
        state.canvasDataUrl = null
      })
    }
    return dataUrl
  },
})
