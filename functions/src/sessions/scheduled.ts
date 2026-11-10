import type { DocumentReference, Firestore, Query, Timestamp } from 'firebase-admin/firestore';
import type { AppConfig, Conversation, SessionEventType, SessionStatus, SystemEvent } from '../types.js';
import { addEvent, millisOf, postSystemMessage, type SessionDoc } from './shared.js';

const PAGE_SIZE = 100;
// Teto de páginas por execução, como em expireAvailability: se uma sessão
// nunca sai da consulta (ex: transaction sempre em conflito), a função para
// em vez de rodar até o timeout. O resto fica para a próxima execução.
const MAX_PAGES = 10;
// Transactions em paralelo por página: sessões diferentes não disputam os
// mesmos documentos, mas não precisamos abrir 100 de uma vez.
const CONCURRENCY = 10;
const DEFAULT_AUTO_COMPLETE_HOURS = 24;

type AutoTransition = {
  from: SessionStatus;
  to: SessionStatus;
  event: SessionEventType;
  // Condição revalidada dentro da transaction: entre a consulta e a escrita,
  // alguém pode ter agido na sessão.
  due: (session: SessionDoc) => boolean;
  fields: (now: Timestamp) => Record<string, unknown>;
  message: { systemEvent: SystemEvent; text: string } | null;
};

/**
 * Aplica uma transição automática (`actorId: null`) a uma sessão, numa
 * transaction. Devolve false se a sessão mudou desde a consulta - por
 * exemplo, o provider aceitou o pedido no último segundo.
 */
async function applyAuto(db: Firestore, ref: DocumentReference, t: AutoTransition, now: Timestamp) {
  return db.runTransaction(async tx => {
    const session = (await tx.get(ref)).data() as SessionDoc | undefined;
    if (!session || session.status !== t.from || !t.due(session)) {
      return false;
    }
    const conversation = t.message
      ? ((await tx.get(db.doc(`conversations/${session.conversationId}`))).data() as Conversation | undefined)
      : undefined;

    tx.update(ref, { ...t.fields(now), status: t.to, updatedAt: now });
    addEvent(tx, ref, t.event, t.from, t.to, null, now);
    if (t.message && conversation) {
      postSystemMessage(db, tx, conversation, t.message.systemEvent, t.message.text, null, now);
    }
    return true;
  });
}

/** Roda `t` em todas as sessões da consulta, página por página. Devolve quantas mudaram. */
async function runAuto(db: Firestore, query: Query, t: AutoTransition, now: Timestamp) {
  let changed = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const snapshot = await query.limit(PAGE_SIZE).get();
    if (snapshot.empty) {
      break;
    }
    const refs = snapshot.docs.map(d => d.ref);
    for (let i = 0; i < refs.length; i += CONCURRENCY) {
      const results = await Promise.allSettled(refs.slice(i, i + CONCURRENCY).map(ref => applyAuto(db, ref, t, now)));
      changed += results.filter(r => r.status === 'fulfilled' && r.value).length;
    }
    if (snapshot.size < PAGE_SIZE) {
      break;
    }
  }
  return changed;
}

const sessions = (db: Firestore, status: SessionStatus) => db.collection('sessions').where('status', '==', status);

/** `requested` com o prazo de resposta vencido → `expired`. */
export function expireSessionRequests(db: Firestore, now: Timestamp) {
  return runAuto(db, sessions(db, 'requested').where('requestExpiresAt', '<=', now), {
    from: 'requested',
    to: 'expired',
    event: 'expired',
    due: s => millisOf(s.requestExpiresAt) <= now.toMillis(),
    fields: () => ({}),
    message: { systemEvent: 'session_expired', text: 'O pedido expirou sem resposta.' },
  }, now);
}

/**
 * Início e fim pelo horário (MVP.md 6.1: "horário chegou ou Começar", "fim do
 * tempo"). O início roda antes do fim: uma sessão aceita cujo horário já
 * acabou passa pelos dois na mesma execução.
 */
export async function autoAdvanceSessions(db: Firestore, now: Timestamp) {
  const started = await runAuto(db, sessions(db, 'accepted').where('scheduledStart', '<=', now), {
    from: 'accepted',
    to: 'in_progress',
    event: 'started',
    due: s => millisOf(s.scheduledStart) <= now.toMillis(),
    fields: at => ({ startedAt: at }),
    message: null,
  }, now);
  const ended = await runAuto(db, sessions(db, 'in_progress').where('scheduledEnd', '<=', now), {
    from: 'in_progress',
    to: 'awaiting_confirmation',
    event: 'marked_done',
    due: s => millisOf(s.scheduledEnd) <= now.toMillis(),
    fields: at => ({ endedAt: at }),
    message: null,
  }, now);
  return { started, ended };
}

/**
 * `awaiting_confirmation` há mais de `autoCompleteAfterHours` (24 h) → `completed`.
 * "Sem objeção" = ninguém usou o "não apareceu" nesse prazo, o único jeito
 * de contestar uma sessão antes de ela ser concluída.
 */
export async function autoCompleteSessions(db: Firestore, now: Timestamp) {
  const config = (await db.doc('config/app').get()).data() as Partial<AppConfig> | undefined;
  const hours = config?.autoCompleteAfterHours ?? DEFAULT_AUTO_COMPLETE_HOURS;
  const cutoffMs = now.toMillis() - hours * 60 * 60_000;

  return runAuto(db, sessions(db, 'awaiting_confirmation').where('endedAt', '<=', new Date(cutoffMs)), {
    from: 'awaiting_confirmation',
    to: 'completed',
    event: 'auto_completed',
    due: s => s.endedAt != null && millisOf(s.endedAt as unknown as Timestamp) <= cutoffMs,
    fields: at => ({ completedAt: at }),
    message: { systemEvent: 'session_completed', text: 'Sessão concluída automaticamente. Conte como foi na avaliação!' },
  }, now);
}
