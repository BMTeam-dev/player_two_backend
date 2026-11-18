import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/admin.js';
import { parseReviewInput, revealBlindReviews as reveal, submitReview as submit } from './review.js';

export const submitReview = onCall(async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  return submit(db, request.auth.uid, parseReviewInput(request.data), Timestamp.now());
});

// Diária (MVP.md 7.3): o prazo é de dias, um atraso de horas não muda nada.
export const revealBlindReviews = onSchedule({ schedule: 'every day 04:00', timeZone: 'America/Sao_Paulo' }, async () => {
  const count = await reveal(db, Timestamp.now());
  if (count > 0) {
    logger.info(`revealBlindReviews: ${count} avaliação(ões) revelada(s)`);
  }
});
