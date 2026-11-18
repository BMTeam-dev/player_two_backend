// Recalcula `stats` de todos os usuários, com a mesma lógica dos triggers
// (functions/src/stats/stats.ts). Usar depois de mudar a fórmula ou para
// preencher quem já tinha sessões e avaliações antes dos triggers existirem.
// Idempotente: quem já está certo não é escrito.
//
//   Emulador:  npm run dev:rebuild-stats
//   Produção:  npm run db:rebuild-stats   (exige --prod e credencial do gcloud)
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { refreshUserStats } from '../functions/src/stats/stats.js';

const PROJECT_ID = 'mynoobpro-26215';

async function main() {
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!isEmulator && !process.argv.includes('--prod')) {
    console.error('FIRESTORE_EMULATOR_HOST não definido: isso gravaria no banco de PRODUÇÃO.');
    console.error('Para o emulador use `npm run dev:rebuild-stats`; para produção, passe --prod.');
    process.exit(1);
  }

  initializeApp(isEmulator ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, credential: applicationDefault() });
  const db = getFirestore();

  const users = await db.collection('users').select().get();
  let written = 0;
  for (const user of users.docs) {
    written += Number(await refreshUserStats(db, user.id));
  }
  console.log(`OK: ${users.size} usuário(s); stats atualizadas em ${written}.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
