import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Availability } from '../types.js';

const PAGE_SIZE = 300;
// Teto de páginas por execução: se algo der errado (ex: uma escrita que
// nunca tira o documento da consulta), a função para em vez de rodar até o
// timeout. O que sobrar fica para a próxima execução, 10 min depois.
const MAX_PAGES = 20;

const OFFLINE: Availability = {
  state: 'offline',
  gameIds: [],
  windowStart: null,
  windowEnd: null,
  expiresAt: null,
  note: null,
};

/**
 * Passa para `offline` todo usuário cuja disponibilidade venceu. Devolve
 * quantos documentos foram alterados.
 *
 * `offline` tem `expiresAt` null e o Firestore não inclui null num filtro
 * `<=`, então a consulta só traz disponibilidades realmente vencidas.
 */
export async function expireAvailabilities(db: Firestore, now: Timestamp): Promise<number> {
  let expired = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const snapshot = await db
      .collection('users')
      .where('availability.expiresAt', '<=', now)
      .limit(PAGE_SIZE)
      .get();
    if (snapshot.empty) {
      break;
    }

    // BulkWriter em vez de batch: com a pré-condição, uma escrita recusada
    // não derruba as outras (num batch, uma falha cancela todas).
    const writer = db.bulkWriter();
    writer.onWriteError(() => false);
    const results = snapshot.docs.map(doc =>
      // Pré-condição `lastUpdateTime`: se a pessoa mudou a disponibilidade
      // entre a leitura e a escrita, a escrita falha e a escolha nova fica.
      writer
        .update(doc.ref, { availability: OFFLINE, updatedAt: now }, { lastUpdateTime: doc.updateTime })
        .then(
          () => true,
          () => false,
        ),
    );
    await writer.close();
    expired += (await Promise.all(results)).filter(Boolean).length;

    if (snapshot.size < PAGE_SIZE) {
      break;
    }
  }
  return expired;
}
