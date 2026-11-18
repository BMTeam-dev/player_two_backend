// Testes das stats do perfil (tarefa 30): quando os triggers recalculam
// (puro) e computeStats/refreshUserStats contra o emulador (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeStats, refreshUserStats } from '../functions/src/stats/stats.js';
import { reviewStatsUid, sessionStatsUids } from '../functions/src/stats/statsTriggers.js';
import type { Review, Session } from '../functions/src/types.js';

const s = (status: Session['status']) => ({ status, participantIds: ['alice', 'bob'] }) as unknown as Session;
const r = (visible: boolean) => ({ visible, targetId: 'bob' }) as unknown as Review;

describe('quando recalcular', () => {
  it('sessão: só mudança de status que pesa nas stats, para os dois participantes', () => {
    expect(sessionStatsUids(s('requested'), s('accepted'))).toEqual(['alice', 'bob']);
    for (const to of ['declined', 'completed', 'cancelled', 'no_show'] as const) {
      expect(sessionStatsUids(s('in_progress'), s(to))).toEqual(['alice', 'bob']);
    }
    expect(sessionStatsUids(null, s('requested'))).toEqual([]);
    expect(sessionStatsUids(s('accepted'), s('in_progress'))).toEqual([]);
    expect(sessionStatsUids(s('expired'), s('expired'))).toEqual([]);
    expect(sessionStatsUids(s('completed'), s('completed'))).toEqual([]); // ex: reviewedBy
    expect(sessionStatsUids(s('completed'), null)).toEqual([]);
  });

  it('avaliação: só quando passa a contar ou deixa de contar', () => {
    expect(reviewStatsUid(null, r(false))).toBeNull(); // cega
    expect(reviewStatsUid(null, r(true))).toBe('bob'); // criada já revelada
    expect(reviewStatsUid(r(false), r(true))).toBe('bob'); // revelada
    expect(reviewStatsUid(r(true), r(true))).toBeNull();
    expect(reviewStatsUid(r(true), null)).toBe('bob'); // apagada
    expect(reviewStatsUid(r(false), null)).toBeNull();
  });
});

describe('stats (emulador)', () => {
  let app: App;
  let db: Firestore;
  let n = 0;

  const session = (fields: Record<string, unknown>) =>
    db.doc(`sessions/s${++n}`).set({
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      status: 'completed',
      cancellation: null,
      noShow: null,
      responseMinutes: null,
      ...fields,
    });
  const review = (targetId: string, rating: number, visible: boolean) =>
    db.doc(`reviews/r${++n}`).set({ targetId, rating, visible, authorId: 'x', createdAt: new Date() });

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'stats-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(['sessions', 'reviews', 'users'].map(c => db.recursiveDelete(db.collection(c))));
  });

  it('sem histórico: nota 0, taxa 1 e sem tempo de resposta', async () => {
    expect(await computeStats(db, 'bob')).toEqual({
      ratingAvg: 0,
      ratingCount: 0,
      sessionsCompleted: 0,
      completionRate: 1,
      avgResponseMinutes: null,
    });
  });

  it('nota: média só das visíveis e só das que a pessoa recebeu', async () => {
    await review('bob', 5, true);
    await review('bob', 4, true);
    await review('bob', 3, true);
    await review('bob', 1, false); // cega: não conta
    await review('alice', 1, true); // de outra pessoa
    expect(await computeStats(db, 'bob')).toMatchObject({ ratingAvg: 4, ratingCount: 3 });

    await review('bob', 5, true);
    expect(await computeStats(db, 'bob')).toMatchObject({ ratingAvg: 4.25, ratingCount: 4 });
  });

  it('taxa de conclusão: cancelar depois de aceitar e faltar pesam, nos dois papéis', async () => {
    await session({ status: 'completed' });
    await session({ status: 'completed', requesterId: 'bob', providerId: 'alice' }); // bob como quem pediu
    await session({ status: 'completed' });
    await session({ status: 'cancelled', cancellation: { by: 'bob', fromStatus: 'accepted' } }); // pesa para bob
    await session({ status: 'cancelled', cancellation: { by: 'bob', fromStatus: 'requested' } }); // pedido: não pesa
    await session({ status: 'cancelled', cancellation: { by: 'alice', fromStatus: 'accepted' } }); // pesa para alice
    await session({ status: 'no_show', noShow: { reportedBy: 'alice', absentUid: 'bob' } }); // pesa para bob
    await session({ status: 'declined' });
    await session({ status: 'expired' });

    // bob: 3 / (3 + 1 + 1); alice: 3 / (3 + 1)
    expect(await computeStats(db, 'bob')).toMatchObject({ sessionsCompleted: 3, completionRate: 0.6 });
    expect(await computeStats(db, 'alice')).toMatchObject({ sessionsCompleted: 3, completionRate: 0.75 });
  });

  it('sem nenhuma concluída, faltar derruba a taxa a 0', async () => {
    await session({ status: 'no_show', noShow: { reportedBy: 'alice', absentUid: 'bob' } });
    expect(await computeStats(db, 'bob')).toMatchObject({ sessionsCompleted: 0, completionRate: 0 });
  });

  it('tempo de resposta: média dos pedidos respondidos como provider', async () => {
    await session({ status: 'accepted', responseMinutes: 4 });
    await session({ status: 'declined', responseMinutes: 11 });
    await session({ status: 'expired', responseMinutes: null }); // sem resposta: fora
    await session({ requesterId: 'bob', providerId: 'alice', responseMinutes: 60 }); // alice respondeu
    expect((await computeStats(db, 'bob')).avgResponseMinutes).toBe(8); // 7,5 arredondado
    expect((await computeStats(db, 'alice')).avgResponseMinutes).toBe(60);
  });

  it('refreshUserStats grava só quando muda, e ignora usuário inexistente', async () => {
    const initial = { ratingAvg: 0, ratingCount: 0, sessionsCompleted: 0, completionRate: 1, avgResponseMinutes: null };
    await db.doc('users/bob').set({ uid: 'bob', stats: initial });
    expect(await refreshUserStats(db, 'bob')).toBe(false);

    await review('bob', 4, true);
    await session({ status: 'completed', responseMinutes: 2 });
    expect(await refreshUserStats(db, 'bob')).toBe(true);
    expect((await db.doc('users/bob').get()).get('stats')).toEqual({
      ratingAvg: 4,
      ratingCount: 1,
      sessionsCompleted: 1,
      completionRate: 1,
      avgResponseMinutes: 2,
    });
    expect(await refreshUserStats(db, 'bob')).toBe(false);
    expect(await refreshUserStats(db, 'ghost')).toBe(false);
    expect((await db.doc('users/ghost').get()).exists).toBe(false);
  });
});
