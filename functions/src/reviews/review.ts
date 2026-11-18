import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { hasSevereTerm } from '../chat/severeTerms.js';
import { isId, millisOf, type SessionDoc } from '../sessions/shared.js';
import type { AppConfig, Review, ReviewTag, User } from '../types.js';

export const COMMENT_MAX = 300;
export const DEFAULT_REVIEW_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

export const REVIEW_TAGS: readonly ReviewTag[] = [
  'friendly',
  'skilled',
  'good_teacher',
  'punctual',
  'good_comms',
  'toxic',
  'no_show',
  'late',
];

export type ReviewErrorReason =
  | 'invalid_input'
  | 'comment_not_allowed'
  | 'account_restricted'
  | 'session_not_found'
  | 'invalid_state'
  | 'review_window_closed'
  | 'already_reviewed';

const fail = (code: FunctionsErrorCode, reason: ReviewErrorReason, message: string) =>
  new HttpsError(code, message, { reason });

export interface ReviewInput {
  sessionId: string;
  rating: Review['rating'];
  tags: ReviewTag[];
  comment: string | null;
}

export function parseReviewInput(data: unknown): ReviewInput {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (!isId(raw.sessionId)) {
    throw fail('invalid-argument', 'invalid_input', 'sessionId inválido.');
  }
  const rating = raw.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw fail('invalid-argument', 'invalid_input', 'A nota vai de 1 a 5.');
  }
  const tagsRaw = raw.tags ?? [];
  if (!Array.isArray(tagsRaw) || !tagsRaw.every(t => REVIEW_TAGS.includes(t as ReviewTag))) {
    throw fail('invalid-argument', 'invalid_input', 'Tag inválida.');
  }
  const comment = typeof raw.comment === 'string' ? raw.comment.trim() : '';
  if (comment.length > COMMENT_MAX) {
    throw fail('invalid-argument', 'invalid_input', `O comentário deve ter até ${COMMENT_MAX} caracteres.`);
  }
  // Diferente do chat, que só marca a mensagem: o comentário fica público no
  // perfil de outra pessoa, então termo grave nem chega a ser gravado.
  if (hasSevereTerm(comment)) {
    throw fail('invalid-argument', 'comment_not_allowed', 'O comentário tem um termo que não é permitido.');
  }
  return {
    sessionId: raw.sessionId,
    rating: rating as Review['rating'],
    tags: [...new Set(tagsRaw as ReviewTag[])],
    comment: comment.length > 0 ? comment : null,
  };
}

export const reviewId = (sessionId: string, authorId: string) => `${sessionId}_${authorId}`;

/**
 * Grava a avaliação de quem participou de uma sessão `completed`, dentro de
 * `reviewWindowDays` a partir da conclusão. Avaliação cega: fica
 * `visible: false` até o outro lado avaliar também - aí as duas aparecem
 * juntas, na mesma transaction. Quem avalia depois não consegue ler a do
 * outro antes de mandar a sua, e por isso nenhuma das duas é de retaliação.
 */
export async function submitReview(db: Firestore, uid: string, input: ReviewInput, now: Timestamp) {
  const sessionRef = db.doc(`sessions/${input.sessionId}`);
  const configSnap = await db.doc('config/app').get();
  const windowDays = (configSnap.data() as Partial<AppConfig> | undefined)?.reviewWindowDays ?? DEFAULT_REVIEW_WINDOW_DAYS;

  return db.runTransaction(async tx => {
    const session = (await tx.get(sessionRef)).data() as SessionDoc | undefined;
    if (!session || !session.participantIds.includes(uid)) {
      throw fail('not-found', 'session_not_found', 'Sessão não encontrada.');
    }
    const targetId = uid === session.providerId ? session.requesterId : session.providerId;
    const ownRef = db.doc(`reviews/${reviewId(input.sessionId, uid)}`);
    const otherRef = db.doc(`reviews/${reviewId(input.sessionId, targetId)}`);
    const [ownSnap, otherSnap, authorSnap] = await Promise.all([
      tx.get(ownRef),
      tx.get(otherRef),
      tx.get(db.doc(`users/${uid}`)),
    ]);

    if (session.status !== 'completed' || session.completedAt == null) {
      throw fail('failed-precondition', 'invalid_state', 'Só dá para avaliar sessões concluídas.');
    }
    if (now.toMillis() > millisOf(session.completedAt as unknown as Timestamp) + windowDays * DAY_MS) {
      throw fail('failed-precondition', 'review_window_closed', 'O prazo para avaliar esta sessão acabou.');
    }
    if (ownSnap.exists) {
      throw fail('already-exists', 'already_reviewed', 'Você já avaliou esta sessão.');
    }
    const author = authorSnap.data() as User | undefined;
    // Conta suspensa ou banida não deixa avaliação: seria o jeito de
    // retaliar quem a denunciou.
    if (!author || author.status !== 'active') {
      throw fail('permission-denied', 'account_restricted', 'Sua conta não pode avaliar sessões.');
    }

    const role = uid === session.providerId ? 'provider' : 'requester';
    const bothReviewed = otherSnap.exists;
    const review: Review = {
      id: ownRef.id,
      sessionId: input.sessionId,
      gameId: session.gameId,
      authorId: uid,
      targetId,
      role: role === 'provider' ? 'as_provider' : 'as_requester',
      rating: input.rating,
      tags: input.tags,
      comment: input.comment,
      authorSnapshot: { displayName: author.displayName, avatarUrl: author.avatarUrl ?? null },
      visible: bothReviewed,
      createdAt: now,
    };
    tx.set(ownRef, review);
    if (bothReviewed) {
      tx.update(otherRef, { visible: true });
    }
    tx.update(sessionRef, { [`reviewedBy.${role}`]: true, updatedAt: now });
    return { reviewId: ownRef.id, visible: bothReviewed };
  });
}

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/**
 * Revela as avaliações que ficaram sem resposta do outro lado por
 * `reviewWindowDays` a partir da criação. Como a avaliação só pode ser
 * criada depois da conclusão, esse prazo nunca termina antes de o outro lado
 * perder o direito de avaliar - a cegueira não vaza. Devolve quantas revelou.
 */
export async function revealBlindReviews(db: Firestore, now: Timestamp) {
  const config = (await db.doc('config/app').get()).data() as Partial<AppConfig> | undefined;
  const windowDays = config?.reviewWindowDays ?? DEFAULT_REVIEW_WINDOW_DAYS;
  const cutoff = new Date(now.toMillis() - windowDays * DAY_MS);
  const query = db.collection('reviews').where('visible', '==', false).where('createdAt', '<=', cutoff);

  let revealed = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const snapshot = await query.limit(PAGE_SIZE).get();
    if (snapshot.empty) {
      break;
    }
    // Sem transaction: a única mudança possível no meio é o outro lado
    // revelar a mesma avaliação, e `visible: true` duas vezes dá no mesmo.
    const batch = db.batch();
    snapshot.docs.forEach(d => batch.update(d.ref, { visible: true }));
    await batch.commit();
    revealed += snapshot.size;
    if (snapshot.size < PAGE_SIZE) {
      break;
    }
  }
  return revealed;
}
