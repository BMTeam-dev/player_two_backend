// Testes das regras do Firestore contra o emulador (`npm test`).
// Cobrem os pontos onde um erro custa caro: vazamento de dados de outra
// pessoa e o usuário escrevendo campos que só o servidor pode escrever.
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';

const baseUser = (uid: string) => ({
  uid,
  username: uid,
  displayName: uid.toUpperCase(),
  avatarUrl: null,
  bio: null,
  country: 'BR',
  region: 'SP',
  languages: ['pt'],
  platforms: ['pc'],
  hasMic: true,
  playstyles: ['chill'],
  gameIds: [],
  availability: { state: 'offline', gameIds: [], windowStart: null, windowEnd: null, expiresAt: null, note: null },
  isOnline: false,
  lastSeenAt: null,
  companionStatus: 'none',
  stats: { ratingAvg: 0, ratingCount: 0, sessionsCompleted: 0, completionRate: 1, avgResponseMinutes: null },
  status: 'active',
  emailVerified: true,
  profileCompletedAt: null,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-mynoobpro',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

// Estado inicial gravado "como servidor" (ignora regras), igual às Functions.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'games/valorant'), { id: 'valorant', name: 'Valorant' });
    await setDoc(doc(db, `users/${ALICE}`), baseUser(ALICE));
    await setDoc(doc(db, `users/${BOB}`), baseUser(BOB));
    await setDoc(doc(db, `users/${ALICE}/private/data`), { email: 'a@x.com', fcmTokens: [], notificationPrefs: {} });
    await setDoc(doc(db, 'sessions/s1'), { participantIds: [ALICE, BOB], status: 'requested' });
    await setDoc(doc(db, 'conversations/c1'), { participantIds: [ALICE, BOB], lockedAt: null, unread: { [ALICE]: 3, [BOB]: 1 } });
    await setDoc(doc(db, 'conversations/c2'), { participantIds: [ALICE, BOB], lockedAt: new Date() });
    await setDoc(doc(db, 'config/app'), { minAppVersion: '0.0.1' });
    await setDoc(doc(db, 'searchCards/visible'), { visible: true });
    await setDoc(doc(db, 'searchCards/hidden'), { visible: false });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const minutesFromNow = (m: number) => Timestamp.fromMillis(Date.now() + m * 60_000);

describe('config', () => {
  it('sem login lê config/app (checagem de versão mínima)', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'config/app')));
  });

  it('ninguém escreve config', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'config/app'), { minAppVersion: '9.9.9' }));
  });
});

describe('users', () => {
  it('sem login não lê perfis', async () => {
    await assertFails(getDoc(doc(anon(), `users/${ALICE}`)));
  });

  it('logado lê o perfil de outra pessoa', async () => {
    await assertSucceeds(getDoc(doc(as(BOB), `users/${ALICE}`)));
  });

  it('dono edita campos de perfil', async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), `users/${ALICE}`), { displayName: 'Alice Nova', bio: 'Oi' }));
  });

  it('dono NÃO altera stats, status ou companionStatus', async () => {
    const ref = doc(as(ALICE), `users/${ALICE}`);
    await assertFails(updateDoc(ref, { 'stats.ratingAvg': 5 }));
    await assertFails(updateDoc(ref, { status: 'active' , companionStatus: 'approved' }));
  });

  it('avatar só do próprio caminho no Storage', async () => {
    const ref = doc(as(ALICE), `users/${ALICE}`);
    const storage = 'https://firebasestorage.googleapis.com/v0/b/mynoobpro-26215.firebasestorage.app/o';
    await assertSucceeds(updateDoc(ref, { avatarUrl: `${storage}/avatars%2F${ALICE}%2Fa.jpg?alt=media&token=x` }));
    await assertFails(updateDoc(ref, { avatarUrl: `${storage}/avatars%2F${BOB}%2Fb.jpg?alt=media` }));
    await assertFails(updateDoc(ref, { avatarUrl: 'https://exemplo.com/foto.jpg' }));
  });

  it('disponibilidade com prazo coerente', async () => {
    const ref = doc(as(ALICE), `users/${ALICE}`);
    const base = { gameIds: ['valorant'], windowStart: null, windowEnd: null, note: null };
    await assertSucceeds(updateDoc(ref, { availability: { ...base, state: 'now', expiresAt: minutesFromNow(120) } }));
    await assertSucceeds(updateDoc(ref, { availability: { ...base, state: 'today', expiresAt: minutesFromNow(600) } }));
    const start = minutesFromNow(60);
    const end = minutesFromNow(180);
    await assertSucceeds(
      updateDoc(ref, { availability: { ...base, state: 'window', windowStart: start, windowEnd: end, expiresAt: end } }),
    );
  });

  it('não fica "disponível agora" para sempre', async () => {
    const ref = doc(as(ALICE), `users/${ALICE}`);
    const base = { gameIds: ['valorant'], windowStart: null, windowEnd: null, note: null };
    await assertFails(updateDoc(ref, { availability: { ...base, state: 'now', expiresAt: minutesFromNow(60 * 24 * 365) } }));
    await assertFails(updateDoc(ref, { availability: { ...base, state: 'now', expiresAt: null } }));
    await assertFails(updateDoc(ref, { availability: { ...base, state: 'today', expiresAt: minutesFromNow(60 * 48) } }));
  });

  it('ninguém edita o perfil de outra pessoa', async () => {
    await assertFails(updateDoc(doc(as(BOB), `users/${ALICE}`), { displayName: 'Hackeado' }));
  });

  it('cliente não cria perfil direto (é a Function completeOnboarding)', async () => {
    await assertFails(setDoc(doc(as(CAROL), `users/${CAROL}`), baseUser(CAROL)));
  });

  it('dados privados só o dono lê', async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), `users/${ALICE}/private/data`)));
    await assertFails(getDoc(doc(as(BOB), `users/${ALICE}/private/data`)));
  });
});

describe('users/{uid}/games', () => {
  const playerGame = {
    gameId: 'valorant',
    rankId: 'gold',
    rankOrder: 4,
    roles: ['duelist'],
    objectives: ['ranked'],
    platforms: ['pc'],
    isMain: true,
    inGameNick: null,
  };

  it('dono adiciona jogo existente no catálogo', async () => {
    await assertSucceeds(
      setDoc(doc(as(ALICE), `users/${ALICE}/games/valorant`), { ...playerGame, updatedAt: serverTimestamp() }),
    );
  });

  it('não aceita jogo fora do catálogo', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), `users/${ALICE}/games/fortnite`), {
        ...playerGame,
        gameId: 'fortnite',
        updatedAt: serverTimestamp(),
      }),
    );
  });
});

describe('searchCards', () => {
  it('lê cartão visível e não lê cartão oculto', async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), 'searchCards/visible')));
    await assertFails(getDoc(doc(as(ALICE), 'searchCards/hidden')));
  });

  it('cliente não escreve cartões', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'searchCards/fake'), { visible: true }));
  });
});

describe('sessions', () => {
  it('só participantes leem a sessão', async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), 'sessions/s1')));
    await assertFails(getDoc(doc(as(CAROL), 'sessions/s1')));
  });

  it('nem participante altera status direto (é Function)', async () => {
    await assertFails(updateDoc(doc(as(BOB), 'sessions/s1'), { status: 'accepted' }));
  });
});

describe('messages', () => {
  const message = (id: string, senderId: string) => ({
    id,
    senderId,
    type: 'text',
    text: 'bora jogar?',
    systemEvent: null,
    flagged: false,
    createdAt: serverTimestamp(),
  });

  it('participante envia mensagem própria', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'conversations/c1/messages/m1'), message('m1', ALICE)));
  });

  it('não envia em nome de outra pessoa', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'conversations/c1/messages/m2'), message('m2', BOB)));
  });

  it('quem não participa não envia nem lê', async () => {
    await assertFails(setDoc(doc(as(CAROL), 'conversations/c1/messages/m3'), message('m3', CAROL)));
    await assertFails(getDoc(doc(as(CAROL), 'conversations/c1')));
  });

  it('não envia em conversa trancada (bloqueio/moderação)', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'conversations/c2/messages/m4'), message('m4', ALICE)));
  });

  it('participante zera só o próprio contador de não lidas', async () => {
    const ref = doc(as(ALICE), 'conversations/c1');
    await assertSucceeds(updateDoc(ref, { [`unread.${ALICE}`]: 0 }));
    await assertFails(updateDoc(ref, { [`unread.${BOB}`]: 0 }));
    await assertFails(updateDoc(ref, { [`unread.${ALICE}`]: 5 }));
    await assertFails(updateDoc(ref, { lockedAt: new Date(), [`unread.${ALICE}`]: 0 }));
    await assertFails(updateDoc(doc(as(CAROL), 'conversations/c1'), { [`unread.${CAROL}`]: 0 }));
  });

  it('cliente não cria mensagem de sistema', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'conversations/c1/messages/m5'), { ...message('m5', ALICE), type: 'system' }),
    );
  });
});

describe('reports', () => {
  it('cliente não cria nem lê denúncia direto (é a Function submitReport)', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'reports/r1'), {
        id: 'r1',
        reporterId: ALICE,
        targetType: 'user',
        targetId: BOB,
        targetUserId: BOB,
        reason: 'fraud',
        status: 'open',
        createdAt: serverTimestamp(),
      }),
    );
    await assertFails(getDoc(doc(as(ALICE), 'reports/r1')));
  });
});
