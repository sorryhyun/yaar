/**
 * Stage management — everything the UI *does*, as opposed to everything it shows.
 *
 * The split from the view is what makes this file worth having: bringing a character
 * onstage, switching rooms, taking a turn and booting the library are all sequences of
 * awaits with error handling, and none of them is easier to read next to a template.
 * The views call in here; nothing in here reaches back out to a view.
 */

import { showToast, errMsg } from '@bundled/yaar';

import {
  rooms,
  openRoomId,
  roomCast,
  personaOf,
  systemPromptOf,
  loadLibrary,
  loadRoom,
  createRoom,
  castInRoom,
  addCharacter,
  saveAvatar,
  appendLine,
} from './store';
import { characterTools, hasIdentity } from './persona';
import { live, spawn, dispose, roster } from './agents';
import { running, planFor, runTape, stopTape } from './tape';
import { max, setMax, setEditing, setEditingDoc, setBooting } from './ui/state';
import { STARTER_ROOM, STARTER_CAST } from './starter';

// ── Stage management ────────────────────────────────────────────────

/**
 * Make the live personas match the open room's cast.
 *
 * Called on every room switch. Characters from the room you left are disposed rather
 * than parked: they hold agent slots, and their conversation belongs to a room you
 * are no longer in. The transcript is what survives, and a character brought back is
 * told what it missed (`turnPrompt` with `sinceSeq` 0).
 */
export async function syncStage() {
  const wanted = roomCast();
  const wantedIds = new Set(wanted.map((c) => c.characterId));

  for (const characterId of Object.keys(live())) {
    if (!wantedIds.has(characterId)) await dispose(characterId);
  }

  for (const character of wanted) {
    if (live()[character.characterId]) continue;
    if (Object.keys(live()).length >= max()) {
      showToast(`Only ${max()} characters can be onstage at once`, 'error');
      break;
    }
    const persona = personaOf(character.characterId);
    if (!hasIdentity(persona)) {
      showToast(`${character.name} has no persona written yet`, 'error');
      continue;
    }
    try {
      await spawn(character, systemPromptOf(character), characterTools(persona, character.name));
    } catch (err) {
      showToast(`${character.name} could not come onstage: ${errMsg(err)}`, 'error');
    }
  }
}

export async function switchRoom(roomId: string) {
  if (running()) await stopTape();
  try {
    await loadRoom(roomId);
    await syncStage();
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

// ── The turn ──────────────────────────────────────────────────────

/**
 * Say something to the room, then let the tape run.
 *
 * The user's line lands in the transcript *before* the plan is built, so the first
 * speaker's prompt already contains it — and so does everyone else's, since each
 * character's context is assembled at the moment its own turn starts.
 */
export async function send(text: string) {
  const said = text.trim();
  if (!said || running()) return;
  if (Object.keys(live()).length === 0) {
    showToast('Bring at least one character into the room first', 'error');
    return;
  }

  try {
    await appendLine('user', said);
    await runTape(planFor(said, roomCast()));
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

// ── Cast editing ──────────────────────────────────────────────────

export async function onAvatarPicked(characterId: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('could not read that file'));
    reader.readAsDataURL(file);
  }).catch((err: unknown) => {
    showToast(errMsg(err), 'error');
    return '';
  });
  if (!dataUrl) return;

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  try {
    await saveAvatar(characterId, base64, file.type || 'image/png');
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
  input.value = '';
}

export async function newCharacter() {
  const characterId = `character-${Date.now().toString(36)}`;
  try {
    await addCharacter({
      characterId,
      name: 'New character',
      emoji: '🎭',
      priority: 0,
      // Third person, because that is the format's first rule and a blank textarea
      // teaches nobody. The frame that turns this into "you are them" is app-owned.
      persona: {
        inANutshell: '______ is a ______ who ______. Right now they are ______.',
        characteristics:
          '## Appearance\n- **______**: ______\n\n## Personality\n- **______**: ______',
      },
    });
    const room = openRoomId();
    if (room) await castInRoom(room, characterId);
    setEditing(characterId);
    setEditingDoc('inANutshell');
    await syncStage();
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

export async function newRoom() {
  const roomId = `room-${Date.now().toString(36)}`;
  try {
    await createRoom({ roomId, name: 'New room', emoji: '💬' });
    await switchRoom(roomId);
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

// ── Boot ─────────────────────────────────────────────────────────

export async function boot() {
  try {
    await loadLibrary();

    if (rooms().length === 0) {
      await createRoom(STARTER_ROOM);
      for (const person of STARTER_CAST) {
        await addCharacter(person);
        await castInRoom(STARTER_ROOM.roomId, person.characterId);
      }
    }

    const state = await roster();
    setMax(state.max);

    // Personas alive from before an iframe reload belong to whichever room was open
    // then; the room whose cast they are is the one to reopen, so a reload is a
    // no-op rather than a teardown.
    const alive = new Set(state.personas.map((p) => p.personaId));
    const owning = rooms().find((r) => r.characterIds.some((id) => alive.has(id))) ?? rooms()[0];
    if (owning) await switchRoom(owning.roomId);
  } catch (err) {
    showToast(errMsg(err), 'error');
  } finally {
    setBooting(false);
  }
}
