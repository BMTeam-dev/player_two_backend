// Recalcula os searchCards de todos os usuários, com a mesma lógica dos
// triggers (functions/src/search/cards.ts). Usar depois de mudar o catálogo
// (ex: ordem dos ranks) ou para criar os cartões de quem já tinha perfil
// antes dos triggers existirem. Idempotente: quem já está certo não é escrito.
//
//   Emulador:  npm run dev:rebuild-cards
//   Produção:  npm run db:rebuild-cards   (exige --prod e credencial do gcloud)
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { syncUserCards } from '../functions/src/search/cards.js';

const PROJECT_ID = 'mynoobpro-26215';

async function main() {
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!isEmulator && !process.argv.includes('--prod')) {
    console.error('FIRESTORE_EMULATOR_HOST não definido: isso gravaria no banco de PRODUÇÃO.');
    console.error('Para o emulador use `npm run dev:rebuild-cards`; para produção, passe --prod.');
    process.exit(1);
  }

  initializeApp(isEmulator ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, credential: applicationDefault() });
  const db = getFirestore();

  // Inclui donos de cartões órfãos (usuário apagado), para a sync removê-los.
  const [users, cards] = await Promise.all([
    db.collection('users').select().get(),
    db.collection('searchCards').select('uid').get(),
  ]);
  const uids = new Set([...users.docs.map(d => d.id), ...cards.docs.map(d => d.get('uid') as string)]);

  const total = { written: 0, deleted: 0, gameIdsChanged: 0 };
  for (const uid of uids) {
    const result = await syncUserCards(db, uid, Timestamp.now());
    total.written += result.written;
    total.deleted += result.deleted;
    total.gameIdsChanged += Number(result.gameIdsChanged);
  }
  console.log(`OK: ${uids.size} usuário(s); ${total.written} cartão(ões) gravado(s), ${total.deleted} apagado(s), gameIds corrigido em ${total.gameIdsChanged}.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
