import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { auth, db, rtdb, storage } from '../lib/admin.js';
import { deleteAccount as remove } from './accountDeletion.js';

export const deleteAccount = onCall({ timeoutSeconds: 300 }, async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  const uid = request.auth.uid;
  const result = await remove(
    db,
    {
      deleteAuthUser: id => auth.deleteUser(id),
      deleteAvatarFiles: id => storage().bucket().deleteFiles({ prefix: `avatars/${id}/` }),
      deletePresence: id => rtdb().ref(`status/${id}`).remove(),
    },
    uid,
    Timestamp.now(),
  );
  logger.info(`deleteAccount: ${uid}`, result);
  return { ok: true };
});
