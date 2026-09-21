/**
 * Image attach slice - manages pasted/dropped image attachments.
 */
import type { SliceCreator } from '../types';

export interface ImageAttachSliceState {
  attachedImages: string[];
}

export interface ImageAttachSliceActions {
  addAttachedImages: (images: string[]) => void;
  removeAttachedImage: (index: number) => void;
  clearAttachedImages: () => void;
  consumeAttachedImages: () => string[];
}

export type ImageAttachSlice = ImageAttachSliceState & ImageAttachSliceActions;

export const createImageAttachSlice: SliceCreator<ImageAttachSlice> = (set, get) => ({
  attachedImages: [],

  addAttachedImages: (images) =>
    set((state) => {
      state.attachedImages.push(...images);
    }),

  removeAttachedImage: (index) =>
    set((state) => {
      state.attachedImages.splice(index, 1);
    }),

  clearAttachedImages: () =>
    set((state) => {
      state.attachedImages = [];
    }),

  consumeAttachedImages: () => {
    const images = [...get().attachedImages];
    if (images.length > 0) {
      set((state) => {
        state.attachedImages = [];
      });
    }
    return images;
  },
});
