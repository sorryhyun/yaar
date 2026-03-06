import type { EditorUI } from './ui';
import type { EditorStore } from './state';
import type { Composition } from '../core/types';
import { DEFAULT_CONFIG, makeDefaultLayer } from '../core/types';
import { createScene } from '../core/scene-registry';
import type { SceneProps } from '../core/scene-registry';
import { PreviewPlayer } from '../player/preview-player';
import { exportComposition, downloadBlob } from '../player/exporter';
import { makeExportFilename } from './export-utils';
import { nextSceneId, getDefaultPropsForType } from './scene-defaults';

export interface CreatorMode {
  ensureComposition(): Composition;
  syncPlayerToComposition(): void;
  addSceneToComposition(type: string, from?: number, durationInFrames?: number, props?: SceneProps): string;
  handleCreatorPlayPause(): void;
  handleCreatorExport(): Promise<void>;
  getPreviewPlayer(): PreviewPlayer | null;
  destroy(): void;
}

export function createCreatorMode(ui: EditorUI, store: EditorStore): CreatorMode {
  let previewPlayer: PreviewPlayer | null = null;
  let exportingInProgress = false;

  const ensureComposition = (): Composition => {
    const state = store.getState();
    if (state.composition) return state.composition;
    const defaultLayer = makeDefaultLayer('Layer 1');
    const comp: Composition = { config: { ...DEFAULT_CONFIG }, layers: [defaultLayer] };
    store.setComposition(comp);
    return comp;
  };

  const syncPlayerToComposition = (): void => {
    const state = store.getState();
    if (!state.composition) return;

    if (previewPlayer) {
      previewPlayer.setComposition(state.composition);
    } else {
      previewPlayer = new PreviewPlayer(ui.compositionCanvas, state.composition);
      previewPlayer.setOnFrameChange((frame) => {
        store.setCreatorFrame(frame);
      });
    }

    previewPlayer.seek(state.creatorFrame);
  };

  const addSceneToComposition = (
    type: string,
    from?: number,
    durationInFrames?: number,
    props?: SceneProps,
  ): string => {
    const comp = ensureComposition();
    const id = nextSceneId();
    const sceneFrom = from ?? 0;
    const sceneDur = durationInFrames ?? Math.min(comp.config.durationInFrames, 90);
    const sceneProps = props ?? getDefaultPropsForType(type);
    const scene = createScene(type, id, sceneFrom, sceneDur, sceneProps);
    store.addScene(scene);
    syncPlayerToComposition();
    return id;
  };

  const handleCreatorPlayPause = (): void => {
    if (!previewPlayer) {
      syncPlayerToComposition();
      if (!previewPlayer) return;
    }

    if (previewPlayer.getState() === 'playing') {
      previewPlayer.pause();
      store.setCreatorPlaying(false);
    } else {
      previewPlayer.play();
      store.setCreatorPlaying(true);
    }
  };

  const handleCreatorExport = async (): Promise<void> => {
    const state = store.getState();
    if (!state.composition || exportingInProgress) return;

    exportingInProgress = true;
    store.setExportState({ exporting: true, exportProgress: 0, exportMessage: 'Exporting composition...' });

    try {
      const blob = await exportComposition(state.composition, (p) => {
        store.setExportState({
          exportProgress: p.percent,
          exportMessage: `Exporting ${Math.round(p.percent * 100)}% (frame ${p.frame}/${p.totalFrames})`,
        });
      });

      downloadBlob(blob, makeExportFilename('webm', 'composition'));
      store.setExportState({
        exporting: false,
        exportProgress: 1,
        exportMessage: 'Export complete!',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error.';
      store.setExportState({
        exporting: false,
        exportProgress: 0,
        exportMessage: `Export failed: ${message}`,
      });
    } finally {
      exportingInProgress = false;
    }
  };

  return {
    ensureComposition,
    syncPlayerToComposition,
    addSceneToComposition,
    handleCreatorPlayPause,
    handleCreatorExport,
    getPreviewPlayer: () => previewPlayer,
    destroy: () => {
      previewPlayer?.destroy();
      previewPlayer = null;
    },
  };
}
