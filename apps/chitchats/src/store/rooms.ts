/**
 * Rooms — creating them, renaming them, and deciding who is cast in them.
 *
 * Imports only from `state.ts`, so `characters.ts` can call in here (removing a
 * character has to uncast it everywhere) without either module importing the other.
 */

import {
  rooms,
  setRooms,
  openRoomId,
  setOpenRoomId,
  setTranscript,
  roomsC,
  messagesC,
  type Room,
  type RoomDoc,
} from './state';

/** Load one room's transcript and make it the open room. */
export async function loadRoom(roomId: string): Promise<void> {
  // Capped: a long-running room's tail is what a newcomer needs, and the sub-agents
  // carry the rest in their own session memory anyway.
  const log = await messagesC.find({ roomId }, { sort: { seq: 1 }, limit: 300 });
  setOpenRoomId(roomId);
  setTranscript(log);
}

export async function createRoom(input: Pick<RoomDoc, 'roomId' | 'name' | 'emoji'>): Promise<Room> {
  const existing = rooms().find((r) => r.roomId === input.roomId);
  if (existing) return existing;

  const doc: RoomDoc = { ...input, characterIds: [], createdAt: Date.now() };
  const _id = await roomsC.insert(doc);
  const stored: Room = { ...doc, _id };
  setRooms([...rooms(), stored]);
  return stored;
}

export async function removeRoom(roomId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (room?._id) await roomsC.remove(room._id);
  await messagesC.removeWhere({ roomId });
  setRooms(rooms().filter((r) => r.roomId !== roomId));
  if (openRoomId() === roomId) {
    setOpenRoomId(null);
    setTranscript([]);
  }
}

async function updateRoom(roomId: string, patch: Partial<RoomDoc>): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room?._id) return;
  await roomsC.update(room._id, patch);
  setRooms(rooms().map((r) => (r.roomId === roomId ? { ...r, ...patch } : r)));
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  await updateRoom(roomId, { name });
}

/** Put a character onstage in a room. Idempotent — casting twice is not two characters. */
export async function castInRoom(roomId: string, characterId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room || room.characterIds.includes(characterId)) return;
  await updateRoom(roomId, { characterIds: [...room.characterIds, characterId] });
}

export async function uncastFromRoom(roomId: string, characterId: string): Promise<void> {
  const room = rooms().find((r) => r.roomId === roomId);
  if (!room) return;
  await updateRoom(roomId, { characterIds: room.characterIds.filter((c) => c !== characterId) });
}
