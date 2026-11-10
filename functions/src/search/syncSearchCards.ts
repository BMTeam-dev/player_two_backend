import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from '../lib/admin.js';
import { syncUserCards } from './cards.js';

// Três triggers, uma só lógica: qualquer mudança em perfil, jogo ou anúncio
// recalcula todos os cartões do dono. Mais leituras que um update pontual,
// mas não há como um cartão divergir da origem por um caso esquecido.
async function sync(uid: string, source: string) {
  const result = await syncUserCards(db, uid, Timestamp.now());
  if (result.written || result.deleted || result.gameIdsChanged) {
    logger.debug(`searchCards de ${uid} (${source})`, result);
  }
}

// Também reage às escritas da própria sync (`gameIds`), da presença e do
// expireAvailability; sem mudança nos cartões, não escreve nada.
export const onUserWrittenSyncCards = onDocumentWritten('users/{uid}', event => sync(event.params.uid, 'user'));

export const onPlayerGameWrittenSyncCards = onDocumentWritten('users/{uid}/games/{gameId}', event =>
  sync(event.params.uid, 'game'),
);

export const onListingWrittenSyncCards = onDocumentWritten('listings/{listingId}', async event => {
  const owners = new Set(
    [event.data?.before.get('ownerId'), event.data?.after.get('ownerId')].filter(
      (uid): uid is string => typeof uid === 'string',
    ),
  );
  await Promise.all([...owners].map(uid => sync(uid, 'listing')));
});
