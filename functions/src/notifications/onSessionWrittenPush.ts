import { getMessaging } from 'firebase-admin/messaging';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db } from '../lib/admin.js';
import type { Session } from '../types.js';
import { sendPushes } from './push.js';
import { sessionPushes } from './sessionPushes.js';

// Trigger em vez de enviar dentro das callables: as mudanças de status vêm
// de 8 callables e 3 funções agendadas, e o push não pode atrasar nem
// derrubar nenhuma delas. Aqui ele é olhado num lugar só, pelo status.
export const onSessionWrittenPush = onDocumentWritten('sessions/{sessionId}', async event => {
  const before = (event.data?.before.data() as Session | undefined) ?? null;
  const after = (event.data?.after.data() as Session | undefined) ?? null;
  if (!after || before?.status === after.status) {
    return;
  }
  const game = await db.doc(`games/${after.gameId}`).get();
  const intents = sessionPushes(before, after, (game.get('name') as string | undefined) ?? after.gameId);
  if (intents.length > 0) {
    await sendPushes(db, message => getMessaging().sendEachForMulticast(message), intents);
  }
});
