/**
 * Entrypoint — the stage with a sidebar overlaying each edge, and the protocol
 * registration.
 *
 * Everything else has moved out: the starter content to `starter.ts`, the imperative
 * work to `stage.ts`, the view state to `ui/state.ts`, the sidebars to `ui/library.ts`
 * (left: rooms + the whole character library) and `ui/participants.ts` (right: who is in
 * the open room), the transcript to `ui/room.ts`, and the protocol descriptors to
 * `protocol.ts`. What is left is the shape of the app on screen and the shape of it to
 * an agent.
 *
 * Neither sidebar takes layout space until it is pinned: they sit in zero-width grid
 * columns and float over the stage on hover, so the transcript is full width by default.
 * Pinning widens that column, and the room reflows into what is left.
 *
 * The memo stays here rather than in `ui/state.ts` because a `createMemo` needs a
 * reactive owner, and `App` is the only place in this app that has one. It is handed to
 * the two fragments that read it.
 */

import { createMemo, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';

import { live } from './agents';
import { boot } from './stage';
import { charactersSidebar } from './ui/library';
import { participantsSidebar } from './ui/participants';
import { topbar } from './ui/topbar';
import { roomPane } from './ui/room';
import { charactersPinned, participantsPinned } from './ui/panels';
import { appState, roomCommands, personaCommands } from './protocol';
import './styles.css';

function App() {
  const onstageCount = createMemo(() => Object.keys(live()).length);

  onMount(boot);

  // The three columns are inserted without a reactive wrapper on purpose. Which of them
  // is shown never changes — only how wide they are — so `${() => …}` would buy nothing
  // and would put marker nodes between the children of a CSS grid.
  return html`
    <div
      class="y-app cc-root"
      classList=${() => ({
        'left-pinned': charactersPinned(),
        'right-pinned': participantsPinned(),
      })}
    >
      ${charactersSidebar()}
      <div class="cc-stage">${topbar({ onstageCount })} ${roomPane()}</div>
      ${participantsSidebar({ onstageCount })}
    </div>
  `;
}

export default defineApp({
  id: 'chitchats',
  name: 'ChitChats',
  state: { ...appState },
  commands: { ...roomCommands, ...personaCommands },
  view: App,
});
