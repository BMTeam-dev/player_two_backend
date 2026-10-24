// Popula o EMULADOR com ~30 jogadores de teste para a tela Explorar ter
// conteúdo durante o desenvolvimento. Nunca roda contra produção.
//
//   npm run dev:seed   (com `npm run emulators` rodando e depois do dev:bootstrap)
//
// Login no app (emulador de Auth): dev01@mynoobpro.test ... dev30@mynoobpro.test,
// senha `senha123`.
//
// Enquanto os triggers do Bloco 2 não existem, este script grava os
// searchCards direto. Quando o trigger de searchCards estiver pronto, ele
// passa a gerá-los sozinho e esta parte pode ser removida.
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import {
  AVAILABILITY_RANK,
  type AvailabilityState,
  type Category,
  type Game,
  type Language,
  type Objective,
  type Playstyle,
} from '../functions/src/types.js';

const PROJECT_ID = 'mynoobpro-26215';
const USER_COUNT = 30;
const PASSWORD = 'senha123';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Este script só roda contra o emulador (FIRESTORE_EMULATOR_HOST e FIREBASE_AUTH_EMULATOR_HOST).');
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const auth = getAuth();

const games = JSON.parse(readFileSync(new URL('./data/games.json', import.meta.url), 'utf8')) as Game[];

// PRNG com semente fixa: o seed gera sempre os mesmos dados.
let state = 42;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 2 ** 32;
  return state / 2 ** 32;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const pickSome = <T>(list: readonly T[], min: number, max: number): T[] => {
  const count = min + Math.floor(rand() * (max - min + 1));
  return [...list].sort(() => rand() - 0.5).slice(0, count);
};

const NICKS = [
  'BiaClutch', 'TheuzinAWP', 'LuhSupport', 'RafaJungle', 'NandaMid', 'KaioEntry', 'DudaSmoke',
  'GuiOneTap', 'MariFlash', 'JoãoBaiter', 'Leh_ADC', 'PedroIGL', 'CamiHeals', 'VitinTop',
  'IsaRadiant', 'Brunão', 'Ju_Lurker', 'FeFeDuelist', 'CaioMacro', 'LariWard', 'TiagoRush',
  'SofiSage', 'MatheusRiot', 'AnaPeek', 'LeoCombo', 'GabiTilt', 'RenanEco', 'Bel_Gank',
  'DaniSpray', 'ZéDefuse',
];
const REGIONS = ['SP', 'RJ', 'MG', 'CE', 'PE', 'BA', 'RS', 'PR', 'DF', 'GO'];
const PLAYSTYLES: Playstyle[] = ['chill', 'tryhard', 'teaching', 'funny', 'strategic', 'silent'];
const OBJECTIVES: Objective[] = ['casual', 'ranked', 'coop', 'party', 'coaching', 'companion'];
const STATES: AvailabilityState[] = ['now', 'now', 'today', 'window', 'offline'];

const minutesFromNow = (min: number) => Timestamp.fromMillis(Date.now() + min * 60_000);

async function clearPreviousSeed() {
  const { users } = await auth.listUsers(1000);
  const seeded = users.filter(u => u.email?.endsWith('@mynoobpro.test'));
  if (seeded.length > 0) {
    await auth.deleteUsers(seeded.map(u => u.uid));
  }
  for (const path of ['users', 'usernames', 'searchCards', 'listings']) {
    await db.recursiveDelete(db.collection(path));
  }
}

async function main() {
  await clearPreviousSeed();
  const now = Timestamp.now();
  let batch: WriteBatch = db.batch();
  let ops = 0;
  const queue = async (fn: (b: WriteBatch) => void, count = 1) => {
    fn(batch);
    ops += count;
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (let i = 0; i < USER_COUNT; i++) {
    const n = String(i + 1).padStart(2, '0');
    const displayName = NICKS[i];
    const username = displayName.toLowerCase().normalize('NFD').replace(/[^a-z0-9_]/g, '');
    const email = `dev${n}@mynoobpro.test`;
    const { uid } = await auth.createUser({ email, password: PASSWORD, displayName, emailVerified: true });

    const isCompanion = i % 4 === 0;
    const userGames = pickSome(games, 1, 2);
    const availabilityState = pick(STATES);
    const languages: Language[] = rand() < 0.3 ? ['pt', 'en'] : ['pt'];
    const playstyles = pickSome(PLAYSTYLES, 1, 2);
    const hasMic = rand() < 0.85;
    const ratingCount = Math.floor(rand() * 40);
    const ratingAvg = ratingCount === 0 ? 0 : Math.round((3.8 + rand() * 1.2) * 10) / 10;
    const sessionsCompleted = ratingCount + Math.floor(rand() * 10);
    const completionRate = sessionsCompleted === 0 ? 1 : Math.round((0.85 + rand() * 0.15) * 100) / 100;
    const isOnline = availabilityState === 'now' || rand() < 0.2;

    const availability = {
      state: availabilityState,
      gameIds: availabilityState === 'offline' ? [] : userGames.map(g => g.id),
      windowStart: availabilityState === 'window' ? minutesFromNow(120) : null,
      windowEnd: availabilityState === 'window' ? minutesFromNow(300) : null,
      expiresAt:
        availabilityState === 'now' ? minutesFromNow(120)
        : availabilityState === 'today' ? minutesFromNow(360)
        : availabilityState === 'window' ? minutesFromNow(300)
        : null,
      note: availabilityState === 'offline' ? null : pick(['Bora ranked!', 'Sem toxicidade', 'Ensino iniciantes', null]),
    };

    await queue(b => {
      b.set(db.doc(`usernames/${username}`), { uid, createdAt: now });
      b.set(db.doc(`users/${uid}`), {
        uid,
        username,
        displayName,
        avatarUrl: null,
        bio: pick(['Jogo pra me divertir.', 'Foco em subir de elo.', 'Chama pra duo!', null]),
        country: 'BR',
        region: pick(REGIONS),
        languages,
        platforms: ['pc'],
        hasMic,
        playstyles,
        gameIds: userGames.map(g => g.id),
        availability,
        isOnline,
        lastSeenAt: now,
        companionStatus: isCompanion ? 'approved' : 'none',
        stats: { ratingAvg, ratingCount, sessionsCompleted, completionRate, avgResponseMinutes: 5 + Math.floor(rand() * 30) },
        status: 'active',
        emailVerified: true,
        profileCompletedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      b.set(db.doc(`users/${uid}/private/data`), {
        email,
        birthDate: `${1990 + Math.floor(rand() * 15)}-0${1 + Math.floor(rand() * 9)}-15`,
        ageConfirmedAt: now,
        termsVersion: '2026-10-v1',
        termsAcceptedAt: now,
        fcmTokens: [],
        notificationPrefs: { sessionRequests: true, sessionUpdates: true, messages: true, lfg: true, reminders: true },
        rateLimit: { sessionRequestsWindowStart: null, sessionRequestsCount: 0 },
      });
    }, 3);

    for (const [gi, game] of userGames.entries()) {
      const rank = pick(game.ranks);
      const roles = pickSome(game.roles.map(r => r.id), 1, 2);
      const objectives = pickSome(OBJECTIVES.filter(o => isCompanion || o !== 'companion'), 1, 3);

      let listingId: string | null = null;
      let category: Category | null = null;
      let priceCents = 0;
      if (isCompanion && gi === 0) {
        listingId = db.collection('listings').doc().id;
        category = pick<Category>(['play_together', 'companion', 'coaching']);
        priceCents = pick([0, 1000, 1500, 2000, 3000]);
        await queue(b => b.set(db.doc(`listings/${listingId}`), {
          id: listingId,
          ownerId: uid,
          gameId: game.id,
          category,
          title: category === 'coaching' ? `Coaching de ${game.name}` : `Duo de ${game.name}`,
          description: 'Jogo tranquilo, sem toxicidade. Chama no chat pra combinar!',
          priceCents,
          pricingUnit: 'hour',
          sessionMinutes: 60,
          languages,
          platforms: ['pc'],
          active: true,
          ownerSnapshot: { displayName, avatarUrl: null, ratingAvg, ratingCount },
          createdAt: now,
          updatedAt: now,
        }));
      }

      await queue(b => {
        b.set(db.doc(`users/${uid}/games/${game.id}`), {
          gameId: game.id,
          rankId: rank.id,
          rankOrder: rank.order,
          roles,
          objectives,
          platforms: ['pc'],
          isMain: gi === 0,
          inGameNick: null,
          updatedAt: now,
        });
        b.set(db.doc(`searchCards/${uid}_${game.id}`), {
          uid,
          gameId: game.id,
          username,
          displayName,
          avatarUrl: null,
          rankId: rank.id,
          rankOrder: rank.order,
          roles,
          objectives,
          platforms: ['pc'],
          languages,
          playstyles,
          hasMic,
          availabilityState: availability.gameIds.includes(game.id) ? availabilityState : 'offline',
          availabilityRank: availability.gameIds.includes(game.id) ? AVAILABILITY_RANK[availabilityState] : 0,
          availabilityExpiresAt: availability.expiresAt,
          isOnline,
          isCompanion,
          listingId,
          category,
          priceCents,
          ratingAvg,
          ratingCount,
          sessionsCompleted,
          completionRate,
          visible: true,
          updatedAt: now,
        });
      }, 2);
    }
  }

  await batch.commit();
  console.log(`OK: ${USER_COUNT} jogadores de teste criados no emulador (senha: ${PASSWORD}).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
