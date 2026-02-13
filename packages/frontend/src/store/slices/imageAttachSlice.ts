/**
 * Image attach slice - manages pasted/dropped image attachments.
 */
import type { SliceCreator, ImageAttachSlice } from '../types';

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
