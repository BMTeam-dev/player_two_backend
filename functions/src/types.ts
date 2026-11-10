// Entidades e enums do MVP - fonte: MODELO_DE_DADOS.md (repo do app).
// O app mantém uma cópia deste arquivo; ao mudar algo aqui, copie para lá
// (vira pacote compartilhado só quando a cópia manual começar a divergir).

// Estrutural de propósito: tanto o Timestamp do firebase-admin quanto o do
// @react-native-firebase/firestore satisfazem esta interface, então o mesmo
// arquivo serve nos dois lados sem importar nenhum SDK.
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
}

// ---------------------------------------------------------------- enums

export const PLATFORMS = ['pc', 'playstation', 'xbox', 'switch', 'mobile'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const LANGUAGES = ['pt', 'en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export const OBJECTIVES = ['casual', 'ranked', 'coop', 'party', 'coaching', 'companion'] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const CATEGORIES = ['play_together', 'companion', 'coaching'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PLAYSTYLES = ['chill', 'tryhard', 'teaching', 'funny', 'strategic', 'silent'] as const;
export type Playstyle = (typeof PLAYSTYLES)[number];

export const AVAILABILITY_STATES = ['now', 'today', 'window', 'offline'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export type CompanionStatus = 'none' | 'pending' | 'approved' | 'suspended';
export type UserStatus = 'active' | 'suspended' | 'banned';

export type SessionStatus =
  | 'requested'
  | 'declined'
  | 'expired'
  | 'accepted'
  | 'in_progress'
  | 'awaiting_confirmation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type LfgStatus = 'open' | 'full' | 'closed' | 'expired';
export type LfgMemberStatus = 'requested' | 'accepted' | 'declined' | 'left';
export type ConversationType = 'direct' | 'session' | 'lfg';
export type MessageType = 'text' | 'system';

export type ReviewTag =
  | 'friendly'
  | 'skilled'
  | 'good_teacher'
  | 'punctual'
  | 'good_comms'
  | 'toxic'
  | 'no_show'
  | 'late';

export type ReportTargetType = 'user' | 'message' | 'listing' | 'lfg_post' | 'session' | 'review';

export const REPORT_REASONS = [
  'harassment',
  'hate_speech',
  'sexual_content',
  'fraud',
  'boosting_or_account_sharing',
  'cheating',
  'toxicity',
  'spam',
  'underage',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type ReportStatus = 'open' | 'reviewing' | 'actioned' | 'dismissed';
export type ReportPriority = 'low' | 'normal' | 'high';
export type ModerationType = 'warn' | 'hide_content' | 'suspend' | 'ban' | 'revoke_companion';

// `availabilityRank` usado para ordenar a busca (searchCards).
export const AVAILABILITY_RANK: Record<AvailabilityState, number> = {
  now: 3,
  today: 2,
  window: 1,
  offline: 0,
};

// ------------------------------------------------------------ snapshots

export interface UserSnapshot {
  displayName: string;
  avatarUrl: string | null;
}

// ------------------------------------------------------------- entidades

/** config/app */
export interface AppConfig {
  minAppVersion: string;
  activeGameIds: string[];
  maxActiveListingsPerUser: number;
  sessionRequestTtlMinutes: { now: number; scheduled: number };
  availabilityNowTtlMinutes: number;
  autoCompleteAfterHours: number;
  reviewWindowDays: number;
  rateLimits: {
    sessionRequestsPerHour: number;
    messagesPerMinute: number;
    reportsPerDay: number;
  };
  searchWeights: {
    availability: number;
    online: number;
    rankProximity: number;
    rating: number;
    completionRate: number;
  };
  termsVersion: string;
  updatedAt: TimestampLike;
}

/** games/{gameId} */
export interface Game {
  id: string;
  name: string;
  iconUrl: string | null;
  platforms: Platform[];
  ranks: { id: string; label: string; order: number }[];
  roles: { id: string; label: string }[];
  maxPartySize: number;
  active: boolean;
  sortOrder: number;
}

/** usernames/{username} */
export interface Username {
  uid: string;
  createdAt: TimestampLike;
}

export interface Availability {
  state: AvailabilityState;
  gameIds: string[];
  windowStart: TimestampLike | null;
  windowEnd: TimestampLike | null;
  expiresAt: TimestampLike | null;
  note: string | null;
}

export interface UserStats {
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  completionRate: number;
  avgResponseMinutes: number | null;
}

/** users/{uid} - perfil público */
export interface User {
  uid: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  country: string;
  region: string | null;
  languages: Language[];
  platforms: Platform[];
  hasMic: boolean;
  playstyles: Playstyle[];
  gameIds: string[];
  availability: Availability;
  isOnline: boolean;
  lastSeenAt: TimestampLike | null;
  companionStatus: CompanionStatus;
  stats: UserStats;
  status: UserStatus;
  emailVerified: boolean;
  profileCompletedAt: TimestampLike | null;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** Campos de `User` que o próprio dono pode editar (espelha firestore.rules). */
export const USER_EDITABLE_FIELDS = [
  'displayName',
  'avatarUrl',
  'bio',
  'region',
  'languages',
  'platforms',
  'hasMic',
  'playstyles',
  'availability',
] as const;

/** users/{uid}/private/data */
export interface UserPrivate {
  email: string;
  birthDate: string; // YYYY-MM-DD
  ageConfirmedAt: TimestampLike;
  termsVersion: string;
  termsAcceptedAt: TimestampLike;
  fcmTokens: string[];
  notificationPrefs: {
    sessionRequests: boolean;
    sessionUpdates: boolean;
    messages: boolean;
    lfg: boolean;
    reminders: boolean;
  };
  rateLimit: {
    sessionRequestsWindowStart: TimestampLike | null;
    sessionRequestsCount: number;
  };
}

/** users/{uid}/games/{gameId} */
export interface PlayerGame {
  gameId: string;
  rankId: string;
  rankOrder: number;
  roles: string[];
  objectives: Objective[];
  platforms: Platform[];
  isMain: boolean;
  inGameNick: string | null;
  updatedAt: TimestampLike;
}

/** users/{uid}/blocks/{targetUid} */
export interface Block {
  blockedUid: string;
  createdAt: TimestampLike;
}

/** searchCards/{uid}_{gameId} - desnormalizado, só Functions escrevem */
export interface SearchCard {
  uid: string;
  gameId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  rankId: string;
  rankOrder: number;
  roles: string[];
  objectives: Objective[];
  platforms: Platform[];
  languages: Language[];
  playstyles: Playstyle[];
  hasMic: boolean;
  availabilityState: AvailabilityState;
  availabilityRank: number;
  availabilityExpiresAt: TimestampLike | null;
  // Só preenchidos quando availabilityState = 'window' (o cartão mostra
  // "sáb 20h–23h" em vez de um genérico "horário marcado").
  availabilityWindowStart: TimestampLike | null;
  availabilityWindowEnd: TimestampLike | null;
  isOnline: boolean;
  isCompanion: boolean;
  listingId: string | null;
  category: Category | null;
  priceCents: number;
  ratingAvg: number;
  ratingCount: number;
  sessionsCompleted: number;
  completionRate: number;
  visible: boolean;
  updatedAt: TimestampLike;
}

/** listings/{listingId} */
export interface Listing {
  id: string;
  ownerId: string;
  gameId: string;
  category: Category;
  title: string;
  description: string;
  priceCents: number; // preço de referência; nunca cobrado pelo app
  pricingUnit: 'hour' | 'session';
  sessionMinutes: number;
  languages: Language[];
  platforms: Platform[];
  active: boolean;
  ownerSnapshot: UserSnapshot & { ratingAvg: number; ratingCount: number };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** lfgPosts/{postId} - v0.1 */
export interface LfgPost {
  id: string;
  ownerId: string;
  ownerSnapshot: UserSnapshot;
  gameId: string;
  objective: Objective;
  slotsNeeded: number;
  slotsFilled: number;
  startsAt: TimestampLike | null;
  minRankOrder: number | null;
  maxRankOrder: number | null;
  micRequired: boolean;
  language: Language;
  platform: Platform;
  roles: string[];
  note: string | null;
  status: LfgStatus;
  conversationId: string | null;
  expiresAt: TimestampLike;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** lfgPosts/{postId}/members/{uid} - v0.1 */
export interface LfgMember {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  rankOrder: number | null;
  status: LfgMemberStatus;
  requestedAt: TimestampLike;
  decidedAt: TimestampLike | null;
}

/** sessions/{sessionId} */
export interface Session {
  id: string;
  requesterId: string;
  providerId: string;
  participantIds: [string, string];
  participantSnapshots: Record<string, UserSnapshot>;
  listingId: string | null;
  gameId: string;
  category: Category;
  scheduledStart: TimestampLike;
  // scheduledStart + durationMinutes, gravado na criação: a função agendada
  // autoAdvanceSessions precisa consultar "fim já passou", e o Firestore
  // não filtra por soma de campos.
  scheduledEnd: TimestampLike;
  durationMinutes: number;
  message: string | null;
  listedPriceCents: number; // registro do combinado; pagamento é por fora
  status: SessionStatus;
  conversationId: string;
  requestExpiresAt: TimestampLike;
  respondedAt: TimestampLike | null;
  startedAt: TimestampLike | null;
  endedAt: TimestampLike | null;
  completedAt: TimestampLike | null;
  confirmations: { requester: TimestampLike | null; provider: TimestampLike | null };
  cancellation: { by: string; reason: string | null; at: TimestampLike } | null;
  noShow: { reportedBy: string; absentUid: string; at: TimestampLike } | null;
  reviewedBy: { requester: boolean; provider: boolean };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type SessionEventType =
  | 'created'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'started'
  | 'marked_done'
  | 'confirmed'
  | 'auto_completed'
  | 'no_show';

/** sessions/{sessionId}/events/{eventId} */
export interface SessionEvent {
  type: SessionEventType;
  fromStatus: SessionStatus | null;
  toStatus: SessionStatus;
  actorId: string | null; // null = transição automática (função agendada)
  meta: Record<string, string | number | boolean> | null;
  at: TimestampLike;
}

/** conversations/{conversationId} */
export interface Conversation {
  id: string;
  type: ConversationType;
  participantIds: string[];
  participantSnapshots: Record<string, UserSnapshot>;
  sessionId: string | null;
  lfgPostId: string | null;
  lastMessage: { text: string; senderId: string | null; type: MessageType; at: TimestampLike } | null;
  unread: Record<string, number>;
  lockedAt: TimestampLike | null;
  lockedReason: 'block' | 'moderation' | 'lfg_closed' | null;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type SystemEvent =
  | 'session_requested'
  | 'session_accepted'
  | 'session_declined'
  | 'session_expired'
  | 'session_cancelled'
  | 'session_completed'
  | 'session_no_show'
  | 'lfg_member_joined'
  | 'lfg_member_left';

/** conversations/{conversationId}/messages/{messageId} */
export interface Message {
  id: string;
  senderId: string | null;
  type: MessageType;
  text: string;
  systemEvent: SystemEvent | null;
  flagged: boolean;
  createdAt: TimestampLike;
}

/** reviews/{sessionId}_{authorUid} */
export interface Review {
  id: string;
  sessionId: string;
  gameId: string;
  authorId: string;
  targetId: string;
  role: 'as_requester' | 'as_provider';
  rating: 1 | 2 | 3 | 4 | 5;
  tags: ReviewTag[];
  comment: string | null;
  authorSnapshot: UserSnapshot;
  visible: boolean;
  createdAt: TimestampLike;
}

/** reports/{reportId} */
export interface Report {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  targetUserId: string;
  reason: ReportReason;
  details: string | null;
  evidence: { conversationId: string | null; messageIds: string[] };
  status: ReportStatus;
  priority?: ReportPriority; // calculada pela Function, nunca pelo cliente
  resolution: { moderatorId: string; actionId: string | null; note: string | null; at: TimestampLike } | null;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** moderationActions/{actionId} */
export interface ModerationAction {
  id: string;
  targetUserId: string;
  type: ModerationType;
  reason: ReportReason;
  note: string | null;
  reportIds: string[];
  contentRef: { targetType: ReportTargetType; targetId: string } | null;
  until: TimestampLike | null;
  moderatorId: string | null;
  automatic: boolean;
  createdAt: TimestampLike;
}

/** Realtime Database: status/{uid} */
export interface Presence {
  state: 'online' | 'offline';
  lastChanged: number; // ms (ServerValue.TIMESTAMP)
}
