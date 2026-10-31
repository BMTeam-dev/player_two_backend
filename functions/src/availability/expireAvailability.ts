import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/admin.js';
import { expireAvailabilities } from './expire.js';

// A cada 10 min (MVP.md 7.3): um "agora" vencido pode ficar até 10 min a
// mais na busca. O app já mostra como offline quem passou do `expiresAt`,
// então o atraso só aparece para quem ainda não atualizou a tela.
export const expireAvailability = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const count = await expireAvailabilities(db, Timestamp.now());
    if (count > 0) {
      logger.info(`expireAvailability: ${count} disponibilidade(s) vencida(s)`);
    }
  },
);
