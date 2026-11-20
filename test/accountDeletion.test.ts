// Testes da exclusão de conta (tarefa 33) contra o emulador do Firestore
// (`npm test`). Auth, Storage e RTDB são falsos injetados: o `npm test` só
// sobe o emulador do Firestore.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DELETED_SNAPSHOT, deleteAccount, type AccountDeletionDeps } from '../functions/src/users/accountDeletion.js';

const NOW = Timestamp.fromMillis(Date.parse('2026-11-19T15:00:00Z'));
const SNAP = (name: string) => ({ displayName: name, avatarUrl: null });

function fakeDeps(missingAuth = false) {
  const calls: string[] = [];
  const deps: AccountDeletionDeps = {
    deleteAuthUser: uid =>
      missingAuth
        ? Promise.reject(Object.assign(new Error('no user'), { code: 'auth/user-not-found' }))
        : (calls.push(`auth:${uid}`), Promise.resolve()),
    deleteAvatarFiles: uid => (calls.push(`avatar:${uid}`), Promise.resolve()),
    deletePresence: uid => (calls.push(`presence:${uid}`), Promise.resolve()),
  };
  return { deps, calls };
}

describe('deleteAccount (emulador)', () => {
  let app: App;
  let db: Firestore;
  const get = async (path: string) => (await db.doc(path).get()).data();

  const seedPair = async (id: string, status: string) => {
    await db.doc(`sessions/${id}`).set({
      id,
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      participantSnapshots: { alice: SNAP('Alice'), bob: SNAP('Bob') },
      status,
      scheduledStart: NOW,
      conversationId: `c_${id}`,
      cancellation: null,
    });
    await db.doc(`conversations/c_${id}`).set({
      id: `c_${id}`,
      participantIds: ['alice', 'bob'],
      participantSnapshots: { alice: SNAP('Alice'), bob: SNAP('Bob') },
      lockedAt: null,
      lockedReason: null,
      lastMessage: { at: NOW },
    });
    await db.doc(`conversations/c_${id}/messages/m1`).set({ id: 'm1', senderId: 'alice', type: 'text', text: 'oi' });
  };

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'account-deletion-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(
      ['users', 'usernames', 'sessions', 'conversations', 'listings', 'reviews', 'reports'].map(c =>
        db.recursiveDelete(db.collection(c)),
      ),
    );
    await db.doc('users/alice').set({ uid: 'alice', username: 'alice', status: 'active' });
    await db.doc('users/alice/private/data').set({ email: 'a@x.com', fcmTokens: ['t1'] });
    await db.doc('users/alice/games/valorant').set({ gameId: 'valorant' });
    await db.doc('users/alice/blocks/carol').set({ blockedUid: 'carol', createdAt: NOW });
    await db.doc('usernames/alice').set({ uid: 'alice', createdAt: NOW });
    await db.doc('users/bob').set({ uid: 'bob', username: 'bob', status: 'active' });
    await db.doc('users/bob/blocks/alice').set({ blockedUid: 'alice', createdAt: NOW });
    await db.doc('users/bob/blocks/carol').set({ blockedUid: 'carol', createdAt: NOW });
    await db.doc('usernames/bob').set({ uid: 'bob', createdAt: NOW });
  });

  it('apaga os dados da pessoa, anonimiza o que é do outro lado e exclui o login por último', async () => {
    await seedPair('s1', 'requested');
    await seedPair('s2', 'completed');
    await db.doc('listings/l1').set({ id: 'l1', ownerId: 'alice', active: true, createdAt: NOW });
    await db.doc('listings/l2').set({ id: 'l2', ownerId: 'bob', active: true, createdAt: NOW });
    await db.doc('reviews/s2_alice').set({ authorId: 'alice', targetId: 'bob', rating: 5, tags: ['friendly'], comment: 'top', authorSnapshot: SNAP('Alice'), visible: true });
    await db.doc('reviews/s2_bob').set({ authorId: 'bob', targetId: 'alice', rating: 4, tags: [], comment: 'ok', authorSnapshot: SNAP('Bob'), visible: true });
    await db.doc('reports/r1').set({ reporterId: 'bob', targetUserId: 'alice' });

    const { deps, calls } = fakeDeps();
    expect(await deleteAccount(db, deps, 'alice', NOW)).toMatchObject({
      cancelled: 1,
      locked: 2,
      reviewsDeleted: 1,
      blocksDeleted: 1,
      listingsDeleted: 1,
    });
    expect(calls).toEqual(['avatar:alice', 'presence:alice', 'auth:alice']);

    for (const path of ['users/alice', 'users/alice/private/data', 'users/alice/games/valorant', 'users/alice/blocks/carol', 'usernames/alice', 'listings/l1', 'reviews/s2_bob', 'users/bob/blocks/alice']) {
      expect(await get(path), path).toBeUndefined();
    }
    for (const path of ['users/bob', 'usernames/bob', 'listings/l2', 'users/bob/blocks/carol', 'reports/r1']) {
      expect(await get(path), path).toBeDefined();
    }

    expect(await get('sessions/s1')).toMatchObject({
      status: 'cancelled',
      cancellation: { by: null },
      participantSnapshots: { alice: DELETED_SNAPSHOT, bob: SNAP('Bob') },
    });
    expect((await get('sessions/s2'))!.status).toBe('completed');
    expect(await get('conversations/c_s2')).toMatchObject({
      lockedReason: 'account_deleted',
      participantSnapshots: { alice: DELETED_SNAPSHOT, bob: SNAP('Bob') },
    });
    expect(await get('conversations/c_s2/messages/m1')).toMatchObject({ senderId: 'alice', text: 'oi' });
    expect(await get('reviews/s2_alice')).toMatchObject({ rating: 5, tags: ['friendly'], comment: null, authorSnapshot: DELETED_SNAPSHOT });
  });

  it('chamar de novo depois de cair no meio termina o que faltou', async () => {
    await seedPair('s1', 'completed');
    // Simula uma tentativa que apagou o perfil mas não chegou ao username.
    await db.recursiveDelete(db.doc('users/alice'));
    const { deps, calls } = fakeDeps(true);
    await deleteAccount(db, deps, 'alice', NOW);
    expect(await get('usernames/alice')).toBeUndefined();
    expect(await get('users/bob/blocks/alice')).toBeUndefined();
    expect((await get('sessions/s1'))!.participantSnapshots.alice).toEqual(DELETED_SNAPSHOT);
    expect(calls).toEqual(['avatar:alice', 'presence:alice']);
  });

  it('conta suspensa ou banida não se exclui pelo app', async () => {
    await db.doc('users/alice').update({ status: 'banned' });
    const { deps, calls } = fakeDeps();
    await expect(deleteAccount(db, deps, 'alice', NOW)).rejects.toMatchObject({ details: { reason: 'account_restricted' } });
    expect(await get('usernames/alice')).toBeDefined();
    expect(calls).toEqual([]);
  });
});
