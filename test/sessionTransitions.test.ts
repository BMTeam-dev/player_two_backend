// Testes da máquina de estados da sessão (tarefa 28), contra o emulador do
// Firestore (`npm test`). Os casos a caso de cada callable estão em
// sessions.test.ts e os das agendadas em scheduledSessions.test.ts; aqui ficam:
// - a matriz completa estado × ação × quem age, contra uma tabela escrita à
//   mão a partir do MVP.md 6.1 (não contra `RULES`, senão o teste só
//   repetiria o código);
// - que uma transição recusada não grava nada;
// - corridas entre duas pessoas, e entre uma pessoa e uma função agendada;
// - jornadas inteiras, com a cadeia de eventos coerente.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSessionRequest, parseRequestInput } from '../functions/src/sessions/request.js';
import { autoAdvanceSessions, autoCompleteSessions, expireSessionRequests } from '../functions/src/sessions/scheduled.js';
import { parseTransitionInput, transitionSession, type SessionAction } from '../functions/src/sessions/transitions.js';
import type { SessionStatus } from '../functions/src/types.js';

const NOW_MS = Date.parse('2026-11-10T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (offsetMs: number) => Timestamp.fromMillis(NOW_MS + offsetMs);

const STATUSES: SessionStatus[] = [
  'requested',
  'declined',
  'expired',
  'accepted',
  'in_progress',
  'awaiting_confirmation',
  'completed',
  'cancelled',
  'no_show',
];
const ACTIONS: SessionAction[] = ['accept', 'decline', 'cancel', 'start', 'markDone', 'confirm', 'reportNoShow'];
type Role = 'requester' | 'provider';
const UID: Record<Role, string> = { requester: 'alice', provider: 'bob' };

// MVP.md 6.1, mais as decisões da tarefa 22 (decisions.md): "não apareceu"
// também em awaiting_confirmation. Quem age errado recebe `not_allowed`
// antes de olhar o estado; estado errado, `invalid_state`.
const EXPECTED: Record<SessionAction, { actors: Role[]; from: Partial<Record<SessionStatus, SessionStatus>> }> = {
  accept: { actors: ['provider'], from: { requested: 'accepted' } },
  decline: { actors: ['provider'], from: { requested: 'declined' } },
  cancel: { actors: ['requester', 'provider'], from: { requested: 'cancelled', accepted: 'cancelled' } },
  start: { actors: ['requester', 'provider'], from: { accepted: 'in_progress' } },
  markDone: { actors: ['requester', 'provider'], from: { in_progress: 'awaiting_confirmation' } },
  // Um lado só: continua aguardando o outro.
  confirm: { actors: ['requester', 'provider'], from: { awaiting_confirmation: 'awaiting_confirmation' } },
  reportNoShow: {
    actors: ['requester', 'provider'],
    from: { accepted: 'no_show', in_progress: 'no_show', awaiting_confirmation: 'no_show' },
  },
};

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason ?? String(e);
  }
  return undefined;
};

describe('máquina de estados da sessão (emulador)', () => {
  let app: App;
  let db: Firestore;

  // Horários em que todas as condições de tempo passam: o pedido ainda está
  // no prazo e o horário de início já chegou.
  const seedSession = async (id: string, fields: Record<string, unknown> = {}) => {
    const data = {
      id,
      requesterId: 'alice',
      providerId: 'bob',
      participantIds: ['alice', 'bob'],
      participantSnapshots: { alice: { displayName: 'Alice', avatarUrl: null }, bob: { displayName: 'Bob', avatarUrl: null } },
      conversationId: `c_${id}`,
      gameId: 'valorant',
      status: 'requested',
      listedPriceCents: 0,
      scheduledStart: at(-10 * MIN),
      scheduledEnd: at(50 * MIN),
      requestExpiresAt: at(10 * MIN),
      respondedAt: null,
      startedAt: null,
      endedAt: null,
      completedAt: null,
      confirmations: { requester: null, provider: null },
      cancellation: null,
      noShow: null,
      updatedAt: at(-HOUR),
      ...fields,
    };
    await db.doc(`sessions/${id}`).set(data);
    await db.doc(`conversations/c_${id}`).set({ id: `c_${id}`, participantIds: ['alice', 'bob'], unread: { alice: 0, bob: 0 } });
  };
  const act = (action: SessionAction, uid: string, sessionId: string, now = NOW) =>
    transitionSession(db, uid, parseTransitionInput(action, { sessionId }), now);
  const read = async (id: string) => (await db.doc(`sessions/${id}`).get()).data()!;
  const events = async (id: string) =>
    (await db.collection(`sessions/${id}/events`).get()).docs.map(d => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const messages = async (id: string) => (await db.collection(`conversations/c_${id}/messages`).get()).docs.map(d => d.data());

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'session-transitions-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['users', 'config', 'games', 'sessions', 'conversations']) {
      await db.recursiveDelete(db.collection(path));
    }
  });

  describe('matriz estado × ação × quem age', () => {
    const cases = STATUSES.flatMap(status =>
      ACTIONS.flatMap(action => (['requester', 'provider'] as Role[]).map(role => ({ status, action, role }))),
    );

    it(`as ${cases.length} combinações seguem a tabela do MVP, e a recusada não grava nada`, async () => {
      const idOf = (c: (typeof cases)[number]) => `${c.status}-${c.action}-${c.role}`;
      for (const c of cases) {
        await seedSession(idOf(c), { status: c.status });
      }

      const failures: string[] = [];
      // Sessões diferentes não disputam documentos: em blocos, para o teste não demorar.
      for (let i = 0; i < cases.length; i += 14) {
        await Promise.all(
          cases.slice(i, i + 14).map(async c => {
            const id = idOf(c);
            const before = await read(id);
            const rule = EXPECTED[c.action];
            const expectedTo = rule.from[c.status];
            const expectedReason = !rule.actors.includes(c.role) ? 'not_allowed' : expectedTo ? undefined : 'invalid_state';

            const reason = await reasonOf(act(c.action, UID[c.role], id));
            const after = await read(id);
            const evts = await events(id);

            if (reason !== expectedReason) {
              failures.push(`${id}: esperado ${expectedReason ?? 'ok'}, veio ${reason ?? 'ok'}`);
              return;
            }
            if (expectedReason) {
              if (JSON.stringify(after) !== JSON.stringify(before) || evts.length > 0 || (await messages(id)).length > 0) {
                failures.push(`${id}: recusada, mas gravou alguma coisa`);
              }
              return;
            }
            if (after.status !== expectedTo) {
              failures.push(`${id}: foi para ${after.status}, esperado ${expectedTo}`);
            }
            if (evts.length !== 1 || evts[0].fromStatus !== c.status || evts[0].toStatus !== expectedTo || evts[0].actorId !== UID[c.role]) {
              failures.push(`${id}: evento de auditoria errado ${JSON.stringify(evts)}`);
            }
            if (after.updatedAt.toMillis() !== NOW_MS) {
              failures.push(`${id}: updatedAt não mudou`);
            }
          }),
        );
      }
      expect(failures).toEqual([]);
    });

    it('quem não participa recebe "sessão não encontrada" em qualquer ação e estado, como uma sessão que não existe', async () => {
      for (const status of STATUSES) {
        await seedSession(`s_${status}`, { status });
      }
      for (const status of STATUSES) {
        for (const action of ACTIONS) {
          expect(await reasonOf(act(action, 'carol', `s_${status}`))).toBe('session_not_found');
        }
      }
      expect(await reasonOf(act('accept', 'bob', 'nao_existe'))).toBe('session_not_found');
      expect(await read('s_requested')).toMatchObject({ status: 'requested', updatedAt: at(-HOUR) });
    });

    it('estados finais não saem do lugar nem pelas funções agendadas', async () => {
      const finals: SessionStatus[] = ['declined', 'expired', 'completed', 'cancelled', 'no_show'];
      // Tudo vencido: se alguma agendada olhasse só o horário, mexeria aqui.
      for (const status of finals) {
        await seedSession(status, {
          status,
          requestExpiresAt: at(-2 * HOUR),
          scheduledStart: at(-3 * HOUR),
          scheduledEnd: at(-2 * HOUR),
          endedAt: at(-48 * HOUR),
        });
      }
      await expireSessionRequests(db, NOW);
      await autoAdvanceSessions(db, NOW);
      await autoCompleteSessions(db, NOW);
      for (const status of finals) {
        expect((await read(status)).status).toBe(status);
        expect(await events(status)).toEqual([]);
      }
    });
  });

  describe('condições de tempo e de confirmação', () => {
    it('aceitar vence junto com o prazo, mesmo antes da expiração agendada passar', async () => {
      await seedSession('s', { requestExpiresAt: at(0) });
      expect(await reasonOf(act('accept', 'bob', 's', at(-1)))).toBeUndefined();
      await seedSession('t', { requestExpiresAt: at(0) });
      expect(await reasonOf(act('accept', 'bob', 't', at(0)))).toBe('request_expired');
      // Recusar e cancelar depois do prazo ainda valem: encerram o pedido do mesmo jeito.
      expect(await reasonOf(act('decline', 'bob', 't', at(MIN)))).toBeUndefined();
    });

    it('"começar" abre 15 min antes do horário; "não apareceu" só a partir do horário, também em andamento', async () => {
      await seedSession('cedo', { status: 'accepted', scheduledStart: at(16 * MIN) });
      expect(await reasonOf(act('start', 'alice', 'cedo'))).toBe('too_early');
      expect(await reasonOf(act('start', 'alice', 'cedo', at(MIN)))).toBeUndefined();
      // Começou antes do horário: até lá, ainda não dá para dizer que o outro faltou.
      expect(await reasonOf(act('reportNoShow', 'bob', 'cedo', at(2 * MIN)))).toBe('too_early');
      expect(await reasonOf(act('reportNoShow', 'bob', 'cedo', at(16 * MIN)))).toBeUndefined();
      expect(await read('cedo')).toMatchObject({ noShow: { reportedBy: 'bob', absentUid: 'alice' } });
    });

    it('confirmar duas vezes não grava de novo; quem confirmou não pode mais dizer "não apareceu"', async () => {
      await seedSession('s', { status: 'awaiting_confirmation', endedAt: at(-MIN) });
      await act('confirm', 'alice', 's');
      await act('confirm', 'alice', 's', at(MIN));
      expect(await events('s')).toHaveLength(1);
      expect((await read('s')).confirmations.requester.toMillis()).toBe(NOW_MS);
      expect(await reasonOf(act('reportNoShow', 'alice', 's'))).toBe('invalid_state');
      // O outro lado ainda pode objetar.
      expect(await reasonOf(act('reportNoShow', 'bob', 's'))).toBeUndefined();
    });

    it('"terminamos" já confirma o lado de quem tocou: basta o outro confirmar', async () => {
      await seedSession('s', { status: 'in_progress', startedAt: at(-30 * MIN) });
      await act('markDone', 'bob', 's');
      expect(await reasonOf(act('confirm', 'bob', 's'))).toBeUndefined();
      expect((await read('s')).status).toBe('awaiting_confirmation');
      await act('confirm', 'alice', 's', at(MIN));
      expect(await read('s')).toMatchObject({ status: 'completed', completedAt: at(MIN) });
    });
  });

  describe('corridas', () => {
    // Rodadas repetidas: a ordem em que as transactions chegam varia.
    const ROUNDS = 3;

    it('aceitar e recusar ao mesmo tempo (dois aparelhos do provider): só um passa', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const id = `s${round}`;
        await seedSession(id);
        const [accept, decline] = await Promise.allSettled([act('accept', 'bob', id), act('decline', 'bob', id)]);
        expect([accept, decline].filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const status = (await read(id)).status;
        expect(status).toBe(accept.status === 'fulfilled' ? 'accepted' : 'declined');
        expect((await events(id)).map(e => e.toStatus)).toEqual([status]);
        expect(await messages(id)).toHaveLength(1);
      }
    });

    it('aceitar e cancelar ao mesmo tempo: sempre termina cancelada, com o histórico na ordem', async () => {
      // Se o aceite chega antes, o cancelamento ainda vale (aceita pode ser
      // cancelada); se chega depois, o aceite é recusado. Nos dois casos o
      // pedido de quem cancelou é respeitado.
      for (let round = 0; round < ROUNDS; round++) {
        const id = `s${round}`;
        await seedSession(id);
        const [accept, cancel] = await Promise.allSettled([act('accept', 'bob', id), act('cancel', 'alice', id)]);
        expect(cancel.status).toBe('fulfilled');
        expect((await read(id)).status).toBe('cancelled');
        // Os dois eventos têm o mesmo `at` (o mesmo NOW): compara sem a ordem.
        const chain = (await events(id)).map(e => `${e.fromStatus}>${e.toStatus}`).sort();
        expect(chain).toEqual(accept.status === 'fulfilled' ? ['accepted>cancelled', 'requested>accepted'] : ['requested>cancelled']);
      }
    });

    it('os dois confirmam ao mesmo tempo: conclui uma vez, com uma mensagem de conclusão', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const id = `s${round}`;
        await seedSession(id, { status: 'awaiting_confirmation', endedAt: at(-MIN) });
        await Promise.all([act('confirm', 'alice', id), act('confirm', 'bob', id)]);
        const session = await read(id);
        expect(session.status).toBe('completed');
        expect(session.confirmations.requester).not.toBeNull();
        expect(session.confirmations.provider).not.toBeNull();
        expect((await events(id)).map(e => e.toStatus).sort()).toEqual(['awaiting_confirmation', 'completed']);
        expect((await messages(id)).filter(m => m.systemEvent === 'session_completed')).toHaveLength(1);
      }
    });

    it('aceitar no último instante e a expiração agendada: só um passa', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const id = `s${round}`;
        await seedSession(id, { requestExpiresAt: at(0) });
        const [accept] = await Promise.allSettled([act('accept', 'bob', id, at(-1)), expireSessionRequests(db, at(0))]);
        const status = (await read(id)).status;
        expect(status).toBe(accept.status === 'fulfilled' ? 'accepted' : 'expired');
        expect(await events(id)).toHaveLength(1);
      }
    });

    it('"não apareceu" e a conclusão automática: só um passa', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const id = `s${round}`;
        await seedSession(id, { status: 'awaiting_confirmation', endedAt: at(-25 * HOUR) });
        const [noShow] = await Promise.allSettled([act('reportNoShow', 'alice', id), autoCompleteSessions(db, NOW)]);
        const status = (await read(id)).status;
        expect(status).toBe(noShow.status === 'fulfilled' ? 'no_show' : 'completed');
        expect(await events(id)).toHaveLength(1);
      }
    });

    it('"começar" e o início automático: termina em andamento com um evento só', async () => {
      await seedSession('s', { status: 'accepted' });
      await Promise.allSettled([act('start', 'alice', 's'), autoAdvanceSessions(db, NOW)]);
      expect((await read('s')).status).toBe('in_progress');
      expect((await events('s')).map(e => e.toStatus)).toEqual(['in_progress']);
    });
  });

  describe('jornadas', () => {
    const seedUsers = async () => {
      await db.doc('config/app').set({ sessionRequestTtlMinutes: { now: 15, scheduled: 720 }, rateLimits: { sessionRequestsPerHour: 5 } });
      await db.doc('games/valorant').set({ id: 'valorant', name: 'Valorant', active: true });
      for (const [uid, name] of [['alice', 'Alice'], ['bob', 'Bob']]) {
        await db.doc(`users/${uid}`).set({ uid, displayName: name, avatarUrl: null, status: 'active', companionStatus: 'approved', profileCompletedAt: NOW });
        await db.doc(`users/${uid}/private/data`).set({ rateLimit: { sessionRequestsWindowStart: null, sessionRequestsCount: 0 } });
        await db.doc(`users/${uid}/games/valorant`).set({ gameId: 'valorant' });
      }
    };
    const request = async (scheduledStartMs: number | null) => {
      const input = { providerId: 'bob', gameId: 'valorant', scheduledStartMs, durationMinutes: 60, message: null };
      return (await createSessionRequest(db, 'alice', parseRequestInput(input, NOW_MS), NOW)).sessionId as string;
    };
    // Cada evento sai de onde o anterior chegou: nada de pulo nem de estado repetido fora do `confirm`.
    const chainOf = async (id: string) => {
      const evts = await events(id);
      for (let i = 1; i < evts.length; i++) {
        expect(evts[i].fromStatus).toBe(evts[i - 1].toStatus);
      }
      return evts.map(e => `${e.type}:${e.actorId ?? 'auto'}`);
    };

    it('pedido agendado → aceito → começa e termina pelo horário → conclusão automática', async () => {
      await seedUsers();
      const id = await request(NOW_MS + HOUR);
      await act('accept', 'bob', id, at(MIN));
      expect(await autoAdvanceSessions(db, at(HOUR))).toEqual({ started: 1, ended: 0 });
      expect(await autoAdvanceSessions(db, at(2 * HOUR))).toEqual({ started: 0, ended: 1 });
      expect(await autoCompleteSessions(db, at(25 * HOUR))).toBe(0);
      expect(await autoCompleteSessions(db, at(26 * HOUR))).toBe(1);

      expect((await read(id)).status).toBe('completed');
      expect(await chainOf(id)).toEqual(['created:alice', 'accepted:bob', 'started:auto', 'marked_done:auto', 'auto_completed:auto']);
    });

    it('pedido para agora → aceito → começar → terminamos → o outro confirma', async () => {
      await seedUsers();
      const id = await request(null);
      await act('accept', 'bob', id, at(MIN));
      await act('start', 'alice', id, at(2 * MIN));
      await act('markDone', 'alice', id, at(40 * MIN));
      await act('confirm', 'bob', id, at(41 * MIN));

      expect((await read(id)).status).toBe('completed');
      expect(await chainOf(id)).toEqual(['created:alice', 'accepted:bob', 'started:alice', 'marked_done:alice', 'confirmed:bob']);
      // Aviso no chat do pedido, do aceite e da conclusão; começar e terminar não avisam.
      const conversationId = (await read(id)).conversationId;
      const systemEvents = (await db.collection(`conversations/${conversationId}/messages`).get()).docs.map(d => d.get('systemEvent'));
      expect(systemEvents.sort()).toEqual(['session_accepted', 'session_completed', 'session_requested']);
    });

    it('pedido sem resposta expira, e depois disso ninguém mexe', async () => {
      await seedUsers();
      const id = await request(null);
      expect(await expireSessionRequests(db, at(15 * MIN))).toBe(1);
      for (const action of ACTIONS) {
        const reason = await reasonOf(act(action, 'bob', id, at(16 * MIN)));
        expect(['invalid_state', 'not_allowed']).toContain(reason);
      }
      expect(await chainOf(id)).toEqual(['created:alice', 'expired:auto']);
    });
  });
});
