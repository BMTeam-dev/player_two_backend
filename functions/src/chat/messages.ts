import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { AppConfig, Conversation, Message, UserPrivate } from '../types.js';
import { chatLink, type PushIntent } from '../notifications/push.js';
import { hasSevereTerm } from './severeTerms.js';

const MINUTE_MS = 60_000;
const DEFAULT_MESSAGES_PER_MINUTE = 30;

/** `push` = avisos de mensagem nova para os outros participantes, enviados depois da transaction. */
export type MessageOutcome = { result: 'counted' | 'rate_limited' | 'ignored'; flagged: boolean; push: PushIntent[] };

const millisOf = (v: unknown) => (v && typeof (v as Timestamp).toMillis === 'function' ? (v as Timestamp).toMillis() : null);

/**
 * Pós-processamento de uma mensagem de texto criada pelo cliente: limite
 * por minuto, filtro de termos graves e `lastMessage`/`unread` da conversa.
 *
 * Mensagens de sistema são ignoradas: quem as grava (callables e funções
 * agendadas de sessão, `postSystemMessage`) já atualiza a conversa na mesma
 * transaction. Contar aqui também somaria 2 no `unread`.
 */
export async function handleNewMessage(
  db: Firestore,
  conversationId: string,
  messageId: string,
  now: Timestamp,
): Promise<MessageOutcome> {
  const conversationRef = db.doc(`conversations/${conversationId}`);
  const messageRef = conversationRef.collection('messages').doc(messageId);

  return db.runTransaction(async tx => {
    const [messageSnap, conversationSnap, configSnap] = await Promise.all([
      tx.get(messageRef),
      tx.get(conversationRef),
      tx.get(db.doc('config/app')),
    ]);
    const message = messageSnap.data() as Message | undefined;
    const conversation = conversationSnap.data() as Conversation | undefined;
    if (!message || message.type !== 'text' || !message.senderId || !conversation) {
      return { result: 'ignored', flagged: false, push: [] };
    }

    const privateRef = db.doc(`users/${message.senderId}/private/data`);
    const rate = ((await tx.get(privateRef)).data() as UserPrivate | undefined)?.rateLimit;

    // As regras não têm como contar mensagens, então o limite é aplicado
    // depois: o excesso é apagado. Janela fixa de 1 min por pessoa (em
    // todas as conversas), como o limite de pedidos de sessão. 30/min não
    // atrapalha conversa normal, só quem cola texto em loop.
    const limit = (configSnap.data() as AppConfig | undefined)?.rateLimits?.messagesPerMinute ?? DEFAULT_MESSAGES_PER_MINUTE;
    const windowStartMs = millisOf(rate?.messagesWindowStart);
    const windowOpen = windowStartMs !== null && now.toMillis() - windowStartMs < MINUTE_MS;
    const count = windowOpen ? (rate?.messagesCount ?? 0) : 0;
    if (count >= limit) {
      tx.delete(messageRef);
      return { result: 'rate_limited', flagged: false, push: [] };
    }
    tx.set(
      privateRef,
      { rateLimit: { messagesWindowStart: windowOpen ? rate!.messagesWindowStart : now, messagesCount: count + 1 } },
      { merge: true },
    );

    const flagged = hasSevereTerm(message.text);
    if (flagged) {
      tx.update(messageRef, { flagged: true });
    }

    // Triggers não chegam em ordem garantida: uma mensagem processada
    // atrasada não pode tirar uma mais nova do `lastMessage`.
    const createdAtMs = millisOf(message.createdAt) ?? now.toMillis();
    const lastAtMs = millisOf(conversation.lastMessage?.at);
    const isNewest = lastAtMs === null || createdAtMs >= lastAtMs;

    const unread = Object.fromEntries(
      conversation.participantIds.map(uid => [
        uid,
        (conversation.unread?.[uid] ?? 0) + (uid === message.senderId ? 0 : 1),
      ]),
    );
    tx.update(conversationRef, {
      ...(isNewest
        ? { lastMessage: { text: message.text, senderId: message.senderId, type: 'text', at: message.createdAt } }
        : {}),
      unread,
      updatedAt: now,
    });
    const senderName = conversation.participantSnapshots?.[message.senderId]?.displayName ?? 'Nova mensagem';
    const push: PushIntent[] = conversation.participantIds
      .filter(uid => uid !== message.senderId)
      .map(uid => ({
        to: uid,
        pref: 'messages',
        channel: 'messages',
        title: senderName,
        body: message.text,
        link: chatLink(conversationId),
        tag: `chat_${conversationId}`,
      }));
    return { result: 'counted', flagged, push };
  });
}
