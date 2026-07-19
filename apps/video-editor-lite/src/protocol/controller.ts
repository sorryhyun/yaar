import { createProtocolContext } from '@bundled/yaar';
import type { EditorControllerApi } from '../protocol';

/**
 * The protocol extractor reads command descriptors out of the source text, so
 * the descriptor maps in `src/protocol/*.ts` have to stay top-level `const`s —
 * they cannot close over a parameter or be produced by a factory. The
 * controller, however, only exists once the editor has mounted. This holder is
 * the seam: descriptors stay static, `setController()` supplies the controller
 * at registration time, and handlers reach it through `ctl()`.
 */
export const { set: setController, get: ctl } =
  createProtocolContext<EditorControllerApi>('video-editor-lite');
