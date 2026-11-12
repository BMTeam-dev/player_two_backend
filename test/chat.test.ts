// Testes do pós-processamento de mensagens do chat contra o emulador do
// Firestore (`npm test`). As mensagens são gravadas direto, como o cliente
// faria, e a lógica do trigger é chamada em seguida.
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleNewMessage } from '../functions/src/chat/messages.js';
import { hasSevereTerm, normalize } from '../functions/src/chat/severeTerms.js';

const NOW_MS = Date.parse('2026-11-12T15:00:00Z');
const NOW = Timestamp.fromMillis(NOW_MS);
const at = (offsetMs: number) => Timestamp.fromMillis(NOW_MS + offsetMs);

describe('severeTerms', () => {
  it('normaliza acento, leet e letra repetida', () => {
    expect(normalize('V1AAAD0!!')).toBe('viado');
    expect(normalize('Sapatão')).toBe('sapatao');
  });

  it('marca termos graves e frases de ameaça, sem pegar palavrão comum', () => {
    expect(hasSevereTerm('seu v1ad0')).toBe(true);
    expect(hasSevereTerm('Vou te MATAR, sério')).toBe(true);
    expect(hasSevereTerm('porra, perdi o clutch')).toBe(false);
    expect(hasSevereTerm('a sessão matou a saudade')).toBe(false);
    // Palavra dentro de outra não conta.
    expect(hasSevereTerm('kyssandra')).toBe(false);
  });
});

describe('handleNewMessage (emulador)', () => {
  let app: App;
  let db: Firestore;

  const seedConversation = (fields: Record<string, unknown> = {}) =>
    db.doc('conversations/c1').set({
      id: 'c1',
      participantIds: ['alice', 'bob'],
      lastMessage: { text: 'Alice pediu uma sessão.', senderId: null, type: 'system', at: at(-60_000) },
      unread: { alice: 0, bob: 1 },
      lockedAt: null,
      updatedAt: at(-60_000),
      ...fields,
    });
  const send = async (id: string, senderId: string, text: string, createdAt = NOW) => {
    await db.doc(`conversations/c1/messages/${id}`).set({
      id,
      senderId,
      type: 'text',
      text,
      systemEvent: null,
      flagged: false,
      createdAt,
    });
    return handleNewMessage(db, 'c1', id, NOW);
  };
  const conversation = async () => (await db.doc('conversations/c1').get()).data()!;
  const message = async (id: string) => (await db.doc(`conversations/c1/messages/${id}`).get()).data();

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'chat-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['conversations', 'users', 'config']) {
      await db.recursiveDelete(db.collection(path));
    }
    await seedConversation();
  });

  it('atualiza lastMessage e soma não lida só para o outro participante', async () => {
    expect(await send('m1', 'alice', 'Bora?')).toEqual({ result: 'counted', flagged: false });

    const c = await conversation();
    expect(c.lastMessage).toMatchObject({ text: 'Bora?', senderId: 'alice', type: 'text' });
    expect(c.lastMessage.at.toMillis()).toBe(NOW_MS);
    expect(c.unread).toEqual({ alice: 0, bob: 2 });
  });

  it('ignora mensagem de sistema (a callable já contou)', async () => {
    await db.doc('conversations/c1/messages/s1').set({
      id: 's1',
      senderId: null,
      type: 'system',
      text: 'Bob aceitou a sessão.',
      systemEvent: 'session_accepted',
      flagged: false,
      createdAt: NOW,
    });
    expect((await handleNewMessage(db, 'c1', 's1', NOW)).result).toBe('ignored');
    expect((await conversation()).unread).toEqual({ alice: 0, bob: 1 });
  });

  it('mensagem atrasada não tira uma mais nova do lastMessage, mas conta como não lida', async () => {
    await send('m1', 'bob', 'mais nova', NOW);
    await send('m0', 'alice', 'mais antiga', at(-30_000));

    const c = await conversation();
    expect(c.lastMessage.text).toBe('mais nova');
    expect(c.unread).toEqual({ alice: 1, bob: 2 });
  });

  it('marca termo grave com flagged, sem esconder a mensagem', async () => {
    expect(await send('m1', 'alice', 'vou te matar')).toEqual({ result: 'counted', flagged: true });
    expect(await message('m1')).toMatchObject({ flagged: true, text: 'vou te matar' });
    expect((await conversation()).unread.bob).toBe(2);
  });

  it('apaga o excesso acima do limite por minuto, e a janela reabre depois de 1 min', async () => {
    await db.doc('config/app').set({ rateLimits: { messagesPerMinute: 2 } });

    expect((await send('m1', 'alice', 'um')).result).toBe('counted');
    expect((await send('m2', 'alice', 'dois')).result).toBe('counted');
    expect((await send('m3', 'alice', 'três')).result).toBe('rate_limited');
    expect(await message('m3')).toBeUndefined();
    expect((await conversation()).unread.bob).toBe(3);
    // O limite é por pessoa: o outro lado continua conversando.
    expect((await send('m4', 'bob', 'oi')).result).toBe('counted');

    await db.doc('users/alice/private/data').set(
      { rateLimit: { messagesWindowStart: at(-61_000), messagesCount: 2 } },
      { merge: true },
    );
    expect((await send('m5', 'alice', 'voltei')).result).toBe('counted');
  });

  it('não mexe no limite de pedidos de sessão guardado no mesmo documento', async () => {
    await db.doc('users/alice/private/data').set({ rateLimit: { sessionRequestsWindowStart: NOW, sessionRequestsCount: 3 } });
    await send('m1', 'alice', 'oi');

    const rate = (await db.doc('users/alice/private/data').get()).get('rateLimit');
    expect(rate).toMatchObject({ sessionRequestsCount: 3, messagesCount: 1 });
  });
});
