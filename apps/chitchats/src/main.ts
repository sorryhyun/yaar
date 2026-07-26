/**
 * Entrypoint — the two-column layout, and the protocol registration.
 *
 * Everything else has moved out: the starter content to `starter.ts`, the imperative
 * work to `stage.ts`, the view state to `ui/state.ts`, the two columns to `ui/sidebar.ts`
 * and `ui/room.ts`, and the protocol descriptors to `protocol.ts`. What is left is the
 * shape of the app on screen and the shape of it to an agent.
 *
 * The two memos stay here rather than in `ui/state.ts` because a `createMemo` needs a
 * reactive owner, and `App` is the only place in this app that has one. They are handed
 * to the sidebar, which is the only fragment that reads them.
 */

import { createMemo, onMount } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';

import { cast, openRoom } from './store';
import { live } from './agents';
import { boot } from './stage';
import { sidebar } from './ui/sidebar';
import { roomPane } from './ui/room';
import { appState, roomCommands, personaCommands } from './protocol';
import './styles.css';

function App() {
  const onstageCount = createMemo(() => Object.keys(live()).length);
  const offstageCast = createMemo(() => {
    const inRoom = new Set(openRoom()?.characterIds ?? []);
    return cast().filter((c) => !inRoom.has(c.characterId));
  });

  onMount(boot);

  // Inserted without a reactive wrapper on purpose. Which column is shown never
  // changes, so `${() => …}` would buy nothing and would put marker nodes between the
  // two children of a CSS grid.
  return html`
    <div class="y-app cc-root">
      ${sidebar({ onstageCount, offstageCast })}
      ${roomPane()}
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
