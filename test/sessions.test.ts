// Testes das callables de sessão: validação dos payloads (puro) e as
// transactions contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSessionRequest, parseRequestInput, requestExpiresAtMs } from '../functions/src/sessions/request.js';
import { parseTransitionInput, transitionSession, type SessionAction } from '../functions/src/sessions/transitions.js';

const NOW_MS = Date.parse('2026-11-10T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const MIN = 60_000;
const at = (offsetMs: number) => Timestamp.fromMillis(NOW_MS + offsetMs);

const validRequest = (overrides: Record<string, unknown> = {}) => ({
  providerId: 'bob',
  gameId: 'valorant',
  scheduledStartMs: null,
  durationMinutes: 60,
  message: '  Bora subir de elo?  ',
  ...overrides,
});

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

describe('parseRequestInput', () => {
  it('normaliza a mensagem e aceita "agora"', () => {
    const input = parseRequestInput(validRequest(), NOW_MS);
    expect(input).toMatchObject({ listingId: null, scheduledStartMs: null, message: 'Bora subir de elo?' });
    expect(parseRequestInput(validRequest({ message: '   ' }), NOW_MS).message).toBeNull();
  });

  it('recusa horário no passado (além da folga de relógio) ou a mais de 7 dias', () => {
    expect(reasonOf(() => parseRequestInput(validRequest({ scheduledStartMs: NOW_MS - 4 * MIN }), NOW_MS))).toBeUndefined();
    expect(reasonOf(() => parseRequestInput(validRequest({ scheduledStartMs: NOW_MS - 6 * MIN }), NOW_MS))).toBe('invalid_input');
    expect(reasonOf(() => parseRequestInput(validRequest({ scheduledStartMs: NOW_MS + 8 * 24 * 60 * MIN }), NOW_MS))).toBe(
      'invalid_input',
    );
  });

  it('recusa duração fora da faixa, mensagem longa e ids inválidos', () => {
    expect(reasonOf(() => parseRequestInput(validRequest({ durationMinutes: 50 }), NOW_MS))).toBe('invalid_input');
    expect(reasonOf(() => parseRequestInput(validRequest({ durationMinutes: 255 }), NOW_MS))).toBe('invalid_input');
    expect(reasonOf(() => parseRequestInput(validRequest({ message: 'x'.repeat(301) }), NOW_MS))).toBe('invalid_input');
    expect(reasonOf(() => parseRequestInput(validRequest({ providerId: 'a/b' }), NOW_MS))).toBe('invalid_input');
  });
});

describe('requestExpiresAtMs', () => {
  const ttl = { now: 15, scheduled: 720 };

  it('"agora" vence em ttl.now', () => {
    expect(requestExpiresAtMs(NOW_MS, null, ttl)).toBe(NOW_MS + 15 * MIN);
  });

  it('com horário: até o início, limitado a ttl.scheduled e nunca menos que ttl.now', () => {
    expect(requestExpiresAtMs(NOW_MS, NOW_MS + 2 * 60 * MIN, ttl)).toBe(NOW_MS + 2 * 60 * MIN);
    expect(requestExpiresAtMs(NOW_MS, NOW_MS + 48 * 60 * MIN, ttl)).toBe(NOW_MS + 720 * MIN);
    expect(requestExpiresAtMs(NOW_MS, NOW_MS + 5 * MIN, ttl)).toBe(NOW_MS + 15 * MIN);
  });
});

describe('parseTransitionInput', () => {
  it('só guarda motivo no cancelamento', () => {
    expect(parseTransitionInput('cancel', { sessionId: 's1', reason: ' imprevisto ' }).reason).toBe('imprevisto');
    expect(parseTransitionInput('accept', { sessionId: 's1', reason: 'x' }).reason).toBeNull();
    expect(reasonOf(() => parseTransitionInput('cancel', { sessionId: 's1', reason: 'x'.repeat(201) }))).toBe(
      'invalid_input',
    );
    expect(reasonOf(() => parseTransitionInput('accept', {}))).toBe('invalid_input');
  });
});

describe('sessões (emulador)', () => {
  let app: App;
  let db: Firestore;

  const request = (overrides: Record<string, unknown> = {}, uid = 'alice', now = NOW) =>
    createSessionRequest(db, uid, parseRequestInput(validRequest(overrides), now.toMillis()), now);
  const act = (action: SessionAction, uid: string, sessionId: string, now = NOW, reason?: string) =>
    transitionSession(db, uid, parseTransitionInput(action, { sessionId, reason }), now);
  const session = async (id: string) => (await db.doc(`sessions/${id}`).get()).data()!;
  const events = async (id: string) =>
    (await db.collection(`sessions/${id}/events`).get()).docs.map(d => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const messages = async (conversationId: string) =>
    (await db.collection(`conversations/${conversationId}/messages`).get()).docs.map(d => d.data());

  const seedUser = async (uid: string, fields: Record<string, unknown> = {}) => {
    await db.doc(`users/${uid}`).set({
      uid,
      displayName: uid === 'alice' ? 'Alice' : uid === 'bob' ? 'Bob' : uid,
      avatarUrl: null,
      status: 'active',
      companionStatus: 'approved',
      profileCompletedAt: NOW,
      ...fields,
    });
    await db.doc(`users/${uid}/private/data`).set({ rateLimit: { sessionRequestsWindowStart: null, sessionRequestsCount: 0 } });
    await db.doc(`users/${uid}/games/valorant`).set({ gameId: 'valorant' });
  };

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'sessions-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['users', 'listings', 'config', 'games', 'sessions', 'conversations']) {
      await db.recursiveDelete(db.collection(path));
    }
    await db.doc('config/app').set({
      sessionRequestTtlMinutes: { now: 15, scheduled: 720 },
      rateLimits: { sessionRequestsPerHour: 2 },
    });
    await db.doc('games/valorant').set({ id: 'valorant', name: 'Valorant', active: true });
    await db.doc('games/lol').set({ id: 'lol', name: 'LoL', active: true });
    await seedUser('alice');
    await seedUser('bob');
    await seedUser('carol');
  });

  describe('requestSession', () => {
    it('cria sessão, evento, conversa com mensagem de sistema e conta o pedido', async () => {
      const { sessionId, conversationId } = await request();
      const s = await session(sessionId);
      expect(s).toMatchObject({
        requesterId: 'alice',
        providerId: 'bob',
        participantIds: ['alice', 'bob'],
        status: 'requested',
        category: 'play_together',
        listedPriceCents: 0,
        durationMinutes: 60,
        message: 'Bora subir de elo?',
        conversationId,
        cancellation: null,
      });
      expect(s.scheduledEnd.toMillis()).toBe(NOW_MS + 60 * MIN);
      expect(s.requestExpiresAt.toMillis()).toBe(NOW_MS + 15 * MIN);
      expect(await events(sessionId)).toMatchObject([{ type: 'created', fromStatus: null, toStatus: 'requested', actorId: 'alice' }]);

      const conversation = (await db.doc(`conversations/${conversationId}`).get()).data()!;
      expect(conversation).toMatchObject({ type: 'session', sessionId, unread: { alice: 0, bob: 1 }, lockedAt: null });
      expect(conversation.lastMessage.text).toBe('Alice pediu uma sessão de Valorant.');
      expect(await messages(conversationId)).toMatchObject([{ type: 'system', systemEvent: 'session_requested', senderId: null }]);

      const priv = (await db.doc('users/alice/private/data').get()).data()!;
      expect(priv.rateLimit.sessionRequestsCount).toBe(1);
    });

    it('a partir de anúncio: congela preço, categoria e duração do anúncio', async () => {
      await db.doc('listings/l1').set({
        id: 'l1', ownerId: 'bob', gameId: 'valorant', category: 'coaching', priceCents: 3000, sessionMinutes: 90, active: true,
      });
      const { sessionId } = await request({ listingId: 'l1', durationMinutes: 30 });
      expect(await session(sessionId)).toMatchObject({ listingId: 'l1', category: 'coaching', listedPriceCents: 3000, durationMinutes: 90 });

      await db.doc('listings/l1').update({ active: false });
      await db.recursiveDelete(db.collection('sessions'));
      expect(await asyncReasonOf(request({ listingId: 'l1' }))).toBe('listing_unavailable');
      expect(await asyncReasonOf(request({ listingId: 'l1', providerId: 'carol' }))).toBe('listing_unavailable');
    });

    it('recusa pedir para si, jogador indisponível, bloqueio e jogo que a pessoa não joga', async () => {
      expect(await asyncReasonOf(request({ providerId: 'alice' }))).toBe('self_request');
      expect(await asyncReasonOf(request({ providerId: 'ghost' }))).toBe('provider_unavailable');
      expect(await asyncReasonOf(request({ gameId: 'lol' }))).toBe('game_not_offered');

      await db.doc('users/bob/blocks/alice').set({ blockedUid: 'alice' });
      expect(await asyncReasonOf(request())).toBe('blocked');
      await db.doc('users/bob/blocks/alice').delete();
      await db.doc('users/alice/blocks/bob').set({ blockedUid: 'bob' });
      expect(await asyncReasonOf(request())).toBe('blocked');

      await db.doc('users/carol').update({ status: 'banned' });
      expect(await asyncReasonOf(request({ providerId: 'carol' }))).toBe('provider_unavailable');
      expect(await asyncReasonOf(request({ providerId: 'bob' }, 'carol'))).toBe('account_restricted');
    });

    it('um pedido pendente por dupla e limite de pedidos por hora', async () => {
      await request();
      expect(await asyncReasonOf(request())).toBe('already_requested');
      await request({ providerId: 'carol' });
      // Limite 2/h (config do teste): o terceiro na mesma hora é recusado...
      await seedUser('dave');
      expect(await asyncReasonOf(request({ providerId: 'dave' }))).toBe('rate_limited');
      // ...e passa depois que a janela de 1 h vira.
      expect(await asyncReasonOf(request({ providerId: 'dave' }, 'alice', at(61 * MIN)))).toBeUndefined();
      const priv = (await db.doc('users/alice/private/data').get()).data()!;
      expect(priv.rateLimit.sessionRequestsCount).toBe(1);
    });
  });

  describe('transições', () => {
    it('aceitar: só o provider, antes do prazo, e avisa no chat', async () => {
      const { sessionId, conversationId } = await request();
      expect(await asyncReasonOf(act('accept', 'alice', sessionId))).toBe('not_allowed');
      expect(await asyncReasonOf(act('accept', 'carol', sessionId))).toBe('session_not_found');
      expect(await asyncReasonOf(act('accept', 'bob', sessionId, at(15 * MIN)))).toBe('request_expired');

      const result = await act('accept', 'bob', sessionId, at(5 * MIN));
      expect(result.status).toBe('accepted');
      const s = await session(sessionId);
      expect(s.respondedAt.toMillis()).toBe(NOW_MS + 5 * MIN);
      expect((await events(sessionId)).map(e => e.type)).toEqual(['created', 'accepted']);

      const conversation = (await db.doc(`conversations/${conversationId}`).get()).data()!;
      expect(conversation.unread).toEqual({ alice: 1, bob: 1 });
      expect(conversation.lastMessage.text).toBe('Bob aceitou a sessão.');
      expect(await messages(conversationId)).toHaveLength(2);

      expect(await asyncReasonOf(act('accept', 'bob', sessionId))).toBe('invalid_state');
    });

    it('recusar e cancelar (com motivo)', async () => {
      const first = await request();
      await act('decline', 'bob', first.sessionId);
      expect((await session(first.sessionId)).status).toBe('declined');
      expect(await asyncReasonOf(act('cancel', 'alice', first.sessionId))).toBe('invalid_state');

      const second = await request();
      await act('accept', 'bob', second.sessionId, at(1 * MIN));
      await act('cancel', 'alice', second.sessionId, at(2 * MIN), 'imprevisto');
      const s = await session(second.sessionId);
      expect(s.status).toBe('cancelled');
      expect(s.cancellation).toMatchObject({ by: 'alice', reason: 'imprevisto' });
      const last = (await events(second.sessionId)).at(-1)!;
      expect(last).toMatchObject({ type: 'cancelled', fromStatus: 'accepted', meta: { reason: 'imprevisto' } });
    });

    it('começar só perto do horário; terminar e confirmar dos dois lados conclui', async () => {
      const { sessionId, conversationId } = await request({ scheduledStartMs: NOW_MS + 60 * MIN });
      await act('accept', 'bob', sessionId, at(1 * MIN));
      expect(await asyncReasonOf(act('start', 'alice', sessionId, at(44 * MIN)))).toBe('too_early');
      await act('start', 'alice', sessionId, at(46 * MIN));
      expect((await session(sessionId)).status).toBe('in_progress');

      await act('markDone', 'bob', sessionId, at(120 * MIN));
      let s = await session(sessionId);
      expect(s.status).toBe('awaiting_confirmation');
      expect(s.confirmations.provider.toMillis()).toBe(NOW_MS + 120 * MIN);
      expect(s.confirmations.requester).toBeNull();

      // Quem marcou "terminamos" confirmar de novo não muda nada.
      expect((await act('confirm', 'bob', sessionId, at(121 * MIN))).status).toBe('awaiting_confirmation');
      expect((await events(sessionId)).map(e => e.type)).toEqual(['created', 'accepted', 'started', 'marked_done']);

      await act('confirm', 'alice', sessionId, at(125 * MIN));
      s = await session(sessionId);
      expect(s.status).toBe('completed');
      expect(s.completedAt.toMillis()).toBe(NOW_MS + 125 * MIN);
      const msgs = await messages(conversationId);
      expect(msgs.map(m => m.systemEvent).sort()).toEqual(['session_accepted', 'session_completed', 'session_requested']);
    });

    it('"não apareceu": só depois do horário, registra quem faltou', async () => {
      const { sessionId } = await request({ scheduledStartMs: NOW_MS + 30 * MIN });
      await act('accept', 'bob', sessionId);
      expect(await asyncReasonOf(act('reportNoShow', 'alice', sessionId, at(29 * MIN)))).toBe('too_early');
      await act('reportNoShow', 'alice', sessionId, at(40 * MIN));
      const s = await session(sessionId);
      expect(s.status).toBe('no_show');
      expect(s.noShow).toMatchObject({ reportedBy: 'alice', absentUid: 'bob' });
      expect(await asyncReasonOf(act('cancel', 'alice', sessionId))).toBe('invalid_state');
    });
  });
});
