import type { DocumentReference, Firestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import type { Conversation, Message, Session, SessionEvent, SessionEventType, SessionStatus, SystemEvent } from '../types.js';

/** Erro de validação: `details.reason` é o que o app usa para escolher a mensagem. */
export type SessionErrorReason =
  | 'invalid_input'
  | 'no_profile'
  | 'account_restricted'
  | 'self_request'
  | 'provider_unavailable'
  | 'blocked'
  | 'listing_unavailable'
  | 'game_not_offered'
  | 'rate_limited'
  | 'already_requested'
  | 'session_not_found'
  | 'not_allowed'
  | 'invalid_state'
  | 'request_expired'
  | 'too_early';

export const fail = (code: FunctionsErrorCode, reason: SessionErrorReason, message: string) =>
  new HttpsError(code, message, { reason });

export const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128 && !v.includes('/');

// Sessão gravada com `Date` nos campos calculados (ver docs/10-testes.md,
// 10.3); lida de volta, vem com Timestamp. Os dois tipos aparecem aqui.
export type SessionDoc = Omit<Session, 'scheduledStart' | 'scheduledEnd' | 'requestExpiresAt'> & {
  scheduledStart: Timestamp | Date;
  scheduledEnd: Timestamp | Date;
  requestExpiresAt: Timestamp | Date;
};

export const millisOf = (v: { toMillis(): number } | Date) => (v instanceof Date ? v.getTime() : v.toMillis());

export function addEvent(
  tx: Transaction,
  sessionRef: DocumentReference,
  type: SessionEventType,
  fromStatus: SessionStatus | null,
  toStatus: SessionStatus,
  actorId: string | null,
  now: Timestamp,
  meta: SessionEvent['meta'] = null,
) {
  const event: SessionEvent = { type, fromStatus, toStatus, actorId, meta, at: now };
  tx.set(sessionRef.collection('events').doc(), event);
}

/**
 * Mensagem de sistema na conversa da sessão. Já atualiza `lastMessage` e
 * soma 1 no `unread` de quem não causou o evento: o trigger de mensagens da
 * tarefa 25 cuida só das mensagens de texto (do cliente), senão as de
 * sistema seriam contadas duas vezes.
 *
 * `conversation` = estado lido na mesma transaction (as escritas vêm depois
 * de todas as leituras). O `unread` é calculado a partir dele, sem
 * `FieldValue.increment`: o FieldValue de uma cópia do firebase-admin é
 * recusado pela outra (ver docs/10-testes.md, 10.3), e a transaction já
 * garante que ninguém mudou o contador no meio.
 */
export function postSystemMessage(
  db: Firestore,
  tx: Transaction,
  conversation: Pick<Conversation, 'id' | 'participantIds' | 'unread'>,
  systemEvent: SystemEvent,
  text: string,
  actorId: string | null,
  now: Timestamp,
) {
  const conversationRef = db.doc(`conversations/${conversation.id}`);
  const messageRef = conversationRef.collection('messages').doc();
  const message: Message = { id: messageRef.id, senderId: null, type: 'system', text, systemEvent, flagged: false, createdAt: now };
  tx.set(messageRef, message);

  const unread = Object.fromEntries(
    conversation.participantIds.map(uid => [uid, (conversation.unread?.[uid] ?? 0) + (uid === actorId ? 0 : 1)]),
  );
  tx.update(conversationRef, { lastMessage: { text, senderId: null, type: 'system', at: now }, unread, updatedAt: now });
}
