# 17. Push (FCM)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | trigger Firestore (`onSessionWrittenPush`) + envio dentro de `onMessageCreated` |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/notifications/push.ts` (envio), `sessionPushes.ts` (quem recebe em cada mudança de sessão), `onSessionWrittenPush.ts` (gatilho); `functions/src/chat/messages.ts` (push de mensagem) |
| Testes | `test/push.test.ts`, `test/chat.test.ts` |
| Lê | `users/{uid}/private/data` (`fcmTokens`, `notificationPrefs`), `games/{gameId}` (nome do jogo) |
| Escreve | `users/{uid}/private/data.fcmTokens` (só para tirar token morto) |

## 17.1 Quando sai push

| Evento | Quem recebe | Preferência | Canal Android |
|---|---|---|---|
| Pedido de sessão novo | provider | `sessionRequests` | `sessions` |
| Pedido aceito, recusado ou expirado | requester | `sessionUpdates` | `sessions` |
| Pedido ou sessão cancelados | o outro lado | `sessionUpdates` | `sessions` |
| Mensagem de texto nova | os outros participantes | `messages` | `messages` |

Início, fim e conclusão de sessão e mensagens de sistema não geram push: o
evento importante já tem o seu (a mensagem de sistema "X aceitou" chegaria
junto com o push "Pedido aceito").

## 17.2 Como funciona

- **Sessões:** um trigger só, `onDocumentWritten('sessions/{id}')`, olha a
  mudança de `status`. As transições vêm de 8 callables e 3 funções
  agendadas; enviar o push dentro delas espalharia a regra e deixaria cada
  uma mais lenta. Sem mudança de status, sai sem ler nada.
- **Mensagens:** `handleNewMessage` devolve os avisos (`push`) e o
  `onMessageCreated` envia depois da transaction, para uma retentativa da
  transaction não mandar o push duas vezes. Mensagem apagada pelo limite
  por minuto não gera push.
- **Envio** (`sendPushes`): `sendEachForMulticast` para todos os tokens do
  destinatário, com `notification` (o Android mostra sozinho com o app em
  segundo plano), `data.link` (deep link, ver abaixo) e
  `android.notification.{channelId, tag}`. O `tag` (`chat_{id}`,
  `session_{id}`) faz notificações da mesma conversa ou sessão se
  substituírem na bandeja.
- **Preferência ausente** conta como ligada. O app ainda não tem tela de
  preferências; os perfis nascem com tudo ligado (`completeOnboarding`).
- **Token morto** (`registration-token-not-registered`,
  `invalid-registration-token`) sai de `fcmTokens`.
- Falha de envio não lança: o push é um aviso, e a informação continua no app.

## 17.3 Deep links

`data.link` = `mynoobpro://session/{id}` ou `mynoobpro://chat/{id}`
(`LINK_SCHEME` em `push.ts`). O app tem o mesmo formato em
`src/shared/deepLinks.ts`: mude os dois juntos.

## 17.4 Tokens

O app grava o token em `fcmTokens` depois do onboarding, mantém no máximo
10 (o limite das regras, ficando os mais recentes) e tira o do aparelho
antes de sair da conta, para a próxima conta no mesmo aparelho não
receber pushes da anterior.

## 17.5 Limitações conhecidas

- Não sabemos se a pessoa está com a conversa aberta: o push de mensagem
  sempre sai, e o app descarta o aviso quando já está na tela dela.
- Entrega "pelo menos uma vez" dos triggers: raramente, um push pode
  chegar duas vezes. O `tag` faz o segundo substituir o primeiro na bandeja.
- iOS: nada configurado (APNs) ainda; o beta da v0 é só Android.
