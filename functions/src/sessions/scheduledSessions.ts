import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/admin.js';
import { autoAdvanceSessions as advance, autoCompleteSessions as complete, expireSessionRequests as expire } from './scheduled.js';

// Frequências do MVP.md 7.3. Um pedido vencido pode ficar até 10 min como
// `requested`, mas acceptSession já recusa depois do prazo (request_expired).
const EVERY_10_MIN = { schedule: 'every 10 minutes', timeZone: 'America/Sao_Paulo' };

export const expireSessionRequests = onSchedule(EVERY_10_MIN, async () => {
  const count = await expire(db, Timestamp.now());
  if (count > 0) {
    logger.info(`expireSessionRequests: ${count} pedido(s) expirado(s)`);
  }
});

export const autoAdvanceSessions = onSchedule(EVERY_10_MIN, async () => {
  const { started, ended } = await advance(db, Timestamp.now());
  if (started + ended > 0) {
    logger.info(`autoAdvanceSessions: ${started} começaram, ${ended} terminaram`);
  }
});

// De hora em hora: o prazo é de 24 h, uma hora a mais não muda nada.
export const autoCompleteSessions = onSchedule({ schedule: 'every 60 minutes', timeZone: 'America/Sao_Paulo' }, async () => {
  const count = await complete(db, Timestamp.now());
  if (count > 0) {
    logger.info(`autoCompleteSessions: ${count} sessão(ões) concluída(s)`);
  }
});
