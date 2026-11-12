import type { Firestore } from 'firebase-admin/firestore';
import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import type { UserPrivate } from '../types.js';

// Esquema dos deep links do app (decisions.md, tarefa 26). O app abre a
// tela pelo `link` do `data` da notificação.
export const LINK_SCHEME = 'mynoobpro://';
export const sessionLink = (sessionId: string) => `${LINK_SCHEME}session/${sessionId}`;
export const chatLink = (conversationId: string) => `${LINK_SCHEME}chat/${conversationId}`;

/** Chave de `UserPrivate.notificationPrefs` que libera o push. */
export type PushPref = 'sessionRequests' | 'sessionUpdates' | 'messages';
/** Canais criados pelo app Android (MainApplication.kt): mesmos ids. */
export type PushChannel = 'sessions' | 'messages';

export type PushIntent = {
  to: string;
  pref: PushPref;
  channel: PushChannel;
  title: string;
  body: string;
  link: string;
  // Notificações com o mesmo `tag` se substituem na bandeja do Android:
  // 10 mensagens da mesma conversa viram 1 notificação (a última).
  tag: string;
};

/** `getMessaging().sendEachForMulticast`, recebido por parâmetro para os testes não falarem com o FCM. */
export type MulticastSender = (message: MulticastMessage) => Promise<BatchResponse>;

// Token que o FCM diz que não vale mais (app desinstalado, dados limpos):
// sai da lista para não ser tentado de novo a cada push.
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const BODY_MAX = 140;
const clip = (text: string) => (text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text);

/**
 * Envia cada push para todos os aparelhos do destinatário, respeitando
 * `notificationPrefs`. Falha de envio não lança: o push é um aviso, e a
 * informação já está no app (sessão, chat). Devolve quantos foram enviados.
 */
export async function sendPushes(db: Firestore, send: MulticastSender, intents: PushIntent[]): Promise<number> {
  let sent = 0;
  for (const intent of intents) {
    const privateRef = db.doc(`users/${intent.to}/private/data`);
    const data = (await privateRef.get()).data() as UserPrivate | undefined;
    const tokens = data?.fcmTokens ?? [];
    // Sem a chave = ligado (perfis criados antes de existir a preferência).
    if (tokens.length === 0 || data?.notificationPrefs?.[intent.pref] === false) {
      continue;
    }

    const response = await send({
      tokens,
      notification: { title: intent.title, body: clip(intent.body) },
      data: { link: intent.link },
      android: { priority: 'high', notification: { channelId: intent.channel, tag: intent.tag } },
    });
    sent += response.successCount;

    const dead = response.responses
      .map((r, i) => (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code) ? tokens[i] : null))
      .filter((t): t is string => t !== null);
    // Lista calculada em vez de `FieldValue.arrayRemove`: o FieldValue de uma
    // cópia do firebase-admin é recusado pela outra nos testes (docs/10-testes.md,
    // 10.3). Um token registrado no meio só volta no próximo início do app.
    if (dead.length > 0) {
      await privateRef.update({ fcmTokens: tokens.filter(t => !dead.includes(t)) });
    }
  }
  return sent;
}
