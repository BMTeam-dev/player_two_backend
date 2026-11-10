// Testes de upsertListing/deactivateListing: validação do payload (puro) e as
// transactions contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deactivateListing, parseListingInput, saveListing } from '../functions/src/listings/listing.js';

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  gameId: 'valorant',
  category: 'play_together',
  title: '  Duo de Valorant  ',
  description: 'Jogo tranquilo.',
  priceCents: 0,
  pricingUnit: 'hour',
  sessionMinutes: 60,
  languages: ['pt'],
  platforms: ['pc'],
  ...overrides,
});

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason;
  }
  return undefined;
};

const asyncReasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { details?: { reason?: string } }).details?.reason;
  }
  return undefined;
};

describe('parseListingInput', () => {
  it('normaliza título e descrição e trata listingId ausente como anúncio novo', () => {
    const input = parseListingInput(validPayload());
    expect(input.title).toBe('Duo de Valorant');
    expect(input.listingId).toBeNull();
  });

  it('recusa título curto/longo e descrição longa', () => {
    expect(reasonOf(() => parseListingInput(validPayload({ title: ' ab ' })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ title: 'x'.repeat(61) })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ description: 'x'.repeat(501) })))).toBe('invalid_input');
  });

  it('recusa preço quebrado, negativo ou acima do teto', () => {
    expect(reasonOf(() => parseListingInput(validPayload({ priceCents: 10.5 })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ priceCents: -1 })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ priceCents: 100_001 })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ priceCents: 100_000 })))).toBeUndefined();
  });

  it('recusa duração fora de 15-240 min ou fora dos passos de 15', () => {
    expect(reasonOf(() => parseListingInput(validPayload({ sessionMinutes: 0 })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ sessionMinutes: 50 })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ sessionMinutes: 255 })))).toBe('invalid_input');
  });

  it('recusa categoria, unidade e listas fora dos enums', () => {
    expect(reasonOf(() => parseListingInput(validPayload({ category: 'boosting' })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ pricingUnit: 'day' })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ languages: [] })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ platforms: ['atari'] })))).toBe('invalid_input');
    expect(reasonOf(() => parseListingInput(validPayload({ gameId: 'a/b' })))).toBe('invalid_input');
  });
});

describe('saveListing / deactivateListing (emulador)', () => {
  let app: App;
  let db: Firestore;
  const NOW = Timestamp.fromDate(new Date('2026-11-10T15:00:00Z'));
  const save = (overrides: Record<string, unknown> = {}, uid = 'alice') =>
    saveListing(db, uid, parseListingInput(validPayload(overrides)), NOW);

  const seedUser = async (uid: string, fields: Record<string, unknown> = {}) => {
    await db.doc(`users/${uid}`).set({
      uid,
      displayName: 'Alice',
      avatarUrl: null,
      companionStatus: 'none',
      status: 'active',
      profileCompletedAt: NOW,
      stats: { ratingAvg: 4.5, ratingCount: 2, sessionsCompleted: 2, completionRate: 1, avgResponseMinutes: null },
      ...fields,
    });
    for (const gameId of ['valorant', 'lol', 'cs2']) {
      await db.doc(`users/${uid}/games/${gameId}`).set({ gameId, rankId: 'r1', isMain: gameId === 'valorant' });
    }
  };

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'listings-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['users', 'listings', 'config', 'games']) {
      await db.recursiveDelete(db.collection(path));
    }
    await db.doc('config/app').set({ maxActiveListingsPerUser: 2 });
    for (const id of ['valorant', 'lol', 'cs2']) {
      await db.doc(`games/${id}`).set({ id, active: true, ranks: [] });
    }
    await seedUser('alice');
  });

  it('cria o anúncio ativo com o snapshot do dono', async () => {
    const { listingId } = await save();
    const listing = (await db.doc(`listings/${listingId}`).get()).data()!;
    expect(listing).toMatchObject({
      id: listingId,
      ownerId: 'alice',
      gameId: 'valorant',
      title: 'Duo de Valorant',
      active: true,
      ownerSnapshot: { displayName: 'Alice', avatarUrl: null, ratingAvg: 4.5, ratingCount: 2 },
    });
    expect(listing).not.toHaveProperty('listingId');
  });

  it('edita mantendo createdAt e não deixa trocar o jogo', async () => {
    const { listingId } = await save();
    const createdAt = (await db.doc(`listings/${listingId}`).get()).get('createdAt') as Timestamp;
    const later = Timestamp.fromMillis(NOW.toMillis() + 60_000);
    await saveListing(db, 'alice', parseListingInput(validPayload({ listingId, title: 'Novo título' })), later);
    const listing = (await db.doc(`listings/${listingId}`).get()).data()!;
    expect(listing.title).toBe('Novo título');
    expect((listing.createdAt as Timestamp).isEqual(createdAt)).toBe(true);
    expect((listing.updatedAt as Timestamp).isEqual(later)).toBe(true);

    expect(await asyncReasonOf(save({ listingId, gameId: 'lol' }))).toBe('invalid_input');
  });

  it('não edita anúncio de outra pessoa', async () => {
    await seedUser('bob');
    const { listingId } = await save({}, 'bob');
    expect(await asyncReasonOf(save({ listingId }))).toBe('listing_not_found');
    expect(await asyncReasonOf(deactivateListing(db, 'alice', listingId, NOW))).toBe('listing_not_found');
  });

  it('preço só para companion aprovado', async () => {
    expect(await asyncReasonOf(save({ priceCents: 1500 }))).toBe('price_requires_companion');
    await db.doc('users/alice').update({ companionStatus: 'approved' });
    expect(await asyncReasonOf(save({ priceCents: 1500 }))).toBeUndefined();
  });

  it('exige o jogo no perfil, perfil completo e conta ativa', async () => {
    await db.doc('users/alice/games/cs2').delete();
    expect(await asyncReasonOf(save({ gameId: 'cs2' }))).toBe('game_not_in_profile');
    await db.doc('games/lol').update({ active: false });
    expect(await asyncReasonOf(save({ gameId: 'lol' }))).toBe('game_not_in_profile');

    await db.doc('users/alice').update({ status: 'suspended' });
    expect(await asyncReasonOf(save())).toBe('account_restricted');
    expect(await asyncReasonOf(save({}, 'ghost'))).toBe('no_profile');
  });

  it('1 ativo por jogo e no máximo maxActiveListingsPerUser no total', async () => {
    const { listingId } = await save();
    expect(await asyncReasonOf(save())).toBe('game_has_listing');
    await save({ gameId: 'lol' });
    expect(await asyncReasonOf(save({ gameId: 'cs2' }))).toBe('limit_reached');

    // Editar um dos ativos não conta contra o limite.
    expect(await asyncReasonOf(save({ listingId, title: 'Editado' }))).toBeUndefined();

    await deactivateListing(db, 'alice', listingId, NOW);
    expect(await asyncReasonOf(save({ gameId: 'cs2' }))).toBeUndefined();
    // Reativar o desativado agora passaria do limite.
    expect(await asyncReasonOf(save({ listingId }))).toBe('limit_reached');
  });

  it('desativa e é idempotente', async () => {
    const { listingId } = await save();
    await deactivateListing(db, 'alice', listingId, NOW);
    const updatedAt = (await db.doc(`listings/${listingId}`).get()).get('updatedAt') as Timestamp;
    await deactivateListing(db, 'alice', listingId, Timestamp.fromMillis(NOW.toMillis() + 60_000));
    const listing = (await db.doc(`listings/${listingId}`).get()).data()!;
    expect(listing.active).toBe(false);
    expect((listing.updatedAt as Timestamp).isEqual(updatedAt)).toBe(true);
  });
});
