// Testes do trigger de moderação (tarefa 32): quando agir (puro) e os
// efeitos de suspender/banir contra o emulador do Firestore (`npm test`). O
// Auth é um falso injetado: o `npm test` só sobe o emulador do Firestore.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { restoreUser, restrictUser, statusChange, type ModerationAuth } from '../functions/src/moderation/status.js';
import type { UserStatus } from '../functions/src/types.js';

const NOW = Timestamp.fromMillis(Date.parse('2026-11-18T15:00:00Z'));
const u = (status: UserStatus) => ({ status });

function fakeAuth(missing = false) {
  const calls: string[] = [];
  const notFound = () => Promise.reject(Object.assign(new Error('no user'), { code: 'auth/user-not-found' }));
  const auth: ModerationAuth = {
    updateUser: (uid, { disabled }) => (missing ? notFound() : (calls.push(`${uid}:disabled=${disabled}`), Promise.resolve())),
    revokeRefreshTokens: uid => (missing ? notFound() : (calls.push(`${uid}:revoke`), Promise.resolve())),
  };
  return { auth, calls };
}

describe('statusChange', () => {
  it('restringe ao suspender ou banir, inclusive de suspenso para banido', () => {
    expect(statusChange(u('active'), u('suspended'))).toBe('restrict');
    expect(statusChange(u('active'), u('banned'))).toBe('restrict');
    expect(statusChange(u('suspended'), u('banned'))).toBe('restrict');
  });

  it('restaura só ao voltar para active', () => {
    expect(statusChange(u('suspended'), u('active'))).toBe('restore');
    expect(statusChange(u('banned'), u('active'))).toBe('restore');
    expect(statusChange(u('banned'), u('suspended'))).toBe('restrict');
  });

  it('nada quando o status não muda, no cadastro ativo e na exclusão', () => {
    expect(statusChange(u('active'), u('active'))).toBeNull();
    expect(statusChange(u('banned'), u('banned'))).toBeNull();
    expect(statusChange(null, u('active'))).toBeNull();
    expect(statusChange(u('active'), null)).toBeNull();
  });
});

describe('restrictUser / restoreUser (emulador)', () => {
  let app: App;
  let db: Firestore;
  let n = 0;

  const seedSession = async (status: string, other = 'bob', fields: Record<string, unknown> = {}) => {
    const id = `s${++n}`;
    await db.doc(`sessions/${id}`).set({
      id,
      requesterId: 'mallory',
      providerId: other,
      participantIds: ['mallory', other],
      status,
      scheduledStart: NOW,
      conversationId: `c_${id}`,
      cancellation: null,
      ...fields,
    });
    await db.doc(`conversations/c_${id}`).set({
      id: `c_${id}`,
      participantIds: ['mallory', other],
      lockedAt: null,
      lockedReason: null,
      lastMessage: { at: NOW },
    });
    return id;
  };
  const get = async (path: string) => (await db.doc(path).get()).data();

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'moderation-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(['users', 'sessions', 'conversations', 'listings'].map(c => db.recursiveDelete(db.collection(c))));
    await db.doc('users/mallory/private/data').set({ fcmTokens: ['t1', 't2'], email: 'm@x.com' });
  });

  it('desativa a conta, tranca as conversas, cancela o que não começou e tira os anúncios', async () => {
    const requested = await seedSession('requested');
    const accepted = await seedSession('accepted', 'carol');
    const inProgress = await seedSession('in_progress');
    const completed = await seedSession('completed');
    await db.doc('listings/l1').set({ id: 'l1', ownerId: 'mallory', active: true, createdAt: NOW });
    await db.doc('listings/l2').set({ id: 'l2', ownerId: 'mallory', active: false, createdAt: NOW });
    await db.doc('listings/l3').set({ id: 'l3', ownerId: 'bob', active: true, createdAt: NOW });
    // Conversa de outras pessoas: intacta.
    await db.doc('conversations/c_other').set({ id: 'c_other', participantIds: ['bob', 'carol'], lockedAt: null, lastMessage: { at: NOW } });

    const { auth, calls } = fakeAuth();
    expect(await restrictUser(db, auth, 'mallory', NOW)).toEqual({ locked: 4, cancelled: 2, listingsDeactivated: 1 });
    expect(calls).toEqual(['mallory:disabled=true', 'mallory:revoke']);

    for (const id of [requested, accepted, inProgress, completed]) {
      expect(await get(`conversations/c_${id}`)).toMatchObject({ lockedReason: 'moderation' });
    }
    expect((await get('conversations/c_other'))!.lockedAt).toBeNull();

    expect(await get(`sessions/${requested}`)).toMatchObject({
      status: 'cancelled',
      cancellation: { by: null, reason: null, fromStatus: 'requested' },
    });
    expect(await get(`sessions/${accepted}`)).toMatchObject({ status: 'cancelled', cancellation: { by: null, fromStatus: 'accepted' } });
    expect((await get(`sessions/${inProgress}`))!.status).toBe('in_progress');
    expect((await get(`sessions/${completed}`))!.status).toBe('completed');
    const events = (await db.collection(`sessions/${accepted}/events`).get()).docs.map(d => d.data());
    expect(events).toMatchObject([{ type: 'cancelled', fromStatus: 'accepted', toStatus: 'cancelled', actorId: null }]);

    expect((await get('listings/l1'))!.active).toBe(false);
    expect((await get('listings/l3'))!.active).toBe(true);
    expect(await get('users/mallory/private/data')).toMatchObject({ fcmTokens: [], email: 'm@x.com' });
  });

  it('repetir não tranca nem cancela de novo', async () => {
    await seedSession('requested');
    const { auth } = fakeAuth();
    await restrictUser(db, auth, 'mallory', NOW);
    expect(await restrictUser(db, auth, 'mallory', NOW)).toEqual({ locked: 0, cancelled: 0, listingsDeactivated: 0 });
  });

  it('perfil sem conta no Auth (seed) ainda recebe os efeitos no banco', async () => {
    await seedSession('requested');
    const { auth } = fakeAuth(true);
    expect(await restrictUser(db, auth, 'mallory', NOW)).toMatchObject({ locked: 1, cancelled: 1 });
  });

  it('restaurar só reativa o login; conversa e anúncio continuam como estavam', async () => {
    const id = await seedSession('requested');
    await db.doc('listings/l1').set({ id: 'l1', ownerId: 'mallory', active: true, createdAt: NOW });
    const { auth, calls } = fakeAuth();
    await restrictUser(db, auth, 'mallory', NOW);
    await restoreUser(auth, 'mallory');
    expect(calls.at(-1)).toBe('mallory:disabled=false');
    expect((await get(`conversations/c_${id}`))!.lockedReason).toBe('moderation');
    expect((await get('listings/l1'))!.active).toBe(false);
  });

  it('Auth fora do ar: o banco já foi cortado e o erro sobe para o trigger tentar de novo', async () => {
    const id = await seedSession('requested');
    const auth: ModerationAuth = {
      updateUser: () => Promise.reject(Object.assign(new Error('quota'), { code: 'auth/internal-error' })),
      revokeRefreshTokens: () => Promise.resolve(),
    };
    await expect(restrictUser(db, auth, 'mallory', NOW)).rejects.toThrow('quota');
    expect((await get(`conversations/c_${id}`))!.lockedReason).toBe('moderation');
    expect((await get(`sessions/${id}`))!.status).toBe('cancelled');
  });
});
