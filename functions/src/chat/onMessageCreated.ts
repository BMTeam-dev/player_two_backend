import { Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { db } from '../lib/admin.js';
import { sendPushes } from '../notifications/push.js';
import { handleNewMessage } from './messages.js';

// Só `onCreate`: as regras não deixam editar nem apagar mensagem, e a
// única escrita da própria função na mensagem (`flagged`) é um update, que
// não dispara este trigger de novo.
export const onMessageCreated = onDocumentCreated('conversations/{conversationId}/messages/{messageId}', async event => {
  const { conversationId, messageId } = event.params;
  const outcome = await handleNewMessage(db, conversationId, messageId, Timestamp.now());
  if (outcome.result === 'rate_limited') {
    logger.info(`onMessageCreated: mensagem ${conversationId}/${messageId} apagada pelo limite por minuto`);
  }
  if (outcome.flagged) {
    logger.info(`onMessageCreated: mensagem ${conversationId}/${messageId} marcada (flagged)`);
  }
  // Fora da transaction: retentativas da transaction não podem mandar o push
  // duas vezes. Quem está com a conversa aberta não vê o aviso (o app filtra).
  if (outcome.push.length > 0) {
    await sendPushes(db, message => getMessaging().sendEachForMulticast(message), outcome.push);
  }
});
