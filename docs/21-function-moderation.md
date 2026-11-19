# 21. Function `onUserStatusChanged` (moderação, tarefa 32)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | trigger Firestore (`onDocumentWritten`, com `retry`) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/moderation/onUserStatusChanged.ts` (gatilho), `functions/src/moderation/status.ts` (lógica) |
| Testes | `test/moderation.test.ts` |
| Disparo | escrita em `users/{uid}` em que o `status` muda |
| Escreve | `conversations` (tranca), `sessions` + `events` (cancela), `listings` (desativa), `users/{uid}/private/data.fcmTokens`, Firebase Auth (`disabled`, refresh tokens) |

## 21.1 Como a moderação usa

Sem painel admin (MVP.md 12.2). A moderação abre `users/{uid}` no Console e
troca `status` para `suspended` ou `banned`. O trigger aplica o resto. Para
desfazer, a moderação volta o `status` para `active`.

## 21.2 Suspender ou banir (`restrictUser`)

Na ordem:

1. **Conversas:** tranca todas as da pessoa (`lockedReason: 'moderation'`).
   As regras de `messages` já recusam mensagem em conversa trancada.
2. **Sessões `requested` e `accepted`:** canceladas como do sistema
   (`cancellation.by = null`, evento sem ator), igual ao bloqueio da
   [tarefa 31](20-functions-safety.md). Não geram push nem pesam na taxa de
   conclusão do outro lado. As sessões em andamento e as aguardando
   confirmação seguem o fluxo normal, e as automáticas as concluem.
3. **Anúncios ativos:** desativados.
4. **`fcmTokens`:** apagados, para não chegar push num aparelho cuja conta
   não entra mais.
5. **Auth:** `disabled: true` e `revokeRefreshTokens`. Sem isso, a pessoa
   entraria de novo com o Google.

Os **cartões de busca** somem sozinhos, porque o `onUserWrittenSyncCards`
calcula `visible` pelo status ([doc 8](08-functions-searchCards.md)).

**Por que o banco vem antes do Auth:** o ID token já emitido continua
valendo nas regras por até 1 h depois da revogação (ver o topo de
`firestore.rules`). O que corta o contato na hora são os passos 1 a 3. Se o
Auth falhar, o contato já está cortado, o erro sobe e o `retry` tenta de
novo. Como tudo é idempotente, repetir não tranca nem cancela nada duas
vezes. Perfil sem conta no Auth (seed) recebe os efeitos no banco, e o
`auth/user-not-found` é ignorado.

**Consultas só com índice existente:** conversas por `participantIds` +
`lastMessage.at ↓`, sessões por `participantIds` + `status` +
`scheduledStart ↓` e anúncios por `ownerId` + `active` + `createdAt ↓`. A
moderação não pode falhar por falta de índice, como aconteceu com as
médias da [tarefa 30](19-functions-stats.md). Conversa sem `lastMessage`
ficaria fora da consulta, mas toda conversa nasce com a mensagem de
sistema do pedido.

## 21.3 Voltar para `active` (`restoreUser`)

Só reativa o login (`disabled: false`). O que aconteceu durante a suspensão
não se desfaz sozinho:

- as conversas continuam trancadas;
- as sessões canceladas não voltam;
- os anúncios ficam inativos até a pessoa reativá-los.

Os cartões voltam pela sync.

## 21.4 Quando age

`statusChange(before, after)`:

| De → para | Ação |
|---|---|
| `active` → `suspended`/`banned` | restringe |
| `suspended` → `banned` (e vice-versa) | restringe de novo (idempotente) |
| `suspended`/`banned` → `active` | restaura |
| status igual, cadastro, exclusão | nada |

Quase toda escrita em `users` (presença, perfil, stats) não muda o status e
sai na primeira linha. O custo é uma invocação curta a mais por escrita.

## 21.5 O que fica para depois

- **Suspensão com prazo** (`moderationActions.until`): hoje a moderação volta
  o status à mão. Uma agendada pode fazer isso sozinha.
- **Aviso no app:** a conta desativada não consegue entrar. A tela de login
  precisa explicar o erro `auth/user-disabled` (parte do app).
- **Avaliações** escritas por quem foi banido continuam visíveis. Esconder é
  uma decisão por caso (`hide_content`).

## 21.6 Testes

`test/moderation.test.ts` (8 testes):

- `statusChange`: restringe, restaura e ignora.
- `restrictUser`: conversas trancadas (só as da pessoa), só
  `requested`/`accepted` canceladas, com evento sem ator; anúncios ativos
  desativados (os de outros, intactos); `fcmTokens` apagados sem mexer no
  resto de `private`; Auth desativado e tokens revogados; repetir não muda
  nada; perfil sem conta no Auth; Auth fora do ar com o banco já cortado.
- `restoreUser`: reativa o login e mantém conversa e anúncio como estavam.

O Auth é um falso injetado (`ModerationAuth`), porque o `npm test` só sobe o
emulador do Firestore.
