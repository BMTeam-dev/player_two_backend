import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  LANGUAGES,
  PLATFORMS,
  PLAYSTYLES,
  type AppConfig,
  type Language,
  type Platform,
  type Playstyle,
  type User,
  type UserPrivate,
} from '../types.js';

export const MIN_AGE = 18;
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

// Nomes que dariam para se passar pela equipe ou pelo app.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrador', 'suporte', 'support', 'moderador', 'moderator', 'mod',
  'mynoobpro', 'noobpro', 'oficial', 'official', 'staff', 'equipe', 'sistema', 'system',
]);

/** Erro de validação: `details.reason` é o que o app usa para escolher a mensagem. */
export type OnboardingErrorReason =
  | 'invalid_input'
  | 'username_invalid'
  | 'username_reserved'
  | 'username_taken'
  | 'underage'
  | 'terms_outdated'
  | 'already_onboarded';

export interface OnboardingInput {
  username: string;
  displayName: string;
  birthDate: string; // YYYY-MM-DD
  termsVersion: string;
  languages: Language[];
  platforms: Platform[];
  hasMic: boolean;
  playstyles: Playstyle[];
  region: string | null;
}

export interface OnboardingCaller {
  uid: string;
  email: string;
  emailVerified: boolean;
}

const fail = (code: 'invalid-argument' | 'already-exists' | 'failed-precondition', reason: OnboardingErrorReason, message: string) =>
  new HttpsError(code, message, { reason });

const isSubsetOf = <T extends string>(v: unknown, allowed: readonly T[], min: number, max: number): v is T[] =>
  Array.isArray(v)
  && v.length >= min
  && v.length <= max
  && new Set(v).size === v.length
  && v.every(item => (allowed as readonly unknown[]).includes(item));

/**
 * Idade completa em `now`. Usa o calendário de Brasília (UTC-3, sem horário
 * de verão desde 2019): com UTC puro, quem faz 18 anos hoje seria recusado
 * entre 21h e meia-noite do dia anterior.
 */
export function ageOn(birthDate: string, now: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC aceita 2007-02-31 e vira 03/03; recusamos datas inexistentes.
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) return null;

  const today = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  const td = today.getUTCDate();
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Valida e normaliza o payload da callable (o cliente pode mandar qualquer coisa). */
export function parseOnboardingInput(data: unknown, now: Date): OnboardingInput {
  if (typeof data !== 'object' || data === null) {
    throw fail('invalid-argument', 'invalid_input', 'Payload ausente.');
  }
  const raw = data as Record<string, unknown>;

  if (typeof raw.username !== 'string') {
    throw fail('invalid-argument', 'username_invalid', 'Username obrigatório.');
  }
  const username = raw.username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw fail('invalid-argument', 'username_invalid', 'Username deve ter 3-20 caracteres: letras, números ou _.');
  }
  if (RESERVED_USERNAMES.has(username)) {
    throw fail('invalid-argument', 'username_reserved', 'Username reservado.');
  }

  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  // Mesmos limites do `isStr(displayName, 2, 30)` em firestore.rules: senão o
  // perfil nasceria com um nome que o próprio dono não consegue mais salvar.
  if (displayName.length < 2 || displayName.length > 30) {
    throw fail('invalid-argument', 'invalid_input', 'Nome de exibição deve ter 2-30 caracteres.');
  }

  if (typeof raw.birthDate !== 'string') {
    throw fail('invalid-argument', 'invalid_input', 'Data de nascimento obrigatória.');
  }
  const age = ageOn(raw.birthDate, now);
  if (age === null || age > 120) {
    throw fail('invalid-argument', 'invalid_input', 'Data de nascimento inválida.');
  }
  if (age < MIN_AGE) {
    throw fail('failed-precondition', 'underage', `É preciso ter ${MIN_AGE} anos ou mais.`);
  }

  if (typeof raw.termsVersion !== 'string' || raw.termsVersion.length === 0) {
    throw fail('invalid-argument', 'invalid_input', 'Versão dos termos obrigatória.');
  }
  if (!isSubsetOf(raw.languages, LANGUAGES, 1, 3)) {
    throw fail('invalid-argument', 'invalid_input', 'Idiomas inválidos.');
  }
  if (!isSubsetOf(raw.platforms, PLATFORMS, 1, 5)) {
    throw fail('invalid-argument', 'invalid_input', 'Plataformas inválidas.');
  }
  if (typeof raw.hasMic !== 'boolean') {
    throw fail('invalid-argument', 'invalid_input', 'Campo de microfone inválido.');
  }
  const playstyles = raw.playstyles ?? [];
  if (!isSubsetOf(playstyles, PLAYSTYLES, 0, 6)) {
    throw fail('invalid-argument', 'invalid_input', 'Estilos de jogo inválidos.');
  }
  const region = raw.region ?? null;
  if (region !== null && (typeof region !== 'string' || !/^[A-Z]{2}$/.test(region))) {
    throw fail('invalid-argument', 'invalid_input', 'Região deve ser a sigla do estado (ex: SP).');
  }

  return {
    username,
    displayName,
    birthDate: raw.birthDate,
    termsVersion: raw.termsVersion,
    languages: raw.languages,
    platforms: raw.platforms,
    hasMic: raw.hasMic,
    playstyles,
    region,
  };
}

/**
 * Cria `usernames/{username}`, `users/{uid}` e `users/{uid}/private/data` numa
 * transaction - dois cadastros simultâneos com o mesmo username não podem
 * passar os dois.
 *
 * `db` e `now` vêm de fora para os testes rodarem com o firebase-admin da
 * raiz: um Timestamp/FieldValue criado por outra cópia do pacote é recusado
 * pelo serializador do Firestore.
 */
export async function createProfile(db: Firestore, caller: OnboardingCaller, input: OnboardingInput, now: Timestamp) {
  const userRef = db.doc(`users/${caller.uid}`);
  const privateRef = db.doc(`users/${caller.uid}/private/data`);
  const usernameRef = db.doc(`usernames/${input.username}`);
  const configRef = db.doc('config/app');

  await db.runTransaction(async tx => {
    const [userSnap, usernameSnap, configSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(usernameRef),
      tx.get(configRef),
    ]);

    if (userSnap.exists) {
      throw fail('already-exists', 'already_onboarded', 'Perfil já criado.');
    }
    if (usernameSnap.exists && usernameSnap.get('uid') !== caller.uid) {
      throw fail('already-exists', 'username_taken', 'Username já está em uso.');
    }
    // O app mostra os termos da versão que leu de config/app; se a versão
    // mudou no meio do cadastro, o aceite registrado seria de um texto que a
    // pessoa não viu.
    const config = configSnap.data() as AppConfig | undefined;
    if (!config || input.termsVersion !== config.termsVersion) {
      throw fail('failed-precondition', 'terms_outdated', 'Os termos foram atualizados. Leia e aceite de novo.');
    }

    const user: User = {
      uid: caller.uid,
      username: input.username,
      displayName: input.displayName,
      avatarUrl: null,
      bio: null,
      // v0 roda só no Brasil (MVP.md, seção 18).
      country: 'BR',
      region: input.region,
      languages: input.languages,
      platforms: input.platforms,
      hasMic: input.hasMic,
      playstyles: input.playstyles,
      gameIds: [],
      availability: { state: 'offline', gameIds: [], windowStart: null, windowEnd: null, expiresAt: null, note: null },
      isOnline: false,
      lastSeenAt: null,
      companionStatus: 'none',
      stats: { ratingAvg: 0, ratingCount: 0, sessionsCompleted: 0, completionRate: 1, avgResponseMinutes: null },
      status: 'active',
      emailVerified: caller.emailVerified,
      profileCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const userPrivate: UserPrivate = {
      email: caller.email,
      birthDate: input.birthDate,
      ageConfirmedAt: now,
      termsVersion: input.termsVersion,
      termsAcceptedAt: now,
      fcmTokens: [],
      notificationPrefs: { sessionRequests: true, sessionUpdates: true, messages: true, lfg: true, reminders: true },
      rateLimit: { sessionRequestsWindowStart: null, sessionRequestsCount: 0 },
    };

    tx.set(usernameRef, { uid: caller.uid, createdAt: now });
    tx.set(userRef, user);
    tx.set(privateRef, userPrivate);
  });

  return { uid: caller.uid, username: input.username };
}
