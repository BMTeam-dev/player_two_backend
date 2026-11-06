// Testes da lógica de completeOnboarding: validação do payload (puro) e a
// transaction contra o emulador do Firestore (`npm test`).
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ageOn,
  createProfile,
  parseOnboardingInput,
  type OnboardingCaller,
} from '../functions/src/users/onboarding.js';

const NOW = new Date('2026-10-29T15:00:00Z');
const TERMS = '2026-10-v1';

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  username: 'BiaClutch',
  displayName: 'Bia Clutch',
  birthDate: '2000-05-10',
  termsVersion: TERMS,
  languages: ['pt'],
  platforms: ['pc'],
  hasMic: true,
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

describe('ageOn', () => {
  it('conta o aniversário no fuso de Brasília', () => {
    // 29/10/2026 22h em Brasília ainda é dia 29 lá (01h do dia 30 em UTC).
    const lateNight = new Date('2026-10-30T01:00:00Z');
    expect(ageOn('2008-10-30', lateNight)).toBe(17);
    expect(ageOn('2008-10-29', lateNight)).toBe(18);
  });

  it('recusa data inexistente', () => {
    expect(ageOn('2000-02-31', NOW)).toBeNull();
    expect(ageOn('10/05/2000', NOW)).toBeNull();
  });
});

describe('parseOnboardingInput', () => {
  it('normaliza username para minúsculas e aplica padrões', () => {
    const input = parseOnboardingInput(validPayload({ displayName: '  Bia  ' }), NOW);
    expect(input.username).toBe('biaclutch');
    expect(input.displayName).toBe('Bia');
    expect(input.playstyles).toEqual([]);
    expect(input.region).toBeNull();
  });

  it('recusa menor de 18 (inclusive na véspera do aniversário)', () => {
    expect(reasonOf(() => parseOnboardingInput(validPayload({ birthDate: '2008-10-30' }), NOW))).toBe('underage');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ birthDate: '2008-10-29' }), NOW))).toBeUndefined();
  });

  it('recusa username inválido ou reservado', () => {
    expect(reasonOf(() => parseOnboardingInput(validPayload({ username: 'ab' }), NOW))).toBe('username_invalid');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ username: 'joão' }), NOW))).toBe('username_invalid');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ username: 'Admin' }), NOW))).toBe('username_reserved');
  });

  it('recusa listas fora dos enums, vazias ou repetidas', () => {
    expect(reasonOf(() => parseOnboardingInput(validPayload({ languages: [] }), NOW))).toBe('invalid_input');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ languages: ['pt', 'pt'] }), NOW))).toBe('invalid_input');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ platforms: ['atari'] }), NOW))).toBe('invalid_input');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ playstyles: ['rage'] }), NOW))).toBe('invalid_input');
  });

  it('recusa nome de exibição fora de 2-30 caracteres e região que não é UF', () => {
    expect(reasonOf(() => parseOnboardingInput(validPayload({ displayName: 'A' }), NOW))).toBe('invalid_input');
    expect(reasonOf(() => parseOnboardingInput(validPayload({ region: 'sp' }), NOW))).toBe('invalid_input');
  });
});

describe('createProfile (emulador)', () => {
  let app: App;
  let db: Firestore;
  const alice: OnboardingCaller = { uid: 'alice', email: 'alice@x.com', emailVerified: true };
  const bob: OnboardingCaller = { uid: 'bob', email: 'bob@x.com', emailVerified: true };
  const input = () => parseOnboardingInput(validPayload(), NOW);

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-mynoobpro' }, 'onboarding-test');
    db = getFirestore(app);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  beforeEach(async () => {
    for (const path of ['users', 'usernames', 'config']) {
      await db.recursiveDelete(db.collection(path));
    }
    await db.doc('config/app').set({ termsVersion: TERMS });
  });

  it('cria username, perfil e dados privados', async () => {
    const now = Timestamp.fromDate(NOW);
    await createProfile(db, alice, input(), now);

    expect((await db.doc('usernames/biaclutch').get()).get('uid')).toBe('alice');
    const user = (await db.doc('users/alice').get()).data()!;
    expect(user).toMatchObject({
      username: 'biaclutch',
      country: 'BR',
      status: 'active',
      companionStatus: 'none',
      availability: { state: 'offline' },
    });
    expect(user.profileCompletedAt.isEqual(now)).toBe(true);
    const priv = (await db.doc('users/alice/private/data').get()).data()!;
    expect(priv).toMatchObject({ email: 'alice@x.com', birthDate: '2000-05-10', termsVersion: TERMS });
  });

  it('não deixa dois usuários com o mesmo username', async () => {
    await createProfile(db, alice, input(), Timestamp.now());
    expect(await asyncReasonOf(createProfile(db, bob, input(), Timestamp.now()))).toBe('username_taken');
  });

  it('não recria perfil de quem já fez onboarding', async () => {
    await createProfile(db, alice, input(), Timestamp.now());
    const other = parseOnboardingInput(validPayload({ username: 'outro_nome' }), NOW);
    expect(await asyncReasonOf(createProfile(db, alice, other, Timestamp.now()))).toBe('already_onboarded');
    expect((await db.doc('usernames/outro_nome').get()).exists).toBe(false);
  });

  it('recusa aceite de uma versão antiga dos termos', async () => {
    const old = parseOnboardingInput(validPayload({ termsVersion: '2026-01-v0' }), NOW);
    expect(await asyncReasonOf(createProfile(db, alice, old, Timestamp.now()))).toBe('terms_outdated');
    expect((await db.doc('users/alice').get()).exists).toBe(false);
  });
});
