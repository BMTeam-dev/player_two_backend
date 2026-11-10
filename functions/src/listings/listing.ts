import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import {
  CATEGORIES,
  LANGUAGES,
  PLATFORMS,
  type AppConfig,
  type Category,
  type Game,
  type Language,
  type Listing,
  type Platform,
  type User,
} from '../types.js';

export const TITLE_MIN = 3;
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 500;
// Teto contra erro de digitação (R$ 15000 em vez de R$ 150,00): o preço é só
// de referência, mas aparece na busca e no perfil.
export const MAX_PRICE_CENTS = 100_000;
export const SESSION_MINUTES_MIN = 15;
export const SESSION_MINUTES_MAX = 240;
// Vale se `config/app` estiver sem o campo: o mesmo número do bootstrap.
const DEFAULT_MAX_ACTIVE_LISTINGS = 3;

/** Erro de validação: `details.reason` é o que o app usa para escolher a mensagem. */
export type ListingErrorReason =
  | 'invalid_input'
  | 'no_profile'
  | 'account_restricted'
  | 'listing_not_found'
  | 'game_not_in_profile'
  | 'price_requires_companion'
  | 'game_has_listing'
  | 'limit_reached';

export interface ListingInput {
  listingId: string | null; // null = anúncio novo
  gameId: string;
  category: Category;
  title: string;
  description: string;
  priceCents: number;
  pricingUnit: 'hour' | 'session';
  sessionMinutes: number;
  languages: Language[];
  platforms: Platform[];
}

const fail = (code: FunctionsErrorCode, reason: ListingErrorReason, message: string) =>
  new HttpsError(code, message, { reason });

const isSubsetOf = <T extends string>(v: unknown, allowed: readonly T[], min: number, max: number): v is T[] =>
  Array.isArray(v)
  && v.length >= min
  && v.length <= max
  && new Set(v).size === v.length
  && v.every(item => (allowed as readonly unknown[]).includes(item));

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !v.includes('/');

/** Valida e normaliza o payload de `upsertListing` (o cliente pode mandar qualquer coisa). */
export function parseListingInput(data: unknown): ListingInput {
  if (typeof data !== 'object' || data === null) {
    throw fail('invalid-argument', 'invalid_input', 'Payload ausente.');
  }
  const raw = data as Record<string, unknown>;

  const listingId = raw.listingId ?? null;
  if (listingId !== null && !isId(listingId)) {
    throw fail('invalid-argument', 'invalid_input', 'listingId inválido.');
  }
  if (!isId(raw.gameId)) {
    throw fail('invalid-argument', 'invalid_input', 'Jogo obrigatório.');
  }
  if (!(CATEGORIES as readonly unknown[]).includes(raw.category)) {
    throw fail('invalid-argument', 'invalid_input', 'Categoria inválida.');
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw fail('invalid-argument', 'invalid_input', `Título deve ter ${TITLE_MIN}-${TITLE_MAX} caracteres.`);
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > DESCRIPTION_MAX) {
    throw fail('invalid-argument', 'invalid_input', `Descrição deve ter até ${DESCRIPTION_MAX} caracteres.`);
  }

  const { priceCents, sessionMinutes } = raw;
  if (typeof priceCents !== 'number' || !Number.isInteger(priceCents) || priceCents < 0 || priceCents > MAX_PRICE_CENTS) {
    throw fail('invalid-argument', 'invalid_input', 'Preço inválido.');
  }
  if (raw.pricingUnit !== 'hour' && raw.pricingUnit !== 'session') {
    throw fail('invalid-argument', 'invalid_input', 'Unidade de preço inválida.');
  }
  if (
    typeof sessionMinutes !== 'number'
    || !Number.isInteger(sessionMinutes)
    || sessionMinutes < SESSION_MINUTES_MIN
    || sessionMinutes > SESSION_MINUTES_MAX
    || sessionMinutes % 15 !== 0
  ) {
    throw fail('invalid-argument', 'invalid_input', 'Duração inválida.');
  }
  if (!isSubsetOf(raw.languages, LANGUAGES, 1, 3)) {
    throw fail('invalid-argument', 'invalid_input', 'Idiomas inválidos.');
  }
  if (!isSubsetOf(raw.platforms, PLATFORMS, 1, 5)) {
    throw fail('invalid-argument', 'invalid_input', 'Plataformas inválidas.');
  }

  return {
    listingId,
    gameId: raw.gameId,
    category: raw.category as Category,
    title,
    description,
    priceCents,
    pricingUnit: raw.pricingUnit,
    sessionMinutes,
    languages: raw.languages,
    platforms: raw.platforms,
  };
}

/**
 * Cria ou edita um anúncio, sempre deixando-o ativo. Numa transaction porque
 * os limites (1 ativo por jogo, `maxActiveListingsPerUser` no total) dependem
 * dos outros anúncios: dois toques rápidos em "Salvar" não podem passar os dois.
 *
 * `db` e `now` vêm de fora pelo mesmo motivo de `createProfile`
 * (users/onboarding.ts): os testes usam outra cópia do firebase-admin.
 */
export async function saveListing(db: Firestore, uid: string, input: ListingInput, now: Timestamp) {
  const userRef = db.doc(`users/${uid}`);
  const listingRef = input.listingId ? db.doc(`listings/${input.listingId}`) : db.collection('listings').doc();

  await db.runTransaction(async tx => {
    const [userSnap, configSnap, playerGameSnap, gameSnap, activeSnap, existingSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(db.doc('config/app')),
      tx.get(userRef.collection('games').doc(input.gameId)),
      tx.get(db.doc(`games/${input.gameId}`)),
      tx.get(db.collection('listings').where('ownerId', '==', uid).where('active', '==', true)),
      input.listingId ? tx.get(listingRef) : Promise.resolve(null),
    ]);

    const user = userSnap.data() as User | undefined;
    if (!user || user.profileCompletedAt == null) {
      throw fail('failed-precondition', 'no_profile', 'Complete seu perfil antes de anunciar.');
    }
    if (user.status !== 'active') {
      throw fail('permission-denied', 'account_restricted', 'Sua conta não pode criar anúncios.');
    }

    let createdAt = now;
    if (existingSnap) {
      const existing = existingSnap.data() as Listing | undefined;
      if (!existing || existing.ownerId !== uid) {
        throw fail('not-found', 'listing_not_found', 'Anúncio não encontrado.');
      }
      // Trocar o jogo seria outro anúncio: as sessões já pedidas guardam o
      // `listingId` e esperam o mesmo jogo.
      if (existing.gameId !== input.gameId) {
        throw fail('invalid-argument', 'invalid_input', 'O jogo de um anúncio não muda.');
      }
      createdAt = existing.createdAt as Timestamp;
    }

    // Sem o jogo no perfil o anúncio não entra na busca (os cartões são um
    // por jogo do perfil, search/cards.ts) e ficaria visível só no perfil.
    const game = gameSnap.data() as Game | undefined;
    if (!playerGameSnap.exists || !game?.active) {
      throw fail('failed-precondition', 'game_not_in_profile', 'Adicione este jogo ao seu perfil antes de anunciar.');
    }
    if (input.priceCents > 0 && user.companionStatus !== 'approved') {
      throw fail('permission-denied', 'price_requires_companion', 'Só companions aprovados podem anunciar com preço.');
    }

    const others = activeSnap.docs.filter(d => d.id !== listingRef.id).map(d => d.data() as Listing);
    if (others.some(l => l.gameId === input.gameId)) {
      throw fail('already-exists', 'game_has_listing', 'Você já tem um anúncio ativo neste jogo.');
    }
    const config = configSnap.data() as Partial<AppConfig> | undefined;
    const max = config?.maxActiveListingsPerUser ?? DEFAULT_MAX_ACTIVE_LISTINGS;
    if (others.length >= max) {
      throw fail('resource-exhausted', 'limit_reached', `Você pode ter até ${max} anúncios ativos.`);
    }

    const { listingId: _listingId, ...fields } = input;
    const listing: Listing = {
      ...fields,
      id: listingRef.id,
      ownerId: uid,
      active: true,
      ownerSnapshot: {
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        ratingAvg: user.stats.ratingAvg,
        ratingCount: user.stats.ratingCount,
      },
      createdAt,
      updatedAt: now,
    };
    tx.set(listingRef, listing);
  });

  return { listingId: listingRef.id };
}

/** Desativa um anúncio do próprio dono. Idempotente: já inativo não escreve nada. */
export async function deactivateListing(db: Firestore, uid: string, listingId: unknown, now: Timestamp) {
  if (!isId(listingId)) {
    throw fail('invalid-argument', 'invalid_input', 'listingId inválido.');
  }
  const ref = db.doc(`listings/${listingId}`);

  await db.runTransaction(async tx => {
    const listing = (await tx.get(ref)).data() as Listing | undefined;
    if (!listing || listing.ownerId !== uid) {
      throw fail('not-found', 'listing_not_found', 'Anúncio não encontrado.');
    }
    if (listing.active) {
      tx.update(ref, { active: false, updatedAt: now });
    }
  });

  return { listingId };
}
