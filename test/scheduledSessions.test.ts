// Testes das funções agendadas de sessão contra o emulador do Firestore
// (`npm test`). As sessões são gravadas direto, com horários relativos a NOW.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autoAdvanceSessions, autoCompleteSessions, expireSessionRequests } from '../functions/src/sessions/scheduled.js';

const NOW_MS = Date.parse('2026-11-10T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (offsetMs: number) => Timestamp.fromMillis(NOW_MS + offsetMs);

describe('funções agendadas de sessão (emulador)', () => {
  let app: App;
  let db: Firestore;

  const seedSession = async (id: string, fields: Record<string, unknown>) => {
    await db.doc(`sessions/${id}`).set({
      id,
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      conversationId: `c_${id}`,
      status: 'requested',
      scheduledStart: at(60 * MIN),
      scheduledEnd: at(120 * MIN),
      requestExpiresAt: at(15 * MIN),
      startedAt: null,
      endedAt: null,
      completedAt: null,
      confirmations: { requester: null, provider: null },
      ...fields,
    });
    await db.doc(`conversations/c_${id}`).set({ id: `c_${id}`, participantIds: ['alice', 'bob'], unread: { alice: 0, bob: 1 } });
  };
  const session = async (id: string) => (await db.doc(`sessions/${id}`).get()).data()!;
  const events = async (id: string) => (await db.collection(`sessions/${id}/events`).get()).docs.map(d => d.data());
  const messages = async (id: string) => (await db.collection(`conversations/c_${id}/messages`).get()).docs.map(d => d.data());

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'scheduled-sessions-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['sessions', 'conversations', 'config']) {
      await db.recursiveDelete(db.collection(path));
    }
  });

  describe('expireSessionRequests', () => {
    it('expira só pedidos vencidos, com evento automático e aviso no chat', async () => {
      await seedSession('vencido', { requestExpiresAt: at(-1 * MIN) });
      await seedSession('no_prazo', { requestExpiresAt: at(5 * MIN) });
      await seedSession('aceito', { status: 'accepted', requestExpiresAt: at(-30 * MIN) });

      expect(await expireSessionRequests(db, NOW)).toBe(1);
      expect((await session('vencido')).status).toBe('expired');
      expect((await session('no_prazo')).status).toBe('requested');
      expect((await session('aceito')).status).toBe('accepted');

      expect(await events('vencido')).toMatchObject([{ type: 'expired', fromStatus: 'requested', toStatus: 'expired', actorId: null }]);
      expect(await messages('vencido')).toMatchObject([{ type: 'system', systemEvent: 'session_expired' }]);
      // Evento automático: ninguém "causou", os dois ganham não lida.
      expect((await db.doc('conversations/c_vencido').get()).get('unread')).toEqual({ alice: 1, bob: 2 });

      expect(await expireSessionRequests(db, NOW)).toBe(0);
    });

    it('pagina quando há mais vencidos que uma página', async () => {
      const batch = db.batch();
      for (let i = 0; i < 120; i++) {
        batch.set(db.doc(`sessions/s${i}`), {
          status: 'requested',
          requestExpiresAt: at(-MIN),
          participantIds: ['alice', 'bob'],
          conversationId: `c_s${i}`,
        });
        batch.set(db.doc(`conversations/c_s${i}`), { id: `c_s${i}`, participantIds: ['alice', 'bob'], unread: {} });
      }
      await batch.commit();
      expect(await expireSessionRequests(db, NOW)).toBe(120);
    });
  });

  describe('autoAdvanceSessions', () => {
    it('começa as aceitas cujo horário chegou e termina as que passaram do fim', async () => {
      await seedSession('chegou', { status: 'accepted', scheduledStart: at(-1 * MIN), scheduledEnd: at(59 * MIN) });
      await seedSession('futura', { status: 'accepted', scheduledStart: at(10 * MIN), scheduledEnd: at(70 * MIN) });
      await seedSession('acabou', {
        status: 'in_progress', scheduledStart: at(-2 * HOUR), scheduledEnd: at(-1 * HOUR), startedAt: at(-2 * HOUR),
      });
      // Aceita e nunca iniciada, com o fim já passado: começa e termina na mesma execução.
      await seedSession('esquecida', { status: 'accepted', scheduledStart: at(-3 * HOUR), scheduledEnd: at(-2 * HOUR) });

      expect(await autoAdvanceSessions(db, NOW)).toEqual({ started: 2, ended: 2 });

      const chegou = await session('chegou');
      expect(chegou.status).toBe('in_progress');
      expect(chegou.startedAt.toMillis()).toBe(NOW_MS);
      expect((await session('futura')).status).toBe('accepted');

      const acabou = await session('acabou');
      expect(acabou.status).toBe('awaiting_confirmation');
      expect(acabou.endedAt.toMillis()).toBe(NOW_MS);
      expect(acabou.confirmations).toEqual({ requester: null, provider: null });
      expect(await events('acabou')).toMatchObject([{ type: 'marked_done', actorId: null }]);
      // Começar/terminar não geram mensagem no chat.
      expect(await messages('acabou')).toHaveLength(0);

      expect((await session('esquecida')).status).toBe('awaiting_confirmation');
      expect((await events('esquecida')).map(e => e.type).sort()).toEqual(['marked_done', 'started']);
    });
  });

  describe('autoCompleteSessions', () => {
    it('conclui depois de autoCompleteAfterHours sem objeção', async () => {
      await seedSession('antiga', { status: 'awaiting_confirmation', endedAt: at(-25 * HOUR) });
      await seedSession('recente', { status: 'awaiting_confirmation', endedAt: at(-23 * HOUR) });
      await seedSession('meio_confirmada', {
        status: 'awaiting_confirmation', endedAt: at(-30 * HOUR), confirmations: { requester: at(-29 * HOUR), provider: null },
      });

      expect(await autoCompleteSessions(db, NOW)).toBe(2);
      const antiga = await session('antiga');
      expect(antiga.status).toBe('completed');
      expect(antiga.completedAt.toMillis()).toBe(NOW_MS);
      expect((await session('meio_confirmada')).status).toBe('completed');
      expect((await session('recente')).status).toBe('awaiting_confirmation');
      expect(await events('antiga')).toMatchObject([{ type: 'auto_completed', actorId: null, toStatus: 'completed' }]);
      expect(await messages('antiga')).toMatchObject([{ systemEvent: 'session_completed' }]);
    });

    it('usa o prazo de config/app', async () => {
      await db.doc('config/app').set({ autoCompleteAfterHours: 48 });
      await seedSession('antiga', { status: 'awaiting_confirmation', endedAt: at(-25 * HOUR) });
      expect(await autoCompleteSessions(db, NOW)).toBe(0);
      expect(await autoCompleteSessions(db, at(24 * HOUR))).toBe(1);
    });
  });
});
