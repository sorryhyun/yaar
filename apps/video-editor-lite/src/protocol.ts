import type { AppStateDefinition } from '@bundled/yaar';
import { ctl } from './protocol/controller';
import type { Composition } from './core/types';
import type { SceneProps } from './core/scene-registry';

export interface EditorControllerApi {
  getCurrentSource: () => {
    sourceKind: 'url' | 'file' | null;
    sourceValue: string;
    objectUrl: string | null;
  };
  getPlaybackState: () => {
    playing: boolean;
    paused: boolean;
    playbackRate: number;
    loopPreview: boolean;
  };
  getTimeline: () => { currentTime: number; duration: number };
  getTrimRange: () => { trimStart: number; trimEnd: number; selectedDuration: number };
  loadSource: (params: { url?: string; path?: string }) => { source: string };
  play: () => Promise<void>;
  pause: () => void;
  seek: (time: number) => { currentTime: number };
  setPlaybackRate: (rate: number) => { playbackRate: number };
  // Creator mode API
  createComposition: (params: {
    width?: number;
    height?: number;
    fps?: number;
    durationInFrames?: number;
  }) => { config: Composition['config'] };
  addScene: (params: {
    type: string;
    from?: number;
    durationInFrames?: number;
    props?: SceneProps;
    layerId?: string;
  }) => { sceneId: string };
  updateScene: (params: {
    id: string;
    from?: number;
    durationInFrames?: number;
    props?: SceneProps;
  }) => void;
  removeScene: (params: { id: string }) => void;
  reorderScenes: (params: { ids: string[] }) => void;
  getComposition: () => { composition: unknown };
  preview: () => void;
  exportVideo: () => Promise<void>;
  addLayer: (params: { name?: string; index?: number }) => { layerId: string; layerName: string };
  removeLayer: (params: { id: string }) => void;
  updateLayer: (params: { id: string; name?: string; visible?: boolean; locked?: boolean }) => void;
  reorderLayers: (params: { ids: string[] }) => void;
  selectLayer: (params: { id: string }) => void;
  moveSceneToLayer: (params: { sceneId: string; layerId: string }) => void;
  getLayers: () => {
    layers: Array<{
      id: string;
      name: string;
      visible: boolean;
      locked: boolean;
      sceneIds: string[];
    }>;
  };
}

/**
 * The state half of the protocol. Like the command maps in `protocol/`, these
 * reach the controller through `ctl()` rather than closing over it, so the map
 * stays a top-level `const` the extractor can read while the controller is
 * still supplied at mount time.
 */
export const editorState = {
  currentSource: {
    description: 'Current media source information.',
    get: () => ctl().getCurrentSource(),
  },
  playbackState: {
    description: 'Playback status including play/pause, loop preview, and rate.',
    get: () => ctl().getPlaybackState(),
  },
  timeline: {
    description: 'Current playback time and total duration in seconds.',
    get: () => ctl().getTimeline(),
  },
  trimRange: {
    description: 'Current trim in/out range and selected duration in seconds.',
    get: () => ctl().getTrimRange(),
  },
  composition: {
    description: 'Current composition state including config and scenes.',
    get: () => ctl().getComposition(),
  },
  layers: {
    description: 'All layers in the current composition with their scenes.',
    get: () => ctl().getLayers(),
  },
} satisfies Record<string, AppStateDefinition>;
