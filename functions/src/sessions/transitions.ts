import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Conversation, SessionEventType, SessionStatus, SystemEvent } from '../types.js';
import { addEvent, fail, isId, millisOf, postSystemMessage, type SessionDoc } from './shared.js';

export const SESSION_ACTIONS = ['accept', 'decline', 'cancel', 'start', 'markDone', 'confirm', 'reportNoShow'] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CANCEL_REASON_MAX = 200;
// "Começar" um pouco antes do horário marcado: os dois já estão online e não
// faz sentido esperar o relógio.
export const EARLY_START_MS = 15 * 60_000;

type Role = 'requester' | 'provider';

type Rule = {
  actors: Role[];
  from: SessionStatus[];
};

// Quem pode fazer o quê, e a partir de qual estado (MVP.md 6.1). A transição
// de status em si fica em `apply`, porque `confirm` depende das confirmações.
export const RULES: Record<SessionAction, Rule> = {
  accept: { actors: ['provider'], from: ['requested'] },
  decline: { actors: ['provider'], from: ['requested'] },
  cancel: { actors: ['requester', 'provider'], from: ['requested', 'accepted'] },
  start: { actors: ['requester', 'provider'], from: ['accepted'] },
  markDone: { actors: ['requester', 'provider'], from: ['in_progress'] },
  confirm: { actors: ['requester', 'provider'], from: ['awaiting_confirmation'] },
  reportNoShow: { actors: ['requester', 'provider'], from: ['accepted', 'in_progress'] },
};

export interface TransitionInput {
  sessionId: string;
  action: SessionAction;
  reason: string | null; // só `cancel`
}

export function parseTransitionInput(action: SessionAction, data: unknown): TransitionInput {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (!isId(raw.sessionId)) {
    throw fail('invalid-argument', 'invalid_input', 'sessionId inválido.');
  }
  const reason = action === 'cancel' && typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length > CANCEL_REASON_MAX) {
    throw fail('invalid-argument', 'invalid_input', `Motivo deve ter até ${CANCEL_REASON_MAX} caracteres.`);
  }
  return { sessionId: raw.sessionId, action, reason: reason.length > 0 ? reason : null };
}

type Outcome = {
  status: SessionStatus;
  fields: Record<string, unknown>;
  event: SessionEventType;
  message: { systemEvent: SystemEvent; text: string } | null;
};

/**
 * Valida ator e estado atual e grava a transição, o evento de auditoria e,
 * quando faz sentido avisar no chat, uma mensagem de sistema. Tudo numa
 * transaction: aceitar e cancelar ao mesmo tempo não podem passar os dois.
 */
export async function transitionSession(db: Firestore, uid: string, input: TransitionInput, now: Timestamp) {
  const sessionRef = db.doc(`sessions/${input.sessionId}`);
  const nowMs = now.toMillis();

  return db.runTransaction(async tx => {
    const session = (await tx.get(sessionRef)).data() as SessionDoc | undefined;
    // Quem não participa recebe o mesmo erro de sessão inexistente: não
    // confirma que o id existe.
    if (!session || !session.participantIds.includes(uid)) {
      throw fail('not-found', 'session_not_found', 'Sessão não encontrada.');
    }
    const conversationSnap = await tx.get(db.doc(`conversations/${session.conversationId}`));

    const role: Role = uid === session.providerId ? 'provider' : 'requester';
    const rule = RULES[input.action];
    if (!rule.actors.includes(role)) {
      throw fail('permission-denied', 'not_allowed', 'Só quem recebeu o pedido pode responder.');
    }
    if (!rule.from.includes(session.status)) {
      throw fail('failed-precondition', 'invalid_state', 'A sessão mudou. Atualize a tela.');
    }

    const actorName = session.participantSnapshots[uid]?.displayName ?? 'Alguém';
    const otherUid = role === 'provider' ? session.requesterId : session.providerId;
    const startMs = millisOf(session.scheduledStart);
    let outcome: Outcome;

    switch (input.action) {
      case 'accept':
        // A expiração agendada (tarefa 23) roda a cada 10 min; até lá o
        // status continua `requested` mesmo vencido.
        if (nowMs >= millisOf(session.requestExpiresAt)) {
          throw fail('failed-precondition', 'request_expired', 'Este pedido expirou.');
        }
        outcome = {
          status: 'accepted',
          fields: { respondedAt: now },
          event: 'accepted',
          message: { systemEvent: 'session_accepted', text: `${actorName} aceitou a sessão.` },
        };
        break;
      case 'decline':
        outcome = {
          status: 'declined',
          fields: { respondedAt: now },
          event: 'declined',
          message: { systemEvent: 'session_declined', text: `${actorName} recusou o pedido.` },
        };
        break;
      case 'cancel':
        outcome = {
          status: 'cancelled',
          fields: { cancellation: { by: uid, reason: input.reason, at: now } },
          event: 'cancelled',
          message: { systemEvent: 'session_cancelled', text: `${actorName} cancelou a sessão.` },
        };
        break;
      case 'start':
        if (nowMs < startMs - EARLY_START_MS) {
          throw fail('failed-precondition', 'too_early', 'Ainda não está na hora da sessão.');
        }
        outcome = { status: 'in_progress', fields: { startedAt: now }, event: 'started', message: null };
        break;
      case 'markDone':
        // Quem diz "terminamos" já confirma o próprio lado.
        outcome = {
          status: 'awaiting_confirmation',
          fields: { endedAt: now, [`confirmations.${role}`]: now },
          event: 'marked_done',
          message: null,
        };
        break;
      case 'confirm': {
        if (session.confirmations[role] != null) {
          // Toque duplo: já confirmado, nada a gravar.
          return { sessionId: input.sessionId, status: session.status };
        }
        const otherRole: Role = role === 'provider' ? 'requester' : 'provider';
        const done = session.confirmations[otherRole] != null;
        outcome = {
          status: done ? 'completed' : 'awaiting_confirmation',
          fields: { [`confirmations.${role}`]: now, ...(done ? { completedAt: now } : {}) },
          event: 'confirmed',
          message: done ? { systemEvent: 'session_completed', text: 'Sessão concluída. Conte como foi na avaliação!' } : null,
        };
        break;
      }
      case 'reportNoShow':
        if (nowMs < startMs) {
          throw fail('failed-precondition', 'too_early', 'A sessão ainda não começou.');
        }
        outcome = {
          status: 'no_show',
          fields: { noShow: { reportedBy: uid, absentUid: otherUid, at: now } },
          event: 'no_show',
          message: { systemEvent: 'session_no_show', text: `${actorName} informou que a outra pessoa não apareceu.` },
        };
        break;
    }

    tx.update(sessionRef, { ...outcome.fields, status: outcome.status, updatedAt: now });
    addEvent(tx, sessionRef, outcome.event, session.status, outcome.status, uid, now, input.reason ? { reason: input.reason } : null);
    const conversation = conversationSnap.data() as Conversation | undefined;
    if (outcome.message && conversation) {
      postSystemMessage(db, tx, conversation, outcome.message.systemEvent, outcome.message.text, uid, now);
    }
    return { sessionId: input.sessionId, status: outcome.status };
  });
}
