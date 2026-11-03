import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { Presence } from '../types.js';

export type MirrorResult = 'updated' | 'stale' | 'no_profile';

/**
 * Copia `status/{uid}` do RTDB para `isOnline`/`lastSeenAt` em `users/{uid}`.
 * `presence` null = nó apagado, tratado como offline.
 *
 * Triggers do RTDB não chegam garantidamente em ordem: um "online" atrasado
 * pode chegar depois do "offline" seguinte e deixar a pessoa online para
 * sempre. `lastSeenAt` guarda o `lastChanged` do último evento aplicado, e um
 * evento mais antigo que ele é descartado.
 */
export async function mirrorPresence(
  db: Firestore,
  uid: string,
  presence: Presence | null,
  now: Timestamp,
): Promise<MirrorResult> {
  const userRef = db.doc(`users/${uid}`);
  const isOnline = presence?.state === 'online';
  const changedAtMs = presence ? presence.lastChanged : now.toMillis();

  return db.runTransaction(async tx => {
    const snapshot = await tx.get(userRef);
    // Quem ainda não terminou o onboarding não tem perfil: não cria um
    // documento só com presença, que as regras e a busca não esperam.
    if (!snapshot.exists) {
      return 'no_profile';
    }
    const lastSeenAt = snapshot.get('lastSeenAt') as Timestamp | null | undefined;
    if (lastSeenAt && lastSeenAt.toMillis() > changedAtMs) {
      return 'stale';
    }
    // Sem `updatedAt`: ele marca edição de perfil, e a presença muda a cada
    // vez que o app vai para segundo plano. `Date` em vez de
    // `Timestamp.fromMillis`: o Firestore converte do mesmo jeito, e não
    // quebra quando quem chama (os testes) usa outra cópia do firebase-admin.
    tx.update(userRef, { isOnline, lastSeenAt: new Date(changedAtMs) });
    return 'updated';
  });
}
