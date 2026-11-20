import type { DocumentReference, Firestore, Timestamp, WriteBatch } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { cutContact, ignoreMissingAuthUser } from '../moderation/status.js';
import type { User, UserSnapshot } from '../types.js';

/** O que a exclusão faz fora do Firestore (injetado: os testes só sobem o emulador do Firestore). */
export interface AccountDeletionDeps {
  deleteAuthUser(uid: string): Promise<void>;
  deleteAvatarFiles(uid: string): Promise<void>;
  deletePresence(uid: string): Promise<void>;
}

export const DELETED_SNAPSHOT: UserSnapshot = { displayName: 'Conta excluída', avatarUrl: null };

const BATCH_LIMIT = 400;

/**
 * Exclusão de conta pedida pelo próprio dono (LGPD e exigência das lojas).
 * O que apaga, o que anonimiza e o que mantém está em
 * docs/22-function-deleteAccount.md; em resumo:
 *
 * 1. Corta o contato como a moderação (`cutContact`): cancela o que não
 *    começou, tranca as conversas (`account_deleted`), desativa anúncios e
 *    apaga os tokens de push.
 * 2. Anonimiza o que é também do outro lado: snapshots em sessões e
 *    conversas e o autor das avaliações que escreveu (nota e tags ficam,
 *    para não mexer na média de quem foi avaliado; o comentário sai). As
 *    mensagens ficam: o histórico é do outro participante e serve de prova
 *    numa denúncia.
 * 3. Apaga: avaliações recebidas, bloqueios contra a pessoa, anúncios, o
 *    username (fica livre), `users/{uid}` com as subcoleções, avatar,
 *    presença e, por último, a conta no Auth.
 *
 * `reports` e `moderationActions` ficam, só com o uid (interesse legítimo
 * da moderação). Idempotente e sem depender de `users/{uid}`: se cair no
 * meio, chamar de novo termina o que faltou (por isso o username é achado
 * pelo uid, e não pelo perfil, que pode já ter sido apagado).
 */
export async function deleteAccount(db: Firestore, deps: AccountDeletionDeps, uid: string, now: Timestamp) {
  const user = (await db.doc(`users/${uid}`).get()).data() as User | undefined;
  // Suspenso ou banido não se exclui pelo app: excluir e entrar de novo com o
  // mesmo Google geraria um uid novo, limpo. O token de antes da suspensão
  // ainda vale por até 1 h; o pedido, nesse caso, vai pela moderação.
  if (user && user.status !== 'active') {
    throw new HttpsError('failed-precondition', 'Conta restrita pela moderação.', { reason: 'account_restricted' });
  }

  const contact = await cutContact(db, uid, 'account_deleted', now);

  const [sessions, conversations, written, received, blockedBy, listings, usernames] = await Promise.all([
    db.collection('sessions').where('participantIds', 'array-contains', uid).get(),
    db.collection('conversations').where('participantIds', 'array-contains', uid).get(),
    db.collection('reviews').where('authorId', '==', uid).get(),
    db.collection('reviews').where('targetId', '==', uid).get(),
    // Precisa do fieldOverride de `blocks.blockedUid` (firestore.indexes.json):
    // collection group não tem índice de campo único automático.
    db.collectionGroup('blocks').where('blockedUid', '==', uid).get(),
    db.collection('listings').where('ownerId', '==', uid).get(),
    db.collection('usernames').where('uid', '==', uid).get(),
  ]);

  const writes: ((batch: WriteBatch) => void)[] = [];
  const anonymize = (ref: DocumentReference) =>
    writes.push(b => b.update(ref, { [`participantSnapshots.${uid}`]: DELETED_SNAPSHOT }));
  sessions.docs.forEach(d => anonymize(d.ref));
  conversations.docs.forEach(d => anonymize(d.ref));
  written.docs.forEach(d => writes.push(b => b.update(d.ref, { comment: null, authorSnapshot: DELETED_SNAPSHOT })));
  [...received.docs, ...blockedBy.docs, ...listings.docs, ...usernames.docs].forEach(d =>
    writes.push(b => b.delete(d.ref)),
  );

  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    writes.slice(i, i + BATCH_LIMIT).forEach(write => write(batch));
    await batch.commit();
  }

  // Depois dos lotes: as subcoleções (private, games, blocks) vão junto, e
  // os triggers que acordam com isso (cartões, stats) já acham o perfil sumido.
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await Promise.all([deps.deleteAvatarFiles(uid), deps.deletePresence(uid)]);
  // Por último: sem o Auth a pessoa não chama de novo, então tudo o que vem
  // antes precisa ter dado certo.
  await deps.deleteAuthUser(uid).catch(ignoreMissingAuthUser);

  return {
    ...contact,
    anonymized: sessions.size + conversations.size + written.size,
    reviewsDeleted: received.size,
    blocksDeleted: blockedBy.size,
    listingsDeleted: listings.size,
  };
}
