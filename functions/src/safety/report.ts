import type { DocumentSnapshot, Firestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import {
  REPORT_REASONS,
  type AppConfig,
  type Conversation,
  type Listing,
  type Message,
  type Report,
  type ReportPriority,
  type ReportReason,
  type Review,
  type Session,
  type UserPrivate,
} from '../types.js';
import { fail, isId } from './shared.js';

export const DETAILS_MAX = 1000;
export const MAX_EVIDENCE_MESSAGES = 20;
const DEFAULT_REPORTS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;

// O que dá para denunciar na v0 (`lfg_post` é da v0.1).
export const REPORT_TARGETS = ['user', 'message', 'listing', 'session', 'review'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

// MVP.md 12.1: golpe, conteúdo sexual e menor de idade vão para o topo da fila.
const HIGH: ReportReason[] = ['underage', 'sexual_content', 'fraud'];
const LOW: ReportReason[] = ['spam'];

export const priorityOf = (reason: ReportReason): ReportPriority =>
  HIGH.includes(reason) ? 'high' : LOW.includes(reason) ? 'low' : 'normal';

export interface ReportInput {
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  // Conversa da evidência (obrigatória para `message`) e mensagens extras dela.
  conversationId: string | null;
  messageIds: string[];
}

export function parseReportInput(data: unknown): ReportInput {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (!REPORT_TARGETS.includes(raw.targetType as ReportTarget) || !isId(raw.targetId)) {
    throw fail('invalid-argument', 'invalid_input', 'Alvo da denúncia inválido.');
  }
  if (!REPORT_REASONS.includes(raw.reason as ReportReason)) {
    throw fail('invalid-argument', 'invalid_input', 'Motivo inválido.');
  }
  const details = typeof raw.details === 'string' ? raw.details.trim() : '';
  if (details.length > DETAILS_MAX) {
    throw fail('invalid-argument', 'invalid_input', `Os detalhes devem ter até ${DETAILS_MAX} caracteres.`);
  }
  // Sem detalhe, um "outro" não diz nada para a moderação.
  if (raw.reason === 'other' && details.length === 0) {
    throw fail('invalid-argument', 'invalid_input', 'Conte o que aconteceu.');
  }
  const conversationId = raw.conversationId == null ? null : raw.conversationId;
  if (conversationId !== null && !isId(conversationId)) {
    throw fail('invalid-argument', 'invalid_input', 'conversationId inválido.');
  }
  const messageIds = raw.messageIds ?? [];
  if (!Array.isArray(messageIds) || messageIds.length > MAX_EVIDENCE_MESSAGES || !messageIds.every(isId)) {
    throw fail('invalid-argument', 'invalid_input', `Até ${MAX_EVIDENCE_MESSAGES} mensagens de evidência.`);
  }
  if (raw.targetType === 'message' && conversationId === null) {
    throw fail('invalid-argument', 'invalid_input', 'conversationId é obrigatório para denunciar mensagem.');
  }
  if (messageIds.length > 0 && conversationId === null) {
    throw fail('invalid-argument', 'invalid_input', 'Mensagens de evidência precisam da conversa.');
  }
  return {
    targetType: raw.targetType as ReportTarget,
    targetId: raw.targetId,
    reason: raw.reason as ReportReason,
    details: details.length > 0 ? details : null,
    conversationId,
    messageIds: [...new Set(messageIds as string[])],
  };
}

const targetNotFound = () => fail('not-found', 'target_not_found', 'Não encontramos o que você quer denunciar.');

/**
 * Cria a denúncia, numa transaction:
 * - descobre o dono do alvo (`targetUserId`) no servidor: o app não escolhe
 *   quem é denunciado;
 * - só aceita alvo que o denunciante consegue ver (participante da sessão ou
 *   da conversa, avaliação visível ou dele) e nunca ele mesmo;
 * - confere que as mensagens de evidência são de uma conversa da qual ele
 *   participa (MVP.md 8);
 * - aplica `config/app.rateLimits.reportsPerDay`, em janela de 24 h:
 *   denúncia em massa é vetor de assédio;
 * - calcula `priority`.
 *
 * Quem não pode ver o alvo recebe o mesmo `target_not_found` de um alvo que
 * não existe: a denúncia não serve para descobrir ids.
 */
export async function submitReport(db: Firestore, uid: string, input: ReportInput, now: Timestamp) {
  const reporterRef = db.doc(`users/${uid}`);
  const privateRef = db.doc(`users/${uid}/private/data`);
  const reportRef = db.collection('reports').doc();
  const nowMs = now.toMillis();

  const report = await db.runTransaction(async tx => {
    const conversationRef = input.conversationId ? db.doc(`conversations/${input.conversationId}`) : null;
    const [reporterSnap, privateSnap, configSnap, conversationSnap, ...evidenceSnaps] = await Promise.all([
      tx.get(reporterRef),
      tx.get(privateRef),
      tx.get(db.doc('config/app')),
      conversationRef ? tx.get(conversationRef) : Promise.resolve(null),
      ...input.messageIds.map(id => tx.get(conversationRef!.collection('messages').doc(id))),
    ]);
    if (!reporterSnap.exists) {
      throw fail('failed-precondition', 'no_profile', 'Complete seu perfil antes de denunciar.');
    }

    const conversation = conversationSnap?.data() as Conversation | undefined;
    if (conversationSnap && (!conversation || !conversation.participantIds.includes(uid))) {
      throw fail('not-found', 'evidence_not_found', 'Conversa não encontrada.');
    }
    if (evidenceSnaps.some(s => !s.exists)) {
      throw fail('not-found', 'evidence_not_found', 'Mensagem de evidência não encontrada.');
    }

    const target = await resolveTarget(db, tx, uid, input, conversation ?? null);
    if (target.targetUserId === uid) {
      throw fail('invalid-argument', 'self_target', 'Você não pode denunciar a si mesmo.');
    }
    // A evidência tem que ser da conversa com quem está sendo denunciado.
    if (conversation && !conversation.participantIds.includes(target.targetUserId)) {
      throw fail('invalid-argument', 'evidence_not_found', 'As mensagens não são de uma conversa com esta pessoa.');
    }

    const config = configSnap.data() as Partial<AppConfig> | undefined;
    const limit = config?.rateLimits?.reportsPerDay ?? DEFAULT_REPORTS_PER_DAY;
    const rate = (privateSnap.data() as UserPrivate | undefined)?.rateLimit;
    const windowStartMs = rate?.reportsWindowStart?.toDate().getTime() ?? null;
    const windowOpen = windowStartMs !== null && nowMs - windowStartMs < DAY_MS;
    const count = windowOpen ? (rate?.reportsCount ?? 0) : 0;
    if (count >= limit) {
      throw fail('resource-exhausted', 'rate_limited', 'Você fez muitas denúncias hoje. Tente de novo amanhã.');
    }

    const messageIds = input.targetType === 'message' ? [input.targetId, ...input.messageIds] : input.messageIds;
    const created: Report = {
      id: reportRef.id,
      reporterId: uid,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUserId: target.targetUserId,
      reason: input.reason,
      details: input.details,
      evidence: { conversationId: input.conversationId ?? target.conversationId, messageIds: [...new Set(messageIds)] },
      status: 'open',
      priority: priorityOf(input.reason),
      resolution: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(reportRef, created);
    tx.set(
      privateRef,
      { rateLimit: { reportsWindowStart: windowOpen ? rate!.reportsWindowStart : now, reportsCount: count + 1 } },
      { merge: true },
    );
    return created;
  });

  return report;
}

type Target = { targetUserId: string; conversationId: string | null };

async function resolveTarget(
  db: Firestore,
  tx: Transaction,
  uid: string,
  input: ReportInput,
  conversation: Conversation | null,
): Promise<Target> {
  const read = (path: string): Promise<DocumentSnapshot> => tx.get(db.doc(path));

  switch (input.targetType) {
    case 'user': {
      if (!(await read(`users/${input.targetId}`)).exists) {
        throw targetNotFound();
      }
      return { targetUserId: input.targetId, conversationId: null };
    }
    case 'message': {
      // A conversa já foi validada: o denunciante participa dela.
      const message = (await read(`conversations/${conversation!.id}/messages/${input.targetId}`)).data() as Message | undefined;
      // Mensagem de sistema não tem autor para denunciar.
      if (!message || message.senderId == null) {
        throw targetNotFound();
      }
      return { targetUserId: message.senderId, conversationId: conversation!.id };
    }
    case 'listing': {
      const listing = (await read(`listings/${input.targetId}`)).data() as Listing | undefined;
      if (!listing) {
        throw targetNotFound();
      }
      return { targetUserId: listing.ownerId, conversationId: null };
    }
    case 'session': {
      const session = (await read(`sessions/${input.targetId}`)).data() as Session | undefined;
      if (!session || !session.participantIds.includes(uid)) {
        throw targetNotFound();
      }
      const other = session.participantIds.find(p => p !== uid) ?? uid;
      return { targetUserId: other, conversationId: session.conversationId };
    }
    case 'review': {
      const review = (await read(`reviews/${input.targetId}`)).data() as Review | undefined;
      // Mesmo critério das regras: avaliação cega só o autor vê.
      if (!review || (!review.visible && review.authorId !== uid)) {
        throw targetNotFound();
      }
      return { targetUserId: review.authorId, conversationId: null };
    }
  }
}
