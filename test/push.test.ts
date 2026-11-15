// Testes do push (`npm test`): quem recebe em cada mudança de sessão (lógica
// pura) e o envio contra o emulador do Firestore, com um FCM falso.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPushes, type PushIntent } from '../functions/src/notifications/push.js';
import { sessionPushes } from '../functions/src/notifications/sessionPushes.js';

const session = (status: string, fields: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    requesterId: 'alice',
    providerId: 'bob',
    participantSnapshots: { alice: { displayName: 'Alice', avatarUrl: null }, bob: { displayName: 'Bob', avatarUrl: null } },
    status,
    cancellation: null,
    ...fields,
  }) as Parameters<typeof sessionPushes>[1] & object;

describe('sessionPushes', () => {
  it('pedido novo avisa o provider, com link para a sessão', () => {
    expect(sessionPushes(null, session('requested'), 'Valorant')).toEqual([
      {
        to: 'bob',
        pref: 'sessionRequests',
        channel: 'sessions',
        title: 'Novo pedido de sessão',
        body: 'Alice quer jogar Valorant com você. Responda no app.',
        link: 'mynoobpro://session/s1',
        tag: 'session_s1',
      },
    ]);
  });

  it('aceito, recusado e expirado avisam o requester', () => {
    for (const status of ['accepted', 'declined', 'expired']) {
      const [push] = sessionPushes(session('requested'), session(status), 'Valorant');
      expect(push).toMatchObject({ to: 'alice', pref: 'sessionUpdates' });
    }
    expect(sessionPushes(session('requested'), session('accepted'), 'Valorant')[0].body).toBe(
      'Bob aceitou sua sessão de Valorant.',
    );
  });

  it('cancelamento avisa o outro lado', () => {
    const byBob = session('cancelled', { cancellation: { by: 'bob', reason: null, at: null } });
    expect(sessionPushes(session('accepted'), byBob, 'LoL')).toMatchObject([
      { to: 'alice', title: 'Sessão cancelada', body: 'Bob cancelou a sessão de LoL.' },
    ]);
    const byAlice = session('cancelled', { cancellation: { by: 'alice', reason: null, at: null } });
    expect(sessionPushes(session('requested'), byAlice, 'LoL')).toMatchObject([{ to: 'bob', title: 'Pedido cancelado' }]);
  });

  it('sem mudança de status, início, fim e conclusão não geram push', () => {
    expect(sessionPushes(session('accepted'), session('accepted'), 'LoL')).toEqual([]);
    expect(sessionPushes(session('accepted'), session('in_progress'), 'LoL')).toEqual([]);
    expect(sessionPushes(session('in_progress'), session('awaiting_confirmation'), 'LoL')).toEqual([]);
    expect(sessionPushes(session('awaiting_confirmation'), session('completed'), 'LoL')).toEqual([]);
    expect(sessionPushes(session('requested'), null, 'LoL')).toEqual([]);
  });
});

describe('sendPushes (emulador)', () => {
  let app: App;
  let db: Firestore;
  let sent: MulticastMessage[];

  const intent = (fields: Partial<PushIntent> = {}): PushIntent => ({
    to: 'bob',
    pref: 'messages',
    channel: 'messages',
    title: 'Alice',
    body: 'bora?',
    link: 'mynoobpro://chat/c1',
    tag: 'chat_c1',
    ...fields,
  });
  // FCM falso: tokens começando com "dead" respondem como desinstalados.
  const send = async (message: MulticastMessage): Promise<BatchResponse> => {
    sent.push(message);
    const responses = message.tokens.map(token =>
      token.startsWith('dead')
        ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : { success: true, messageId: `m_${token}` },
    ) as BatchResponse['responses'];
    const successCount = responses.filter(r => r.success).length;
    return { responses, successCount, failureCount: responses.length - successCount };
  };
  const setPrivate = (data: Record<string, unknown>) => db.doc('users/bob/private/data').set(data);

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'push-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    sent = [];
    await db.recursiveDelete(db.collection('users'));
  });

  it('envia para todos os aparelhos, com canal, tag e link', async () => {
    await setPrivate({ fcmTokens: ['t1', 't2'], notificationPrefs: { messages: true } });
    expect(await sendPushes(db, send, [intent()])).toBe(2);
    expect(sent).toEqual([
      {
        tokens: ['t1', 't2'],
        notification: { title: 'Alice', body: 'bora?' },
        data: { link: 'mynoobpro://chat/c1' },
        android: { priority: 'high', notification: { channelId: 'messages', tag: 'chat_c1' } },
      },
    ]);
  });

  it('respeita a preferência desligada e quem não tem aparelho', async () => {
    await setPrivate({ fcmTokens: ['t1'], notificationPrefs: { messages: false, sessionUpdates: true } });
    expect(await sendPushes(db, send, [intent()])).toBe(0);
    expect(await sendPushes(db, send, [intent({ pref: 'sessionUpdates', channel: 'sessions' })])).toBe(1);

    await setPrivate({ fcmTokens: [] });
    expect(await sendPushes(db, send, [intent()])).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('preferência ausente conta como ligada', async () => {
    await setPrivate({ fcmTokens: ['t1'] });
    expect(await sendPushes(db, send, [intent()])).toBe(1);
  });

  it('tira da lista os tokens que o FCM diz que não valem mais', async () => {
    await setPrivate({ fcmTokens: ['t1', 'dead1'], notificationPrefs: {} });
    expect(await sendPushes(db, send, [intent()])).toBe(1);
    expect((await db.doc('users/bob/private/data').get()).get('fcmTokens')).toEqual(['t1']);
  });

  it('corta texto longo', async () => {
    await setPrivate({ fcmTokens: ['t1'] });
    await sendPushes(db, send, [intent({ body: 'a'.repeat(500) })]);
    expect(sent[0].notification!.body).toHaveLength(140);
  });
});
