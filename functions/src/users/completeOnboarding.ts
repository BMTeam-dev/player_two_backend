import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from '../lib/admin.js';
import { createProfile, parseOnboardingInput } from './onboarding.js';

export const completeOnboarding = onCall(async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  const { uid, token } = request.auth;
  // Login só via Google: o e-mail sempre vem no token. Se faltar, é conta
  // criada por outro caminho (ex: anônima) e não deveria ter perfil.
  if (!token.email) {
    throw new HttpsError('failed-precondition', 'Conta sem e-mail.', { reason: 'invalid_input' });
  }

  const now = Timestamp.now();
  const input = parseOnboardingInput(request.data, now.toDate());
  return createProfile(db, { uid, email: token.email, emailVerified: token.email_verified === true }, input, now);
});
