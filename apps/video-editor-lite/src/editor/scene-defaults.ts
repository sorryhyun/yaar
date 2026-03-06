import { v4 as uuid } from '@bundled/uuid';
import type { SceneProps } from '../core/scene-registry';

export function nextSceneId(): string {
  return uuid();
}

export function getDefaultPropsForType(type: string): SceneProps {
  switch (type) {
    case 'solid':
      return { color: '#1a1a2e' };
    case 'text':
      return { text: 'Hello World', fontSize: 64, color: '#ffffff', animation: 'fadeIn' };
    case 'shape':
      return { shape: 'rect', x: 200, y: 200, width: 200, height: 150, color: '#3498db' };
    case 'image':
      return { src: '' };
    case 'video-clip':
      return { src: '' };
    default:
      return {};
  }
}
