/**
 * Stage management — everything the UI *does*, as opposed to everything it shows.
 *
 * The split from the view is what makes this file worth having: bringing a character
 * onstage, switching rooms, taking a turn and booting the library are all sequences of
 * awaits with error handling, and none of them is easier to read next to a template.
 * The views call in here; nothing in here reaches back out to a view.
 */

import { appStorage, showToast, showPrompt, errMsg } from '@bundled/yaar';

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
  clearAvatar,
  appendLine,
} from './store';
import { blobToDataUrl, setAvatarFrom } from './avatar';
import { characterTools, hasIdentity } from './persona';
import { live, spawn, dispose, roster } from './agents';
import { running, planFor, runTape, stopTape } from './tape';
import { max, setMax, setEditing, setEditingDoc, setBooting } from './ui/state';
import { STARTER_ROOMS } from './starter';

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

/**
 * A picture chosen from the file picker.
 *
 * The input is cleared before the awaits rather than after: picking the same file twice
 * in a row fires no `change` event if the value is still sitting there, which reads as
 * the app ignoring the second attempt.
 */
export async function onAvatarPicked(characterId: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  try {
    await setAvatarFrom(characterId, { dataUrl: await blobToDataUrl(file) });
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

/**
 * A picture that already exists in storage — typically something Anima generated.
 *
 * A prompt rather than a browser: the shared media tree is other apps' output keyed by
 * producer, and a picker over it would be a second file manager living inside a 280px
 * sidebar. The path is what the producing app tells the user anyway.
 */
export async function onAvatarFromStorage(characterId: string) {
  const path = await showPrompt(
    'Path to an image already in storage — for example media/anima/dragon.png, or a full yaar://storage/… path.',
    { title: 'Picture from storage', placeholder: 'media/…', okLabel: 'Use it' },
  );
  if (!path?.trim()) return;

  try {
    await setAvatarFrom(characterId, { imagePath: path });
    showToast('Picture set', 'success');
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
}

/** Drop a character's picture; everything falls back to its emoji. */
export async function onAvatarRemoved(characterId: string) {
  try {
    await clearAvatar(characterId);
  } catch (err) {
    showToast(errMsg(err), 'error');
  }
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

/**
 * Which starter rooms have already been offered, one `roomId` per line.
 *
 * A plain "seed only when the library is empty" check can only ever seed a first-run
 * user, so a room added to `STARTER_ROOMS` after release would never reach anybody who
 * had opened the app once. The ledger makes each room's offer independent: it is seeded
 * the first time its id shows up here and never again — which is also what keeps a room
 * the user deliberately deleted from growing back on the next boot.
 */
const SEEDED_ROOMS_FILE = 'seeded-rooms.txt';

/**
 * Put any starter room the user has not been offered yet into the library.
 *
 * A room whose id already exists is recorded and skipped rather than written: an
 * upgrading user's Green Room holds *their* Mara, and `addCharacter` on an existing id
 * rewrites that character's documents.
 */
async function seedStarterRooms(): Promise<void> {
  const ledger = await appStorage.read(SEEDED_ROOMS_FILE).catch(() => '');
  const seeded = new Set(
    ledger
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const fresh = STARTER_ROOMS.filter((room) => !seeded.has(room.roomId));
  if (fresh.length === 0) return;

  const known = new Set(rooms().map((room) => room.roomId));
  for (const { cast, ...room } of fresh) {
    seeded.add(room.roomId);
    if (known.has(room.roomId)) continue;

    await createRoom(room);
    for (const person of cast) {
      await addCharacter(person);
      await castInRoom(room.roomId, person.characterId);
    }
  }

  // Last, so a seed that threw halfway is retried rather than recorded as delivered.
  await appStorage.save(SEEDED_ROOMS_FILE, `${[...seeded].join('\n')}\n`);
}

export async function boot() {
  try {
    await loadLibrary();
    await seedStarterRooms();

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
