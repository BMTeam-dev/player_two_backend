import type { Firestore, Timestamp, WriteBatch } from 'firebase-admin/firestore';
import type { Conversation, Session, SessionEvent, SessionStatus, User, UserStatus } from '../types.js';

/** O pedaço do Admin Auth que a moderação usa (injetado: os testes rodam sem o emulador do Auth). */
export interface ModerationAuth {
  updateUser(uid: string, properties: { disabled: boolean }): Promise<unknown>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

const RESTRICTED: UserStatus[] = ['suspended', 'banned'];
const CANCEL_STATUSES: SessionStatus[] = ['requested', 'accepted'];
const BATCH_LIMIT = 400;

/**
 * O que fazer com uma escrita em `users/{uid}`:
 * - `restrict`: o status passou a ser `suspended` ou `banned` (inclusive de
 *   suspenso para banido: os efeitos são idempotentes);
 * - `restore`: voltou para `active` vindo de suspenso ou banido;
 * - `null`: o status não mudou (a imensa maioria: presença, perfil, stats).
 */
export function statusChange(
  before: Pick<User, 'status'> | null,
  after: Pick<User, 'status'> | null,
): 'restrict' | 'restore' | null {
  if (!after || before?.status === after.status) {
    return null;
  }
  if (RESTRICTED.includes(after.status)) {
    return 'restrict';
  }
  return before && RESTRICTED.includes(before.status) && after.status === 'active' ? 'restore' : null;
}

/**
 * Efeitos de suspender ou banir (MVP.md 7.2 e 12.2), aplicados quando a
 * moderação edita `users/{uid}.status` no Console:
 *
 * 1. **Conversas:** tranca todas (`lockedReason: 'moderation'`); as regras de
 *    `messages` recusam mensagem em conversa trancada.
 * 2. **Sessões** que ainda não começaram: canceladas como do sistema
 *    (`cancellation.by = null`), igual ao bloqueio: sem push e sem peso na
 *    taxa de conclusão do outro lado.
 * 3. **Anúncios** ativos: desativados. Na volta, a pessoa reativa um a um.
 * 4. **Push:** apaga os `fcmTokens`, para não chegar notificação num
 *    aparelho cuja conta não entra mais.
 * 5. **Auth:** desativa a conta e revoga os refresh tokens. Sem isso, a
 *    pessoa entraria de novo com o Google. O ID token já emitido ainda vale
 *    por até 1 h nas regras (ver o topo de firestore.rules): são os passos
 *    1 a 3 que cortam o contato na hora.
 *
 * O banco vem antes do Auth: se o Auth falhar, o contato já está cortado, e
 * o trigger (com `retry`) tenta de novo. Os cartões de busca somem sozinhos:
 * `onUserWrittenSyncCards` já calcula `visible` pelo status. Tudo é
 * idempotente: repetir não cancela nem tranca nada duas vezes.
 */
export async function restrictUser(db: Firestore, auth: ModerationAuth, uid: string, now: Timestamp) {
  const result = await cutContact(db, uid, 'moderation', now);
  await disableAuth(auth, uid, true);
  await auth.revokeRefreshTokens(uid).catch(ignoreMissingAuthUser);
  return result;
}

/**
 * Passos 1 a 4 de `restrictUser`, sem o Auth: também usado pela exclusão de
 * conta (users/accountDeletion.ts), que tranca com `account_deleted`.
 */
export async function cutContact(
  db: Firestore,
  uid: string,
  lockedReason: NonNullable<Conversation['lockedReason']>,
  now: Timestamp,
) {
  // Só consultas que já têm índice composto (firestore.indexes.json): a
  // moderação não pode falhar por índice faltando (aconteceu na tarefa 30).
  const [conversations, ...sessionSnaps] = await Promise.all([
    db.collection('conversations').where('participantIds', 'array-contains', uid).orderBy('lastMessage.at', 'desc').get(),
    ...CANCEL_STATUSES.map(status =>
      db
        .collection('sessions')
        .where('participantIds', 'array-contains', uid)
        .where('status', '==', status)
        .orderBy('scheduledStart', 'desc')
        .get(),
    ),
  ]);
  const listings = await db
    .collection('listings')
    .where('ownerId', '==', uid)
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .get();

  const writes: ((batch: WriteBatch) => void)[] = [];

  let locked = 0;
  for (const doc of conversations.docs) {
    if ((doc.data() as Conversation).lockedAt == null) {
      writes.push(b => b.update(doc.ref, { lockedAt: now, lockedReason, updatedAt: now }));
      locked++;
    }
  }

  let cancelled = 0;
  for (const doc of sessionSnaps.flatMap(s => s.docs)) {
    const session = doc.data() as Session;
    const event: SessionEvent = { type: 'cancelled', fromStatus: session.status, toStatus: 'cancelled', actorId: null, meta: null, at: now };
    writes.push(b => {
      b.update(doc.ref, {
        status: 'cancelled',
        cancellation: { by: null, reason: null, at: now, fromStatus: session.status },
        updatedAt: now,
      });
      b.set(doc.ref.collection('events').doc(), event);
    });
    cancelled++;
  }

  for (const doc of listings.docs) {
    writes.push(b => b.update(doc.ref, { active: false, updatedAt: now }));
  }

  writes.push(b => b.set(db.doc(`users/${uid}/private/data`), { fcmTokens: [] }, { merge: true }));

  // Cada sessão cancelada são 2 escritas (sessão + evento): o lote fica bem
  // abaixo do limite de 500 do Firestore.
  for (let i = 0; i < writes.length; i += BATCH_LIMIT / 2) {
    const batch = db.batch();
    writes.slice(i, i + BATCH_LIMIT / 2).forEach(write => write(batch));
    await batch.commit();
  }

  return { locked, cancelled, listingsDeactivated: listings.size };
}

/**
 * Volta para `active`: só reativa o login. Conversas continuam trancadas,
 * sessões canceladas não voltam e os anúncios ficam inativos até a pessoa
 * reativar: o que aconteceu durante a suspensão não se desfaz sozinho. Os
 * cartões voltam pela sync, que recalcula `visible`.
 */
export async function restoreUser(auth: ModerationAuth, uid: string) {
  await disableAuth(auth, uid, false);
}

async function disableAuth(auth: ModerationAuth, uid: string, disabled: boolean) {
  await auth.updateUser(uid, { disabled }).catch(ignoreMissingAuthUser);
}

// Perfis de seed/teste não têm conta no Auth; o resto da moderação vale igual.
export function ignoreMissingAuthUser(error: unknown) {
  if ((error as { code?: string } | null)?.code !== 'auth/user-not-found') {
    throw error;
  }
}
