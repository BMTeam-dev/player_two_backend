// Grava os dados que o app PRECISA para funcionar: config/app e o catálogo
// de jogos. Idempotente (set + merge): rodar de novo atualiza, não duplica.
//
//   Emulador:  npm run dev:bootstrap
//   Produção:  npm run db:bootstrap   (exige --prod e credencial do gcloud)
import { readFileSync } from 'node:fs';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import type { AppConfig, Game } from '../functions/src/types.js';

const PROJECT_ID = 'mynoobpro-26215';

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./data/${file}`, import.meta.url), 'utf8')) as T;

async function main() {
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

  if (!isEmulator && !process.argv.includes('--prod')) {
    console.error('FIRESTORE_EMULATOR_HOST não definido: isso gravaria no banco de PRODUÇÃO.');
    console.error('Para o emulador use `npm run dev:bootstrap`; para produção, passe --prod.');
    process.exit(1);
  }

  initializeApp(
    isEmulator ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, credential: applicationDefault() },
  );
  const db = getFirestore();

  const games = readJson<Game[]>('games.json');
  const config = readJson<Omit<AppConfig, 'updatedAt'>>('config.json');

  const unknownActive = config.activeGameIds.filter(id => !games.some(g => g.id === id));
  if (unknownActive.length > 0) {
    throw new Error(`config.activeGameIds cita jogos inexistentes em games.json: ${unknownActive.join(', ')}`);
  }

  const batch = db.batch();
  batch.set(db.doc('config/app'), { ...config, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  for (const game of games) {
    batch.set(db.doc(`games/${game.id}`), game, { merge: true });
  }
  await batch.commit();

  console.log(`OK: config/app + ${games.length} jogos gravados no ${isEmulator ? 'EMULADOR' : 'banco de PRODUÇÃO'}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
