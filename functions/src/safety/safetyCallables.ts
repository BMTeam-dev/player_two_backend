import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from '../lib/admin.js';
import { blockUser as block, parseTargetUid, unblockUser as unblock } from './block.js';
import { parseReportInput, submitReport as submit } from './report.js';

function requireUid(auth: { uid: string } | undefined) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  return auth.uid;
}

export const blockUser = onCall(async request => {
  const uid = requireUid(request.auth);
  return block(db, uid, parseTargetUid(uid, request.data), Timestamp.now());
});

export const unblockUser = onCall(async request => {
  const uid = requireUid(request.auth);
  await unblock(db, uid, parseTargetUid(uid, request.data));
  return { ok: true };
});

export const submitReport = onCall(async request => {
  const uid = requireUid(request.auth);
  const report = await submit(db, uid, parseReportInput(request.data), Timestamp.now());
  // Aviso de prioridade alta para a moderação, na v0 só no Cloud Logging
  // (decisions.md, tarefa 31): a moderação filtra por "submitReport: HIGH".
  // Aqui e não num trigger de `reports`: só esta callable cria denúncias, e
  // um trigger custaria uma invocação a mais por denúncia sem ganho.
  if (report.priority === 'high') {
    logger.warn(`submitReport: HIGH ${report.reason}`, {
      reportId: report.id,
      reason: report.reason,
      targetType: report.targetType,
      targetUserId: report.targetUserId,
    });
  }
  return { reportId: report.id };
});
