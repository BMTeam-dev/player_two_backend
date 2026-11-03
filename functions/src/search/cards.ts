import type { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore';
import type { AvailabilityState, Game, Listing, PlayerGame, SearchCard, User } from '../types.js';

const AVAILABILITY_RANK: Record<AvailabilityState, number> = { now: 3, today: 2, window: 1, offline: 0 };

export const cardId = (uid: string, gameId: string) => `${uid}_${gameId}`;

// `Date` em vez de `Timestamp`: o Firestore grava igual, e não quebra quando
// quem chama (testes, script de recálculo) usa outra cópia do firebase-admin.
export type CardDoc = Omit<SearchCard, 'updatedAt'> & { updatedAt: Date };

type CardInput = {
  user: User;
  playerGame: PlayerGame;
  game: Pick<Game, 'ranks'>;
  listing: Pick<Listing, 'id' | 'category' | 'priceCents'> | null;
  updatedAt: Date;
};

/**
 * Monta o cartão de um jogo do usuário. Devolve null quando o rank do
 * jogador não existe mais no catálogo: sem `rankOrder` confiável, o cartão
 * não entra na busca até a pessoa escolher um rank válido.
 */
export function buildCard({ user, playerGame, game, listing, updatedAt }: CardInput): CardDoc | null {
  // `rankOrder` vem do catálogo, nunca do PlayerGame: as regras só
  // tipo-checam o valor que o cliente grava.
  const rank = game.ranks.find(r => r.id === playerGame.rankId);
  if (!rank) {
    return null;
  }

  // A disponibilidade vale só para os jogos escolhidos nela: quem está
  // "agora" só no Valorant aparece offline na busca de LoL.
  const { availability } = user;
  const availableHere = availability.state !== 'offline' && availability.gameIds.includes(playerGame.gameId);
  const availabilityState = availableHere ? availability.state : 'offline';

  return {
    uid: user.uid,
    gameId: playerGame.gameId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    rankId: rank.id,
    rankOrder: rank.order,
    roles: playerGame.roles,
    objectives: playerGame.objectives,
    platforms: playerGame.platforms,
    languages: user.languages,
    playstyles: user.playstyles,
    hasMic: user.hasMic,
    availabilityState,
    availabilityRank: AVAILABILITY_RANK[availabilityState],
    availabilityExpiresAt: availableHere ? availability.expiresAt : null,
    isOnline: user.isOnline,
    isCompanion: user.companionStatus === 'approved',
    listingId: listing?.id ?? null,
    category: listing?.category ?? null,
    priceCents: listing?.priceCents ?? 0,
    ratingAvg: user.stats.ratingAvg,
    ratingCount: user.stats.ratingCount,
    sessionsCompleted: user.stats.sessionsCompleted,
    completionRate: user.stats.completionRate,
    // Suspenso/banido some da busca. Os outros efeitos do banimento
    // (anúncios, conversas, tokens) ficam com a tarefa 32.
    visible: user.status === 'active' && user.profileCompletedAt != null,
    updatedAt,
  };
}

// Compara ignorando `updatedAt`: sem isso todo trigger reescreveria os
// cartões mesmo sem mudança, e cada escrita custa (e acorda listeners).
function normalize(value: unknown): unknown {
  if (value && typeof value === 'object') {
    if ('toMillis' in value && typeof value.toMillis === 'function') {
      return value.toMillis();
    }
    if (value instanceof Date) {
      return value.getTime();
    }
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'updatedAt')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, normalize(v)]),
    );
  }
  return value;
}

export const sameCard = (a: DocumentData, b: DocumentData) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

export type SyncResult = { written: number; deleted: number; gameIdsChanged: boolean };

/**
 * Recalcula do zero todos os cartões de um usuário (um por jogo do perfil)
 * e o `users/{uid}.gameIds`. Idempotente: rodar de novo sem mudança nos
 * dados não escreve nada - por isso o trigger de `users` pode reagir à
 * própria escrita de `gameIds` sem entrar em loop.
 *
 * Tudo numa transaction: dois triggers do mesmo usuário rodando juntos (ex:
 * editar um jogo e a presença mudar) leem e escrevem em série, e o último
 * nunca grava um cartão montado com dados velhos.
 */
export async function syncUserCards(db: Firestore, uid: string, now: Timestamp): Promise<SyncResult> {
  const userRef = db.doc(`users/${uid}`);
  const updatedAt = new Date(now.toMillis());

  return db.runTransaction(async tx => {
    const [userSnap, existingSnap, gamesSnap, listingsSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(db.collection('searchCards').where('uid', '==', uid)),
      tx.get(userRef.collection('games')),
      tx.get(db.collection('listings').where('ownerId', '==', uid).where('active', '==', true)),
    ]);
    const existing = new Map(existingSnap.docs.map(doc => [doc.id, doc]));
    const result: SyncResult = { written: 0, deleted: 0, gameIdsChanged: false };

    const cards = new Map<string, CardDoc>();
    let gameIds: string[] = [];
    if (userSnap.exists) {
      const user = userSnap.data() as User;
      const playerGames = gamesSnap.docs.map(doc => doc.data() as PlayerGame);
      const catalog =
        playerGames.length > 0 ? await tx.getAll(...playerGames.map(pg => db.doc(`games/${pg.gameId}`))) : [];
      const listings = listingsSnap.docs.map(doc => ({ ...(doc.data() as Listing), id: doc.id }));

      playerGames.forEach((playerGame, i) => {
        const game = catalog[i];
        if (!game.exists) {
          return;
        }
        // Mais de um anúncio ativo no mesmo jogo não deveria acontecer
        // (upsertListing, tarefa 21); se acontecer, vale o mais recente.
        const listing =
          listings
            .filter(l => l.gameId === playerGame.gameId)
            .sort((a, b) => (b.updatedAt as Timestamp).toMillis() - (a.updatedAt as Timestamp).toMillis())[0] ?? null;
        const card = buildCard({ user, playerGame, game: game.data() as Game, listing, updatedAt });
        if (card) {
          cards.set(cardId(uid, playerGame.gameId), card);
        }
      });

      // Jogo principal primeiro: é a ordem que o perfil mostra.
      gameIds = [...playerGames].sort((a, b) => Number(b.isMain) - Number(a.isMain)).map(pg => pg.gameId);
      result.gameIdsChanged = JSON.stringify(gameIds) !== JSON.stringify(user.gameIds ?? []);
    }

    for (const [id, card] of cards) {
      const current = existing.get(id);
      if (!current || !sameCard(current.data(), card)) {
        tx.set(db.doc(`searchCards/${id}`), card);
        result.written++;
      }
    }
    for (const id of existing.keys()) {
      if (!cards.has(id)) {
        tx.delete(db.doc(`searchCards/${id}`));
        result.deleted++;
      }
    }
    if (result.gameIdsChanged) {
      tx.update(userRef, { gameIds });
    }
    return result;
  });
}
