# 22. Function `deleteAccount` (exclusão de conta, tarefa 33)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | callable (HTTPS), `timeoutSeconds: 300` |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/users/deleteAccount.ts` (callable), `functions/src/users/accountDeletion.ts` (lógica) |
| Testes | `test/accountDeletion.test.ts` |
| Chamada por | app: Meu perfil → "Excluir conta" |
| Entrada | nenhuma (o uid vem do token) |
| Saída | `{ ok: true }` |
| Erros | `unauthenticated`; `failed-precondition` com `reason: 'account_restricted'` |

Exigência da LGPD e das duas lojas para app que deixa criar conta. A
pessoa pede e tudo acontece na hora, sem período de carência.

## 22.1 O que acontece com cada dado

| Dado | O que acontece |
|---|---|
| `users/{uid}` com `private`, `games` e `blocks` | apagado (`recursiveDelete`), sem deixar registro |
| `usernames/{nick}` | apagado: o nick fica livre para outra pessoa |
| `listings` da pessoa | apagados (as sessões guardam só o `listingId`) |
| `users/*/blocks/{uid}` (quem bloqueou a pessoa) | apagados |
| `reviews` recebidas | apagadas: não há mais perfil onde mostrar |
| `reviews` escritas | ficam a nota e as tags, para não mexer na média de quem foi avaliado; `comment` vira `null` e `authorSnapshot` vira "Conta excluída" |
| `sessions` e `conversations` | ficam; o snapshot da pessoa vira "Conta excluída" sem avatar. As que não começaram são canceladas, e as conversas trancadas (`lockedReason: 'account_deleted'`) |
| `messages` | ficam: o histórico é também do outro participante e serve de prova numa denúncia |
| `reports`, `moderationActions` | ficam, só com o uid (interesse legítimo da moderação, LGPD art. 16) |
| Storage `avatars/{uid}/` | apagado |
| RTDB `status/{uid}` | apagado |
| Firebase Auth | conta apagada (`deleteUser`), por último |

Os **cartões de busca** somem sozinhos: a sync acha o perfil apagado
([doc 8](08-functions-searchCards.md)). Os **stats** do outro lado são
recalculados pelos triggers de sessão e avaliação
([doc 19](19-functions-stats.md)); os da pessoa excluída são ignorados,
porque o perfil não existe mais.

## 22.2 Ordem e retomada

1. `cutContact` (o mesmo da [moderação](21-function-moderation.md), sem a
   parte do Auth): cancela o que não começou, tranca conversas, desativa
   anúncios e apaga os `fcmTokens`. Cancelamento com `by = null`: sem push e
   sem peso na taxa de conclusão do outro lado.
2. Anonimização e remoções no Firestore, em lotes.
3. `recursiveDelete` de `users/{uid}`.
4. Avatar e presença.
5. Auth, por último: sem ele a pessoa não consegue chamar de novo, então
   tudo o que vem antes precisa ter dado certo.

Tudo é idempotente e não depende de `users/{uid}` existir (o username é
achado por `usernames where uid ==`). Se a função cair no meio, o app
mostra o erro e chamar de novo termina o que faltou.

## 22.3 Conta suspensa ou banida

Recusada com `account_restricted`. Excluir e entrar de novo com o mesmo
Google geraria um uid novo, limpo, e desfaria a punição. O ID token de antes
da suspensão ainda vale por até 1 h, então a checagem é necessária. Nesse
caso o pedido de exclusão vai pela moderação, à mão.

## 22.4 Índice

`collectionGroup('blocks').where('blockedUid', '==', uid)` precisa do
`fieldOverride` de `blocks.blockedUid` com escopo `COLLECTION_GROUP`
(`firestore.indexes.json`): índice de campo único em collection group não é
automático. O emulador não cobra; em produção, sem ele a função falha com
`FAILED_PRECONDITION`. **Publique os índices antes da função.**
