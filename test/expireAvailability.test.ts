// Testes de expireAvailability contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireAvailabilities } from '../functions/src/availability/expire.js';
import type { Availability } from '../functions/src/types.js';

const NOW = Timestamp.fromDate(new Date('2026-10-30T15:00:00Z'));
const minutes = (n: number) => Timestamp.fromMillis(NOW.toMillis() + n * 60_000);

const availability = (overrides: Partial<Availability>): Availability => ({
  state: 'now',
  gameIds: ['valorant'],
  windowStart: null,
  windowEnd: null,
  expiresAt: minutes(60),
  note: 'bora de ranked',
  ...overrides,
});

describe('expireAvailabilities', () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'expire-availability-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await db.recursiveDelete(db.collection('users'));
  });

  const stateOf = async (uid: string) => (await db.doc(`users/${uid}`).get()).get('availability') as Availability;

  it('passa para offline só quem venceu', async () => {
    await db.doc('users/vencido_now').set({ displayName: 'A', availability: availability({ expiresAt: minutes(-5) }) });
    await db.doc('users/vencido_today').set({
      displayName: 'B',
      availability: availability({ state: 'today', expiresAt: minutes(-1) }),
    });
    await db.doc('users/vencido_window').set({
      displayName: 'C',
      availability: availability({ state: 'window', windowStart: minutes(-120), windowEnd: minutes(0), expiresAt: minutes(0) }),
    });
    await db.doc('users/valido').set({ displayName: 'D', availability: availability({ expiresAt: minutes(30) }) });
    await db.doc('users/offline').set({
      displayName: 'E',
      availability: availability({ state: 'offline', gameIds: [], expiresAt: null, note: null }),
    });

    expect(await expireAvailabilities(db, NOW)).toBe(3);

    for (const uid of ['vencido_now', 'vencido_today', 'vencido_window']) {
      expect(await stateOf(uid)).toEqual({
        state: 'offline',
        gameIds: [],
        windowStart: null,
        windowEnd: null,
        expiresAt: null,
        note: null,
      });
    }
    expect((await stateOf('valido')).state).toBe('now');
    // Só mexe na disponibilidade: o resto do perfil fica igual.
    expect((await db.doc('users/vencido_now').get()).get('displayName')).toBe('A');
  });

  it('não roda de novo sobre quem já expirou', async () => {
    await db.doc('users/a').set({ availability: availability({ expiresAt: minutes(-5) }) });
    expect(await expireAvailabilities(db, NOW)).toBe(1);
    expect(await expireAvailabilities(db, NOW)).toBe(0);
  });

  it('pagina quando há mais vencidos que uma página', async () => {
    const batch = db.batch();
    for (let i = 0; i < 350; i++) {
      batch.set(db.doc(`users/u${i}`), { availability: availability({ expiresAt: minutes(-i - 1) }) });
    }
    await batch.commit();

    expect(await expireAvailabilities(db, NOW)).toBe(350);
    const left = await db.collection('users').where('availability.state', '!=', 'offline').count().get();
    expect(left.data().count).toBe(0);
  });
});
