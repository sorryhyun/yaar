import { appStorage } from '@bundled/yaar';
import type { Credentials } from './types';

const CRED_PATH = 'auth/credentials.json';

export async function saveCredentials(username: string, password: string): Promise<Credentials> {
  const creds: Credentials = {
    username,
    password,
    savedAt: new Date().toISOString(),
  };
  await appStorage.save(CRED_PATH, JSON.stringify(creds));
  return creds;
}

export async function loadCredentials(): Promise<Credentials | null> {
  return await appStorage.readJsonOr<Credentials | null>(CRED_PATH, null);
}

export async function clearCredentials(): Promise<void> {
  await appStorage.save(CRED_PATH, 'null');
}
