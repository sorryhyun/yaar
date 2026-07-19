import { app } from '@bundled/yaar';
import { setController } from './protocol/controller';
import { compositionCommands } from './protocol/composition';
import { layerCommands } from './protocol/layers';
import { outputCommands } from './protocol/output';
import { sourceCommands } from './protocol/source';
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

export function registerProtocol(controller: EditorControllerApi): void {
  setController(controller);
  if (!app || typeof app.register !== 'function') return;

  app.register({
    appId: 'video-editor-lite',
    name: 'Video Editor Lite',
    state: {
      currentSource: {
        description: 'Current media source information.',
        handler: () => controller.getCurrentSource(),
      },
      playbackState: {
        description: 'Playback status including play/pause, loop preview, and rate.',
        handler: () => controller.getPlaybackState(),
      },
      timeline: {
        description: 'Current playback time and total duration in seconds.',
        handler: () => controller.getTimeline(),
      },
      trimRange: {
        description: 'Current trim in/out range and selected duration in seconds.',
        handler: () => controller.getTrimRange(),
      },
      composition: {
        description: 'Current composition state including config and scenes.',
        handler: () => controller.getComposition(),
      },
      layers: {
        description: 'All layers in the current composition with their scenes.',
        handler: () => controller.getLayers(),
      },
    },
    commands: {
      ...sourceCommands,
      ...compositionCommands,
      ...outputCommands,
      ...layerCommands,
    },
  });
}
