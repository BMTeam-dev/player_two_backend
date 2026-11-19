import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { auth, db } from '../lib/admin.js';
import type { User } from '../types.js';
import { restoreUser, restrictUser, statusChange } from './status.js';

// Trigger separado da sync dos cartões: os dois olham `users/{uid}`, mas um
// erro aqui (ex: Auth fora do ar) não pode impedir o cartão de sumir, e
// vice-versa. Quase toda escrita em `users` não muda o status e sai na
// primeira linha.
//
// `retry`: se o Auth ou o banco falharem, o Firebase tenta de novo (até 7
// dias). Seguro porque restrictUser e restoreUser são idempotentes; sem
// isso, uma falha passageira deixaria a conta banida ainda entrando.
export const onUserStatusChanged = onDocumentWritten({ document: 'users/{uid}', retry: true }, async event => {
  const before = (event.data?.before.data() as User | undefined) ?? null;
  const after = (event.data?.after.data() as User | undefined) ?? null;
  const change = statusChange(before, after);
  if (!change) {
    return;
  }
  const uid = event.params.uid;
  if (change === 'restrict') {
    const result = await restrictUser(db, auth, uid, Timestamp.now());
    logger.info(`onUserStatusChanged: ${uid} ${before?.status ?? '-'} → ${after!.status}`, result);
  } else {
    await restoreUser(auth, uid);
    logger.info(`onUserStatusChanged: ${uid} ${before!.status} → active`);
  }
});
