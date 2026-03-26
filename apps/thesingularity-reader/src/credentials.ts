import { appStorage } from '@bundled/yaar';
import type { Credentials } from './types';

const CRED_PATH = 'auth/credentials.json';

/** auth/credentials.json에 자격증명 저장 */
export async function saveCredentials(username: string, password: string): Promise<Credentials> {
  const creds: Credentials = {
    username,
    password,
    savedAt: new Date().toISOString(),
  };
  await appStorage.save(CRED_PATH, JSON.stringify(creds));
  return creds;
}

/** auth/credentials.json에서 자격증명 불러오기. 없으면 null */
export async function loadCredentials(): Promise<Credentials | null> {
  return await appStorage.readJsonOr<Credentials | null>(CRED_PATH, null);
}

/** 저장된 자격증명 삭제 */
export async function clearCredentials(): Promise<void> {
  await appStorage.save(CRED_PATH, 'null');
}
