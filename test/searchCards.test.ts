// Testes de syncUserCards contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncUserCards } from '../functions/src/search/cards.js';

const NOW = Timestamp.fromDate(new Date('2026-11-03T15:00:00Z'));
const LATER = Timestamp.fromMillis(NOW.toMillis() + 60 * 60_000);

const user = (overrides: Record<string, unknown> = {}) => ({
  uid: 'a',
  username: 'jogador_a',
  displayName: 'Jogador A',
  avatarUrl: null,
  bio: null,
  country: 'BR',
  region: 'SP',
  languages: ['pt'],
  platforms: ['pc'],
  hasMic: true,
  playstyles: ['chill'],
  gameIds: [],
  availability: {
    state: 'now',
    gameIds: ['valorant'],
    windowStart: null,
    windowEnd: null,
    expiresAt: LATER,
    note: null,
  },
  isOnline: true,
  lastSeenAt: NOW,
  companionStatus: 'none',
  stats: { ratingAvg: 4.5, ratingCount: 3, sessionsCompleted: 5, completionRate: 0.8, avgResponseMinutes: null },
  status: 'active',
  emailVerified: true,
  profileCompletedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const playerGame = (gameId: string, overrides: Record<string, unknown> = {}) => ({
  gameId,
  rankId: 'gold',
  rankOrder: 999, // adulterado de propósito: o cartão usa o do catálogo
  roles: ['duelist'],
  objectives: ['ranked'],
  platforms: ['pc'],
  isMain: false,
  inGameNick: null,
  updatedAt: NOW,
  ...overrides,
});

describe('syncUserCards', () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'search-cards-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    await Promise.all(
      ['users', 'games', 'searchCards', 'listings'].map(name => db.recursiveDelete(db.collection(name))),
    );
    const ranks = [
      { id: 'silver', label: 'Prata', order: 2 },
      { id: 'gold', label: 'Ouro', order: 3 },
    ];
    await db.doc('games/valorant').set({ id: 'valorant', ranks });
    await db.doc('games/lol').set({ id: 'lol', ranks });
    await db.doc('users/a').set(user());
    await db.doc('users/a/games/valorant').set(playerGame('valorant'));
    await db.doc('users/a/games/lol').set(playerGame('lol', { isMain: true }));
  });

  const sync = () => syncUserCards(db, 'a', NOW);
  const card = async (gameId: string) => (await db.doc(`searchCards/a_${gameId}`).get()).data();

  it('cria um cartão por jogo, com rankOrder do catálogo e gameIds com o principal primeiro', async () => {
    expect(await sync()).toEqual({ written: 2, deleted: 0, gameIdsChanged: true });

    expect(await card('valorant')).toMatchObject({
      uid: 'a',
      gameId: 'valorant',
      username: 'jogador_a',
      rankId: 'gold',
      rankOrder: 3,
      languages: ['pt'],
      isOnline: true,
      isCompanion: false,
      listingId: null,
      priceCents: 0,
      ratingAvg: 4.5,
      visible: true,
    });
    expect((await db.doc('users/a').get()).get('gameIds')).toEqual(['lol', 'valorant']);
  });

  it('disponibilidade vale só nos jogos escolhidos', async () => {
    await sync();
    expect(await card('valorant')).toMatchObject({
      availabilityState: 'now',
      availabilityRank: 3,
      availabilityExpiresAt: LATER,
    });
    expect(await card('lol')).toMatchObject({
      availabilityState: 'offline',
      availabilityRank: 0,
      availabilityExpiresAt: null,
    });
  });

  it('não escreve nada quando nada mudou', async () => {
    await sync();
    expect(await sync()).toEqual({ written: 0, deleted: 0, gameIdsChanged: false });
  });

  it('reescreve só o cartão que mudou e apaga o do jogo removido', async () => {
    await sync();
    await db.doc('users/a/games/valorant').update({ rankId: 'silver' });
    await db.doc('users/a/games/lol').delete();

    expect(await sync()).toEqual({ written: 1, deleted: 1, gameIdsChanged: true });
    expect(await card('valorant')).toMatchObject({ rankId: 'silver', rankOrder: 2 });
    expect(await card('lol')).toBeUndefined();
    expect((await db.doc('users/a').get()).get('gameIds')).toEqual(['valorant']);
  });

  it('suspenso ou banido fica invisível', async () => {
    await db.doc('users/a').update({ status: 'banned' });
    await sync();
    expect(await card('valorant')).toMatchObject({ visible: false });
  });

  it('rank que não existe mais no catálogo tira o cartão da busca', async () => {
    await db.doc('users/a/games/valorant').update({ rankId: 'radiant' });
    await sync();
    expect(await card('valorant')).toBeUndefined();
    expect(await card('lol')).toBeDefined();
  });

  it('copia o anúncio ativo do jogo', async () => {
    await db.doc('listings/l1').set({ ownerId: 'a', gameId: 'valorant', category: 'coach', priceCents: 3000, active: true, updatedAt: NOW });
    await db.doc('listings/l2').set({ ownerId: 'a', gameId: 'lol', category: 'coach', priceCents: 5000, active: false, updatedAt: NOW });
    await sync();
    expect(await card('valorant')).toMatchObject({ listingId: 'l1', category: 'coach', priceCents: 3000 });
    expect(await card('lol')).toMatchObject({ listingId: null, priceCents: 0 });
  });

  it('usuário apagado perde todos os cartões', async () => {
    await sync();
    await db.recursiveDelete(db.doc('users/a'));
    expect(await sync()).toEqual({ written: 0, deleted: 2, gameIdsChanged: false });
  });
});
