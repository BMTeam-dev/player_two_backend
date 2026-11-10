import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { AppConfig, Category, Conversation, Listing, Message, User, UserPrivate } from '../types.js';
import { addEvent, fail, isId, type SessionDoc } from './shared.js';

export const MESSAGE_MAX = 300;
export const DURATION_MIN = 15;
export const DURATION_MAX = 240;
// Mesmo horizonte da disponibilidade com janela (app: WINDOW_MAX_DAYS_AHEAD).
export const MAX_DAYS_AHEAD = 7;
// Relógio do celular adiantado/atrasado: um "daqui a 0 min" não pode ser
// recusado como passado.
const CLOCK_SKEW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

// Valem se `config/app` estiver sem os campos: os números do bootstrap.
const DEFAULT_TTL = { now: 15, scheduled: 720 };
const DEFAULT_REQUESTS_PER_HOUR = 20;

export interface RequestInput {
  providerId: string;
  listingId: string | null; // null = convite direto, sem anúncio
  gameId: string;
  scheduledStartMs: number | null; // null = "agora"
  durationMinutes: number;
  message: string | null;
}

export function parseRequestInput(data: unknown, nowMs: number): RequestInput {
  if (typeof data !== 'object' || data === null) {
    throw fail('invalid-argument', 'invalid_input', 'Payload ausente.');
  }
  const raw = data as Record<string, unknown>;

  if (!isId(raw.providerId)) {
    throw fail('invalid-argument', 'invalid_input', 'Jogador obrigatório.');
  }
  const listingId = raw.listingId ?? null;
  if (listingId !== null && !isId(listingId)) {
    throw fail('invalid-argument', 'invalid_input', 'listingId inválido.');
  }
  if (!isId(raw.gameId)) {
    throw fail('invalid-argument', 'invalid_input', 'Jogo obrigatório.');
  }

  const scheduledStartMs = raw.scheduledStartMs ?? null;
  if (scheduledStartMs !== null) {
    if (
      typeof scheduledStartMs !== 'number'
      || !Number.isFinite(scheduledStartMs)
      || scheduledStartMs < nowMs - CLOCK_SKEW_MS
      || scheduledStartMs > nowMs + MAX_DAYS_AHEAD * 24 * HOUR_MS
    ) {
      throw fail('invalid-argument', 'invalid_input', `Horário deve ser entre agora e ${MAX_DAYS_AHEAD} dias.`);
    }
  }

  const { durationMinutes } = raw;
  if (
    typeof durationMinutes !== 'number'
    || !Number.isInteger(durationMinutes)
    || durationMinutes < DURATION_MIN
    || durationMinutes > DURATION_MAX
    || durationMinutes % 15 !== 0
  ) {
    throw fail('invalid-argument', 'invalid_input', 'Duração inválida.');
  }

  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (message.length > MESSAGE_MAX) {
    throw fail('invalid-argument', 'invalid_input', `Mensagem deve ter até ${MESSAGE_MAX} caracteres.`);
  }

  return {
    providerId: raw.providerId,
    listingId,
    gameId: raw.gameId,
    scheduledStartMs,
    durationMinutes,
    message: message.length > 0 ? message : null,
  };
}

/**
 * Prazo para o provider responder. "Agora": `ttl.now` (15 min). Com horário:
 * até `ttl.scheduled` (12 h), mas nunca depois do início marcado - nem antes
 * de `ttl.now`, para um pedido "daqui a 5 min" não nascer quase vencido.
 */
export function requestExpiresAtMs(nowMs: number, scheduledStartMs: number | null, ttl: { now: number; scheduled: number }) {
  const nowTtl = nowMs + ttl.now * 60_000;
  if (scheduledStartMs === null) {
    return nowTtl;
  }
  return Math.max(nowTtl, Math.min(nowMs + ttl.scheduled * 60_000, scheduledStartMs));
}

const usable = (user: User | undefined): user is User => !!user && user.profileCompletedAt != null;

/**
 * Cria a sessão `requested`, o evento `created`, a conversa da sessão (1 por
 * pedido, decisão de 24/10/2026) com a mensagem de sistema, e conta o pedido
 * no limite por hora do requester. Tudo numa transaction.
 */
export async function createSessionRequest(db: Firestore, requesterId: string, input: RequestInput, now: Timestamp) {
  if (input.providerId === requesterId) {
    throw fail('invalid-argument', 'self_request', 'Você não pode pedir sessão para si mesmo.');
  }
  const nowMs = now.toMillis();
  const { providerId } = input;
  const requesterRef = db.doc(`users/${requesterId}`);
  const providerRef = db.doc(`users/${providerId}`);
  const privateRef = db.doc(`users/${requesterId}/private/data`);
  const sessionRef = db.collection('sessions').doc();
  const conversationRef = db.collection('conversations').doc();

  await db.runTransaction(async tx => {
    const [requesterSnap, providerSnap, privateSnap, configSnap, blockedByProvider, blockedByRequester, playerGameSnap, gameSnap, listingSnap, pendingSnap] =
      await Promise.all([
        tx.get(requesterRef),
        tx.get(providerRef),
        tx.get(privateRef),
        tx.get(db.doc('config/app')),
        tx.get(providerRef.collection('blocks').doc(requesterId)),
        tx.get(requesterRef.collection('blocks').doc(providerId)),
        tx.get(providerRef.collection('games').doc(input.gameId)),
        tx.get(db.doc(`games/${input.gameId}`)),
        input.listingId ? tx.get(db.doc(`listings/${input.listingId}`)) : Promise.resolve(null),
        tx.get(
          db.collection('sessions')
            .where('requesterId', '==', requesterId)
            .where('providerId', '==', providerId)
            .where('status', '==', 'requested'),
        ),
      ]);

    const requester = requesterSnap.data() as User | undefined;
    if (!usable(requester)) {
      throw fail('failed-precondition', 'no_profile', 'Complete seu perfil antes de pedir uma sessão.');
    }
    if (requester.status !== 'active') {
      throw fail('permission-denied', 'account_restricted', 'Sua conta não pode pedir sessões.');
    }
    const provider = providerSnap.data() as User | undefined;
    if (!usable(provider) || provider.status !== 'active') {
      throw fail('failed-precondition', 'provider_unavailable', 'Este jogador não está disponível.');
    }
    // Mesma resposta para os dois lados: quem foi bloqueado não descobre.
    if (blockedByProvider.exists || blockedByRequester.exists) {
      throw fail('permission-denied', 'blocked', 'Não é possível pedir sessão para este jogador.');
    }

    let category: Category = 'play_together';
    let listedPriceCents = 0;
    let durationMinutes = input.durationMinutes;
    if (listingSnap) {
      const listing = listingSnap.data() as Listing | undefined;
      if (!listing || !listing.active || listing.ownerId !== providerId || listing.gameId !== input.gameId) {
        throw fail('failed-precondition', 'listing_unavailable', 'Este anúncio não está mais disponível.');
      }
      // O preço fica congelado como registro do combinado (MVP.md 5.2); a
      // duração do anúncio vale sobre a do payload pelo mesmo motivo.
      category = listing.category;
      listedPriceCents = listing.priceCents;
      durationMinutes = listing.sessionMinutes;
    }
    if (!playerGameSnap.exists || gameSnap.get('active') !== true) {
      throw fail('failed-precondition', 'game_not_offered', 'Este jogador não joga este jogo.');
    }
    // Um pedido pendente por dupla: o provider já tem um para responder.
    if (!pendingSnap.empty) {
      throw fail('already-exists', 'already_requested', 'Você já tem um pedido aguardando resposta deste jogador.');
    }

    const config = configSnap.data() as Partial<AppConfig> | undefined;
    const limit = config?.rateLimits?.sessionRequestsPerHour ?? DEFAULT_REQUESTS_PER_HOUR;
    const rate = (privateSnap.data() as UserPrivate | undefined)?.rateLimit;
    const windowStartMs = rate?.sessionRequestsWindowStart?.toDate().getTime() ?? null;
    const windowOpen = windowStartMs !== null && nowMs - windowStartMs < HOUR_MS;
    const count = windowOpen ? (rate?.sessionRequestsCount ?? 0) : 0;
    if (count >= limit) {
      throw fail('resource-exhausted', 'rate_limited', 'Muitos pedidos em pouco tempo. Tente de novo mais tarde.');
    }

    const startMs = input.scheduledStartMs ?? nowMs;
    const ttl = config?.sessionRequestTtlMinutes ?? DEFAULT_TTL;
    const snapshots = {
      [requesterId]: { displayName: requester.displayName, avatarUrl: requester.avatarUrl },
      [providerId]: { displayName: provider.displayName, avatarUrl: provider.avatarUrl },
    };

    const session: SessionDoc = {
      id: sessionRef.id,
      requesterId,
      providerId,
      participantIds: [requesterId, providerId],
      participantSnapshots: snapshots,
      listingId: input.listingId,
      gameId: input.gameId,
      category,
      scheduledStart: new Date(startMs),
      scheduledEnd: new Date(startMs + durationMinutes * 60_000),
      durationMinutes,
      message: input.message,
      listedPriceCents,
      status: 'requested',
      conversationId: conversationRef.id,
      requestExpiresAt: new Date(requestExpiresAtMs(nowMs, input.scheduledStartMs, ttl)),
      respondedAt: null,
      startedAt: null,
      endedAt: null,
      completedAt: null,
      confirmations: { requester: null, provider: null },
      cancellation: null,
      noShow: null,
      reviewedBy: { requester: false, provider: false },
      createdAt: now,
      updatedAt: now,
    };

    const text = `${requester.displayName} pediu uma sessão de ${gameSnap.get('name') ?? input.gameId}.`;
    const messageRef = conversationRef.collection('messages').doc();
    const message: Message = {
      id: messageRef.id,
      senderId: null,
      type: 'system',
      text,
      systemEvent: 'session_requested',
      flagged: false,
      createdAt: now,
    };
    const conversation: Conversation = {
      id: conversationRef.id,
      type: 'session',
      participantIds: [requesterId, providerId],
      participantSnapshots: snapshots,
      sessionId: sessionRef.id,
      lfgPostId: null,
      lastMessage: { text, senderId: null, type: 'system', at: now },
      unread: { [requesterId]: 0, [providerId]: 1 },
      lockedAt: null,
      lockedReason: null,
      createdAt: now,
      updatedAt: now,
    };

    tx.set(sessionRef, session);
    addEvent(tx, sessionRef, 'created', null, 'requested', requesterId, now, input.listingId ? { listingId: input.listingId } : null);
    tx.set(conversationRef, conversation);
    tx.set(messageRef, message);
    tx.set(
      privateRef,
      { rateLimit: { sessionRequestsWindowStart: windowOpen ? rate!.sessionRequestsWindowStart : now, sessionRequestsCount: count + 1 } },
      { merge: true },
    );
  });

  return { sessionId: sessionRef.id, conversationId: conversationRef.id };
}
