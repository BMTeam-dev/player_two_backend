import { AggregateField, type Firestore } from 'firebase-admin/firestore';
import type { User } from '../types.js';

export type UserStats = User['stats'];

/**
 * Recalcula `users/{uid}.stats` do zero, com consultas de agregação (`count`
 * e `average`), em vez de somar e subtrair contadores a cada evento. Custa
 * algumas leituras a mais por evento, mas é idempotente: trigger repetido ou
 * fora de ordem não deixa o número errado para sempre, e o mesmo código
 * corrige o histórico (scripts/rebuild-stats.ts). Só filtros de igualdade:
 * nenhuma consulta precisa de índice composto.
 *
 * - Nota: só avaliações **visíveis**. Contar as cegas mudaria a média antes
 *   da revelação e entregaria a nota que ainda está escondida.
 * - Taxa de conclusão (MVP.md 6.1): concluídas / (concluídas + sessões já
 *   aceitas que a pessoa cancelou + ausências dela). Vale nos dois papéis: no
 *   MyNoobPro quem pede também é jogador, e furar com um duo pesa igual.
 *   Sem histórico, 1 (ninguém começa com taxa ruim).
 * - Tempo de resposta: média do `responseMinutes` dos pedidos que a pessoa
 *   aceitou ou recusou. Pedido que expirou sem resposta não entra (não há
 *   um tempo para medir).
 */
export async function computeStats(db: Firestore, uid: string): Promise<UserStats> {
  const sessions = db.collection('sessions');
  const [reviews, completed, cancelled, noShows, responses] = await Promise.all([
    db
      .collection('reviews')
      .where('targetId', '==', uid)
      .where('visible', '==', true)
      .aggregate({ count: AggregateField.count(), avg: AggregateField.average('rating') })
      .get(),
    sessions.where('participantIds', 'array-contains', uid).where('status', '==', 'completed').count().get(),
    sessions.where('cancellation.by', '==', uid).where('cancellation.fromStatus', '==', 'accepted').count().get(),
    sessions.where('noShow.absentUid', '==', uid).count().get(),
    sessions.where('providerId', '==', uid).aggregate({ avg: AggregateField.average('responseMinutes') }).get(),
  ]);

  const ratingCount = reviews.data().count;
  const sessionsCompleted = completed.data().count;
  const failures = cancelled.data().count + noShows.data().count;
  const avgResponse = responses.data().avg;

  return {
    ratingAvg: ratingCount > 0 ? round(reviews.data().avg ?? 0, 2) : 0,
    ratingCount,
    sessionsCompleted,
    completionRate: sessionsCompleted + failures > 0 ? round(sessionsCompleted / (sessionsCompleted + failures), 2) : 1,
    avgResponseMinutes: avgResponse == null ? null : Math.round(avgResponse),
  };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

const sameStats = (a: Partial<UserStats> | undefined, b: UserStats) =>
  !!a && (Object.keys(b) as (keyof UserStats)[]).every(key => a[key] === b[key]);

/**
 * Recalcula e grava as stats de `uid` se mudaram. Gravar no perfil dispara a
 * sync dos searchCards (que copiam nota e taxa), então escrever sem mudança
 * custaria mais um trigger à toa. Devolve se gravou.
 */
export async function refreshUserStats(db: Firestore, uid: string) {
  const userRef = db.doc(`users/${uid}`);
  const [user, stats] = await Promise.all([userRef.get(), computeStats(db, uid)]);
  if (!user.exists || sameStats(user.get('stats') as Partial<UserStats> | undefined, stats)) {
    return false;
  }
  // Sem `updatedAt`: ele marca edição do perfil pela pessoa, não um número
  // derivado mudando.
  await userRef.update({ stats });
  return true;
}
