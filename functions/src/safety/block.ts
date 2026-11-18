import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { addEvent } from '../sessions/shared.js';
import type { Block, Conversation, Session, SessionStatus } from '../types.js';
import { fail, isId } from './shared.js';

// Ainda não começaram: bloquear desfaz o combinado. Sessões em andamento ou
// aguardando confirmação seguem o fluxo normal (terminar, confirmar ou "não
// apareceu"), só que sem chat.
const CANCEL_ON_BLOCK: SessionStatus[] = ['requested', 'accepted'];

export function parseTargetUid(uid: string, data: unknown): string {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (!isId(raw.targetUid)) {
    throw fail('invalid-argument', 'invalid_input', 'targetUid inválido.');
  }
  if (raw.targetUid === uid) {
    throw fail('invalid-argument', 'self_target', 'Você não pode bloquear a si mesmo.');
  }
  return raw.targetUid;
}

/**
 * Bloqueia `targetUid` para `uid`, numa transaction:
 * - grava `users/{uid}/blocks/{targetUid}`;
 * - tranca (`lockedReason: 'block'`) as conversas das sessões entre os dois;
 * - cancela as sessões entre os dois que ainda não começaram.
 *
 * O cancelamento sai com `cancellation.by = null`, como uma transição
 * automática: não conta contra a taxa de conclusão de quem bloqueou (bloquear
 * quem assedia não é furar), não gera push para o bloqueado (stats.ts e
 * sessionPushes.ts olham `by`) e não gera mensagem no chat, que já fica
 * trancado. Idempotente: bloquear de novo não muda nada.
 */
export async function blockUser(db: Firestore, uid: string, targetUid: string, now: Timestamp) {
  const blockRef = db.doc(`users/${uid}/blocks/${targetUid}`);
  const sessions = db.collection('sessions');

  return db.runTransaction(async tx => {
    const [targetSnap, blockSnap, asRequester, asProvider] = await Promise.all([
      tx.get(db.doc(`users/${targetUid}`)),
      tx.get(blockRef),
      tx.get(sessions.where('requesterId', '==', uid).where('providerId', '==', targetUid)),
      tx.get(sessions.where('requesterId', '==', targetUid).where('providerId', '==', uid)),
    ]);
    if (!targetSnap.exists) {
      throw fail('not-found', 'user_not_found', 'Jogador não encontrado.');
    }
    const pairSessions = [...asRequester.docs, ...asProvider.docs];
    const conversationSnaps = await Promise.all(
      pairSessions.map(s => tx.get(db.doc(`conversations/${(s.data() as Session).conversationId}`))),
    );

    if (!blockSnap.exists) {
      const block: Block = { blockedUid: targetUid, createdAt: now };
      tx.set(blockRef, block);
    }

    let locked = 0;
    for (const snap of conversationSnaps) {
      const conversation = snap.data() as Conversation | undefined;
      if (conversation && conversation.lockedAt == null) {
        tx.update(snap.ref, { lockedAt: now, lockedReason: 'block', updatedAt: now });
        locked++;
      }
    }

    let cancelled = 0;
    for (const snap of pairSessions) {
      const session = snap.data() as Session;
      if (CANCEL_ON_BLOCK.includes(session.status)) {
        tx.update(snap.ref, {
          status: 'cancelled',
          cancellation: { by: null, reason: null, at: now, fromStatus: session.status },
          updatedAt: now,
        });
        addEvent(tx, snap.ref, 'cancelled', session.status, 'cancelled', null, now);
        cancelled++;
      }
    }
    return { locked, cancelled };
  });
}

/**
 * Desfaz o bloqueio. As conversas continuam trancadas e as sessões
 * canceladas não voltam: para jogar de novo, um novo pedido abre uma
 * conversa nova.
 */
export async function unblockUser(db: Firestore, uid: string, targetUid: string) {
  await db.doc(`users/${uid}/blocks/${targetUid}`).delete();
}
