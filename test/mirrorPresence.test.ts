// Testes de mirrorPresence contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mirrorPresence } from '../functions/src/presence/mirror.js';

const NOW = Timestamp.fromDate(new Date('2026-11-03T15:00:00Z'));
const at = (minutes: number) => NOW.toMillis() + minutes * 60_000;

describe('mirrorPresence', () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'mirror-presence-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.collection('users'));
  });

  const userOf = async (uid: string) => (await db.doc(`users/${uid}`).get()).data();

  it('espelha online e offline com o horário do RTDB', async () => {
    await db.doc('users/a').set({ displayName: 'A', isOnline: false, lastSeenAt: null, updatedAt: NOW });

    expect(await mirrorPresence(db, 'a', { state: 'online', lastChanged: at(-10) }, NOW)).toBe('updated');
    expect(await userOf('a')).toMatchObject({ isOnline: true, lastSeenAt: Timestamp.fromMillis(at(-10)) });

    expect(await mirrorPresence(db, 'a', { state: 'offline', lastChanged: at(-1) }, NOW)).toBe('updated');
    const user = await userOf('a');
    expect(user).toMatchObject({ isOnline: false, lastSeenAt: Timestamp.fromMillis(at(-1)) });
    // Só mexe na presença: nem `updatedAt` muda.
    expect(user).toMatchObject({ displayName: 'A', updatedAt: NOW });
  });

  it('descarta evento mais antigo que o último aplicado', async () => {
    await db.doc('users/a').set({ isOnline: false, lastSeenAt: Timestamp.fromMillis(at(-1)) });

    expect(await mirrorPresence(db, 'a', { state: 'online', lastChanged: at(-5) }, NOW)).toBe('stale');
    expect(await userOf('a')).toMatchObject({ isOnline: false });
  });

  it('nó apagado vira offline', async () => {
    await db.doc('users/a').set({ isOnline: true, lastSeenAt: Timestamp.fromMillis(at(-30)) });

    expect(await mirrorPresence(db, 'a', null, NOW)).toBe('updated');
    expect(await userOf('a')).toMatchObject({ isOnline: false, lastSeenAt: NOW });
  });

  it('não cria perfil para quem ainda está no onboarding', async () => {
    expect(await mirrorPresence(db, 'novo', { state: 'online', lastChanged: at(0) }, NOW)).toBe('no_profile');
    expect((await db.doc('users/novo').get()).exists).toBe(false);
  });
});
