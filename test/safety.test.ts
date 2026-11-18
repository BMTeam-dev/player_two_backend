// Testes de bloquear e denunciar (tarefa 31): validação dos payloads (puro)
// e as transactions contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionPushes } from '../functions/src/notifications/sessionPushes.js';
import { blockUser, parseTargetUid, unblockUser } from '../functions/src/safety/block.js';
import { parseReportInput, priorityOf, submitReport } from '../functions/src/safety/report.js';
import { computeStats } from '../functions/src/stats/stats.js';
import type { Session } from '../functions/src/types.js';

const NOW_MS = Date.parse('2026-11-18T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const HOUR = 60 * 60_000;
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

describe('parseTargetUid', () => {
  it('recusa id inválido e a si mesmo', () => {
    expect(parseTargetUid('alice', { targetUid: 'bob' })).toBe('bob');
    expect(reasonOf(() => parseTargetUid('alice', { targetUid: 'a/b' }))).toBe('invalid_input');
    expect(reasonOf(() => parseTargetUid('alice', {}))).toBe('invalid_input');
    expect(reasonOf(() => parseTargetUid('alice', { targetUid: 'alice' }))).toBe('self_target');
  });
});

describe('parseReportInput', () => {
  const base = { targetType: 'user', targetId: 'bob', reason: 'harassment' };

  it('normaliza detalhes e mensagens', () => {
    expect(parseReportInput({ ...base, details: '  me xingou  ', conversationId: 'c1', messageIds: ['m1', 'm1', 'm2'] })).toEqual({
      targetType: 'user',
      targetId: 'bob',
      reason: 'harassment',
      details: 'me xingou',
      conversationId: 'c1',
      messageIds: ['m1', 'm2'],
    });
    expect(parseReportInput({ ...base, details: '   ' })).toMatchObject({ details: null, conversationId: null, messageIds: [] });
  });

  it('recusa alvo, motivo e evidência inválidos', () => {
    expect(reasonOf(() => parseReportInput({ ...base, targetType: 'lfg_post' }))).toBe('invalid_input');
    expect(reasonOf(() => parseReportInput({ ...base, reason: 'feio' }))).toBe('invalid_input');
    expect(reasonOf(() => parseReportInput({ ...base, details: 'x'.repeat(1001) }))).toBe('invalid_input');
    expect(reasonOf(() => parseReportInput({ ...base, reason: 'other' }))).toBe('invalid_input');
    expect(reasonOf(() => parseReportInput({ ...base, targetType: 'message', targetId: 'm1' }))).toBe('invalid_input');
    expect(reasonOf(() => parseReportInput({ ...base, messageIds: ['m1'] }))).toBe('invalid_input');
    const many = Array.from({ length: 21 }, (_, i) => `m${i}`);
    expect(reasonOf(() => parseReportInput({ ...base, conversationId: 'c1', messageIds: many }))).toBe('invalid_input');
  });

  it('prioridade: golpe, conteúdo sexual e menor de idade são alta; spam é baixa', () => {
    expect(priorityOf('fraud')).toBe('high');
    expect(priorityOf('underage')).toBe('high');
    expect(priorityOf('sexual_content')).toBe('high');
    expect(priorityOf('spam')).toBe('low');
    expect(priorityOf('harassment')).toBe('normal');
    expect(priorityOf('other')).toBe('normal');
  });
});

describe('push de sessão cancelada por bloqueio', () => {
  it('não avisa ninguém', () => {
    const before = { id: 's1', requesterId: 'alice', providerId: 'bob', participantSnapshots: {}, status: 'accepted', cancellation: null };
    const after = { ...before, status: 'cancelled', cancellation: { by: null, reason: null, at: NOW, fromStatus: 'accepted' } };
    expect(sessionPushes(before as unknown as Session, after as unknown as Session, 'Valorant')).toEqual([]);
  });
});

describe('bloquear e denunciar (emulador)', () => {
  let app: App;
  let db: Firestore;

  const seedSession = async (id: string, fields: Record<string, unknown> = {}) => {
    await db.doc(`sessions/${id}`).set({
      id,
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      conversationId: `c_${id}`,
      status: 'requested',
      cancellation: null,
      noShow: null,
      ...fields,
    });
    const participants = (fields.participantIds as string[] | undefined) ?? ['alice', 'bob'];
    await db.doc(`conversations/c_${id}`).set({ id: `c_${id}`, participantIds: participants, lockedAt: null, lockedReason: null });
  };
  const get = async (path: string) => (await db.doc(path).get()).data();
  const report = (uid: string, data: Record<string, unknown>, now = NOW) => submitReport(db, uid, parseReportInput(data), now);

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'safety-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(
      ['users', 'sessions', 'conversations', 'reports', 'reviews', 'listings', 'config'].map(c => db.recursiveDelete(db.collection(c))),
    );
    for (const uid of ['alice', 'bob', 'carol']) {
      await db.doc(`users/${uid}`).set({ uid, displayName: uid, status: 'active' });
    }
  });

  describe('blockUser', () => {
    it('grava o bloqueio, tranca as conversas e cancela só o que não começou', async () => {
      await seedSession('requested');
      await seedSession('accepted', { status: 'accepted', requesterId: 'bob', providerId: 'alice' });
      await seedSession('in_progress', { status: 'in_progress' });
      await seedSession('completed', { status: 'completed' });
      await seedSession('other', { providerId: 'carol', participantIds: ['alice', 'carol'] });

      expect(await blockUser(db, 'alice', 'bob', NOW)).toEqual({ locked: 4, cancelled: 2 });

      expect(await get('users/alice/blocks/bob')).toMatchObject({ blockedUid: 'bob' });
      for (const id of ['requested', 'accepted', 'in_progress', 'completed']) {
        expect(await get(`conversations/c_${id}`)).toMatchObject({ lockedReason: 'block' });
      }
      expect((await get('conversations/c_other'))!.lockedAt).toBeNull();

      expect(await get('sessions/requested')).toMatchObject({
        status: 'cancelled',
        cancellation: { by: null, reason: null, fromStatus: 'requested' },
      });
      expect(await get('sessions/accepted')).toMatchObject({ status: 'cancelled', cancellation: { by: null, fromStatus: 'accepted' } });
      expect((await get('sessions/in_progress'))!.status).toBe('in_progress');
      expect((await get('sessions/completed'))!.status).toBe('completed');
      expect((await get('sessions/other'))!.status).toBe('requested');

      const events = (await db.collection('sessions/accepted/events').get()).docs.map(d => d.data());
      expect(events).toMatchObject([{ type: 'cancelled', fromStatus: 'accepted', actorId: null }]);
    });

    it('cancelar por bloqueio não pesa na taxa de conclusão de ninguém', async () => {
      await seedSession('accepted', { status: 'accepted' });
      await blockUser(db, 'alice', 'bob', NOW);
      expect((await computeStats(db, 'alice')).completionRate).toBe(1);
      expect((await computeStats(db, 'bob')).completionRate).toBe(1);
    });

    it('bloquear de novo não muda nada; jogador inexistente é recusado', async () => {
      await seedSession('requested');
      await blockUser(db, 'alice', 'bob', NOW);
      expect(await blockUser(db, 'alice', 'bob', at(HOUR))).toEqual({ locked: 0, cancelled: 0 });
      expect((await get('users/alice/blocks/bob'))!.createdAt.toMillis()).toBe(NOW_MS);
      expect(await asyncReasonOf(blockUser(db, 'alice', 'ghost', NOW))).toBe('user_not_found');
    });

    it('desbloquear apaga o bloqueio, mas a conversa continua trancada', async () => {
      await seedSession('requested');
      await blockUser(db, 'alice', 'bob', NOW);
      await unblockUser(db, 'alice', 'bob');
      expect(await get('users/alice/blocks/bob')).toBeUndefined();
      expect((await get('conversations/c_requested'))!.lockedReason).toBe('block');
    });
  });

  describe('submitReport', () => {
    beforeEach(async () => {
      await seedSession('s1', { status: 'completed' });
      await db.doc('conversations/c_s1/messages/m1').set({ id: 'm1', senderId: 'bob', type: 'text', text: 'ofensa' });
      await db.doc('conversations/c_s1/messages/m2').set({ id: 'm2', senderId: 'bob', type: 'text', text: 'outra' });
      await db.doc('conversations/c_s1/messages/sys').set({ id: 'sys', senderId: null, type: 'system', text: 'Sessão concluída.' });
    });

    it('usuário, com evidência do chat e prioridade alta', async () => {
      const created = await report('alice', {
        targetType: 'user',
        targetId: 'bob',
        reason: 'fraud',
        details: 'Pediu Pix e sumiu',
        conversationId: 'c_s1',
        messageIds: ['m1'],
      });
      expect(await get(`reports/${created.id}`)).toMatchObject({
        reporterId: 'alice',
        targetType: 'user',
        targetId: 'bob',
        targetUserId: 'bob',
        reason: 'fraud',
        details: 'Pediu Pix e sumiu',
        evidence: { conversationId: 'c_s1', messageIds: ['m1'] },
        status: 'open',
        priority: 'high',
        resolution: null,
      });
      expect((await get('users/alice/private/data'))!.rateLimit.reportsCount).toBe(1);
    });

    it('mensagem: o autor vem do servidor e a mensagem entra na evidência', async () => {
      const created = await report('alice', { targetType: 'message', targetId: 'm1', reason: 'harassment', conversationId: 'c_s1', messageIds: ['m2'] });
      expect(created).toMatchObject({ targetUserId: 'bob', evidence: { conversationId: 'c_s1', messageIds: ['m1', 'm2'] } });
    });

    it('mensagem de sistema, mensagem própria e conversa alheia são recusadas', async () => {
      const msg = (uid: string, targetId: string) => report(uid, { targetType: 'message', targetId, reason: 'spam', conversationId: 'c_s1' });
      expect(await asyncReasonOf(msg('alice', 'sys'))).toBe('target_not_found');
      expect(await asyncReasonOf(msg('bob', 'm1'))).toBe('self_target');
      expect(await asyncReasonOf(msg('carol', 'm1'))).toBe('evidence_not_found');
    });

    it('sessão: só participante; o alvo é o outro lado e a conversa vira evidência', async () => {
      const created = await report('bob', { targetType: 'session', targetId: 's1', reason: 'toxicity' });
      expect(created).toMatchObject({ targetUserId: 'alice', evidence: { conversationId: 'c_s1', messageIds: [] } });
      expect(await asyncReasonOf(report('carol', { targetType: 'session', targetId: 's1', reason: 'toxicity' }))).toBe(
        'target_not_found',
      );
    });

    it('avaliação: visível ou do próprio autor; o alvo é quem escreveu', async () => {
      await db.doc('reviews/r1').set({ id: 'r1', authorId: 'bob', targetId: 'alice', visible: true });
      await db.doc('reviews/r2').set({ id: 'r2', authorId: 'bob', targetId: 'alice', visible: false });
      expect(await report('carol', { targetType: 'review', targetId: 'r1', reason: 'hate_speech' })).toMatchObject({
        targetUserId: 'bob',
      });
      // Cega: nem o avaliado sabe que existe.
      expect(await asyncReasonOf(report('alice', { targetType: 'review', targetId: 'r2', reason: 'hate_speech' }))).toBe(
        'target_not_found',
      );
    });

    it('anúncio: o alvo é o dono', async () => {
      await db.doc('listings/l1').set({ id: 'l1', ownerId: 'bob' });
      expect(await report('carol', { targetType: 'listing', targetId: 'l1', reason: 'boosting_or_account_sharing' })).toMatchObject({
        targetUserId: 'bob',
        priority: 'normal',
      });
    });

    it('recusa a si mesmo, usuário inexistente e evidência de conversa com outra pessoa', async () => {
      expect(await asyncReasonOf(report('alice', { targetType: 'user', targetId: 'alice', reason: 'spam' }))).toBe('self_target');
      expect(await asyncReasonOf(report('alice', { targetType: 'user', targetId: 'ghost', reason: 'spam' }))).toBe('target_not_found');
      expect(
        await asyncReasonOf(report('alice', { targetType: 'user', targetId: 'carol', reason: 'spam', conversationId: 'c_s1', messageIds: ['m1'] })),
      ).toBe('evidence_not_found');
      expect(
        await asyncReasonOf(report('alice', { targetType: 'user', targetId: 'bob', reason: 'spam', conversationId: 'c_s1', messageIds: ['nope'] })),
      ).toBe('evidence_not_found');
      expect(await asyncReasonOf(report('ghost', { targetType: 'user', targetId: 'bob', reason: 'spam' }))).toBe('no_profile');
    });

    it('limite por dia, com a janela de 24 h e o valor de config/app', async () => {
      await db.doc('config/app').set({ rateLimits: { reportsPerDay: 2 } });
      const send = (now: Timestamp) => report('alice', { targetType: 'user', targetId: 'bob', reason: 'spam' }, now);
      await send(NOW);
      await send(at(HOUR));
      expect(await asyncReasonOf(send(at(2 * HOUR)))).toBe('rate_limited');
      expect((await db.collection('reports').get()).size).toBe(2);
      await send(at(24 * HOUR)); // a janela abriu em NOW e já passou
      expect((await get('users/alice/private/data'))!.rateLimit.reportsCount).toBe(1);
    });
  });
});
