import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from '../lib/admin.js';
import type { Review, Session, SessionStatus } from '../types.js';
import { refreshUserStats } from './stats.js';

// Status que mudam algum número das stats: resposta ao pedido (tempo de
// resposta), conclusão, cancelamento e ausência (taxa de conclusão).
const STATS_STATUSES: SessionStatus[] = ['accepted', 'declined', 'completed', 'cancelled', 'no_show'];

export function sessionStatsUids(before: Session | null, after: Session | null): string[] {
  if (!after || before?.status === after.status || !STATS_STATUSES.includes(after.status)) {
    return [];
  }
  return after.participantIds;
}

/** Só quando uma avaliação passa a contar (ou deixa de contar) na média. */
export function reviewStatsUid(before: Review | null, after: Review | null): string | null {
  if ((before?.visible ?? false) === (after?.visible ?? false)) {
    return null;
  }
  return (after ?? before)!.targetId;
}

// Trigger separado do push (onSessionWrittenPush): um não pode atrasar nem
// derrubar o outro.
export const onSessionWrittenStats = onDocumentWritten('sessions/{sessionId}', async event => {
  const uids = sessionStatsUids(
    (event.data?.before.data() as Session | undefined) ?? null,
    (event.data?.after.data() as Session | undefined) ?? null,
  );
  await Promise.all(uids.map(uid => refreshUserStats(db, uid)));
});

export const onReviewWrittenStats = onDocumentWritten('reviews/{reviewId}', async event => {
  const uid = reviewStatsUid(
    (event.data?.before.data() as Review | undefined) ?? null,
    (event.data?.after.data() as Review | undefined) ?? null,
  );
  if (uid) {
    await refreshUserStats(db, uid);
  }
});
