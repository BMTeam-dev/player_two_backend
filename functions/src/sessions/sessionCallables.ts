import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from '../lib/admin.js';
import { createSessionRequest, parseRequestInput } from './request.js';
import { parseTransitionInput, transitionSession, type SessionAction } from './transitions.js';

function requireUid(auth: { uid: string } | undefined) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  return auth.uid;
}

export const requestSession = onCall(async request => {
  const uid = requireUid(request.auth);
  const now = Timestamp.now();
  return createSessionRequest(db, uid, parseRequestInput(request.data, now.toMillis()), now);
});

// Uma callable por transição (nomes do MVP.md, seção 7.1), todas com a mesma
// lógica: o nome já diz a ação, e o app não consegue mandar uma ação
// diferente da que chamou.
const transition = (action: SessionAction) =>
  onCall(async request => {
    const uid = requireUid(request.auth);
    return transitionSession(db, uid, parseTransitionInput(action, request.data), Timestamp.now());
  });

export const acceptSession = transition('accept');
export const declineSession = transition('decline');
export const cancelSession = transition('cancel');
export const startSession = transition('start');
export const markSessionDone = transition('markDone');
export const confirmSession = transition('confirm');
export const reportNoShow = transition('reportNoShow');
