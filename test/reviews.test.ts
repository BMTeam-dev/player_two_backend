// Testes da avaliação cega (tarefa 29): validação do payload (puro) e
// submitReview/revealBlindReviews contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseReviewInput, revealBlindReviews, submitReview } from '../functions/src/reviews/review.js';

const NOW_MS = Date.parse('2026-11-18T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const DAY = 24 * 60 * 60_000;
const at = (offsetMs: number) => Timestamp.fromMillis(NOW_MS + offsetMs);

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason;
  }
  return undefined;
};

const asyncReasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason;
  }
  return undefined;
};

describe('parseReviewInput', () => {
  it('normaliza comentário e tags', () => {
    expect(parseReviewInput({ sessionId: 's1', rating: 5, tags: ['friendly', 'friendly', 'skilled'], comment: '  GG!  ' })).toEqual({
      sessionId: 's1',
      rating: 5,
      tags: ['friendly', 'skilled'],
      comment: 'GG!',
    });
    expect(parseReviewInput({ sessionId: 's1', rating: 1, comment: '   ' })).toMatchObject({ tags: [], comment: null });
  });

  it('recusa nota fora de 1-5, tag desconhecida, comentário longo e id inválido', () => {
    for (const rating of [0, 6, 4.5, '5', undefined]) {
      expect(reasonOf(() => parseReviewInput({ sessionId: 's1', rating }))).toBe('invalid_input');
    }
    expect(reasonOf(() => parseReviewInput({ sessionId: 's1', rating: 4, tags: ['carry'] }))).toBe('invalid_input');
    expect(reasonOf(() => parseReviewInput({ sessionId: 's1', rating: 4, tags: 'friendly' }))).toBe('invalid_input');
    expect(reasonOf(() => parseReviewInput({ sessionId: 's1', rating: 4, comment: 'x'.repeat(301) }))).toBe('invalid_input');
    expect(reasonOf(() => parseReviewInput({ sessionId: 'a/b', rating: 4 }))).toBe('invalid_input');
  });

  it('recusa comentário com termo grave', () => {
    expect(reasonOf(() => parseReviewInput({ sessionId: 's1', rating: 1, comment: 'sei onde voce mora' }))).toBe(
      'comment_not_allowed',
    );
  });
});

describe('avaliações (emulador)', () => {
  let app: App;
  let db: Firestore;

  const seedSession = async (id: string, fields: Record<string, unknown> = {}) => {
    await db.doc(`sessions/${id}`).set({
      id,
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      gameId: 'valorant',
      status: 'completed',
      completedAt: at(-DAY),
      reviewedBy: { requester: false, provider: false },
      ...fields,
    });
  };
  const review = (uid: string, sessionId = 's1', overrides: Record<string, unknown> = {}, now = NOW) =>
    submitReview(db, uid, parseReviewInput({ sessionId, rating: 5, tags: ['friendly'], comment: 'Bom jogo', ...overrides }), now);
  const get = async (path: string) => (await db.doc(path).get()).data();

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'reviews-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(['sessions', 'reviews', 'users', 'config'].map(c => db.recursiveDelete(db.collection(c))));
    for (const [uid, name] of [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol']]) {
      await db.doc(`users/${uid}`).set({ uid, displayName: name, avatarUrl: null, status: 'active' });
    }
    await seedSession('s1');
  });

  it('primeira avaliação fica cega; a segunda revela as duas', async () => {
    expect(await review('alice')).toEqual({ reviewId: 's1_alice', visible: false });
    expect(await get('reviews/s1_alice')).toMatchObject({
      id: 's1_alice',
      sessionId: 's1',
      gameId: 'valorant',
      authorId: 'alice',
      targetId: 'bob',
      role: 'as_requester',
      rating: 5,
      tags: ['friendly'],
      comment: 'Bom jogo',
      authorSnapshot: { displayName: 'Alice', avatarUrl: null },
      visible: false,
    });
    expect((await get('sessions/s1'))!.reviewedBy).toEqual({ requester: true, provider: false });

    expect(await review('bob', 's1', { rating: 3, tags: [], comment: null })).toEqual({ reviewId: 's1_bob', visible: true });
    expect(await get('reviews/s1_bob')).toMatchObject({ targetId: 'alice', role: 'as_provider', rating: 3, comment: null, visible: true });
    expect((await get('reviews/s1_alice'))!.visible).toBe(true);
    expect((await get('sessions/s1'))!.reviewedBy).toEqual({ requester: true, provider: true });
  });

  it('recusa avaliar duas vezes, sem mudar a primeira', async () => {
    await review('alice');
    expect(await asyncReasonOf(review('alice', 's1', { rating: 1 }))).toBe('already_reviewed');
    expect((await get('reviews/s1_alice'))!.rating).toBe(5);
  });

  it('terceiro e sessão inexistente recebem o mesmo erro', async () => {
    expect(await asyncReasonOf(review('carol'))).toBe('session_not_found');
    expect(await asyncReasonOf(review('alice', 'nope'))).toBe('session_not_found');
  });

  it('só avalia sessão concluída', async () => {
    for (const status of ['requested', 'accepted', 'in_progress', 'awaiting_confirmation', 'cancelled', 'no_show', 'declined', 'expired']) {
      await seedSession(`x_${status}`, { status, completedAt: null });
      expect(await asyncReasonOf(review('alice', `x_${status}`))).toBe('invalid_state');
    }
  });

  it('prazo de 7 dias a partir da conclusão, ou o de config/app', async () => {
    await seedSession('s2', { completedAt: at(-7 * DAY) });
    expect(await review('alice', 's2')).toMatchObject({ visible: false });

    await seedSession('s3', { completedAt: at(-7 * DAY - 1) });
    expect(await asyncReasonOf(review('alice', 's3'))).toBe('review_window_closed');

    await db.doc('config/app').set({ reviewWindowDays: 10 });
    expect(await review('alice', 's3')).toMatchObject({ visible: false });
  });

  it('conta suspensa ou banida não avalia', async () => {
    await db.doc('users/alice').update({ status: 'suspended' });
    expect(await asyncReasonOf(review('alice'))).toBe('account_restricted');
    expect(await get('reviews/s1_alice')).toBeUndefined();
  });

  it('revealBlindReviews revela só as cegas com mais de 7 dias', async () => {
    await seedSession('s2', { completedAt: at(-10 * DAY) });
    await seedSession('s3', { completedAt: at(-10 * DAY) });
    await review('alice', 's2', {}, at(-8 * DAY)); // cega há 8 dias
    await review('alice', 's3', {}, at(-9 * DAY)); // os dois lados avaliaram:
    await review('bob', 's3', {}, at(-9 * DAY)); //   já visíveis, fora da consulta
    await review('alice', 's1'); // cega, recente

    expect(await revealBlindReviews(db, NOW)).toBe(1);
    expect((await get('reviews/s2_alice'))!.visible).toBe(true);
    expect((await get('reviews/s1_alice'))!.visible).toBe(false);
    expect(await revealBlindReviews(db, NOW)).toBe(0);
  });

  it('revealBlindReviews usa reviewWindowDays de config/app', async () => {
    await review('alice', 's1', {}, at(-3 * DAY));
    expect(await revealBlindReviews(db, NOW)).toBe(0);
    await db.doc('config/app').set({ reviewWindowDays: 2 });
    expect(await revealBlindReviews(db, NOW)).toBe(1);
  });
});
