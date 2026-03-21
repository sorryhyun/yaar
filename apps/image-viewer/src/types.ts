export type ImageItem = {
  id: number;
  name: string;
  source: string;
  path?: string;
};

export type LayoutMode = 'single' | 'grid';

/** Raw image input accepted by protocol commands */
export type RawImageInput = {
  name?: string;
  path?: string;
  url?: string;
  dataUrl?: string;
};
