# 20. Functions de bloquear e denunciar (tarefa 31)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | 3 callables (HTTPS) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/safety/safetyCallables.ts` (adaptadores), `block.ts`, `report.ts`, `shared.ts` (lógica) |
| Testes | `test/safety.test.ts`, bloco `users/{uid}/blocks` de `test/firestore.rules.test.ts` |
| Disparo | app: perfil público, chat, sessão e avaliação |
| Escreve | `users/{uid}/blocks/{targetUid}`, `conversations` (tranca), `sessions` (cancela), `reports`, `users/{uid}/private/data.rateLimit` |

## 20.1 `blockUser` / `unblockUser`

Entrada: `{ targetUid }`. Bloquear a si mesmo é `self_target`, e um jogador
que não existe é `user_not_found`.

`blockUser` roda numa transaction:

1. Grava `users/{uid}/blocks/{targetUid}`. Só o dono lê esse documento; quem
   foi bloqueado não descobre pelas regras.
2. Busca as sessões entre os dois, com uma consulta em cada sentido
   (`requesterId`/`providerId`, só igualdade).
3. **Tranca** as conversas dessas sessões que ainda não estavam trancadas
   (`lockedAt`, `lockedReason: 'block'`). As regras de `messages` já recusam
   mensagem em conversa trancada.
4. **Cancela** as sessões `requested` e `accepted`, que ainda não começaram.
   As `in_progress` e `awaiting_confirmation` seguem o fluxo normal, sem
   chat: dá para terminar, confirmar ou registrar ausência.

O cancelamento por bloqueio grava `cancellation.by = null`, como uma
transição automática, e o evento sai com `actorId: null`. Com isso:

- não pesa na **taxa de conclusão** de quem bloqueou, porque a `stats.ts`
  conta `cancellation.by == uid`. Bloquear quem assedia não é furar;
- **não gera push** para o bloqueado (a `sessionPushes` ignora `by: null`) nem
  mensagem de sistema no chat, que já está trancado. Avisar só confirmaria o
  bloqueio.

Bloquear de novo não muda nada, porque a função é idempotente.

`unblockUser` só apaga o bloqueio. **As conversas continuam trancadas e as
sessões não voltam.** Para jogar de novo, um pedido novo abre uma conversa
nova.

O que o bloqueio já impedia antes desta tarefa: a `requestSession` recusa
pedido quando há bloqueio em qualquer sentido, com o mesmo erro (`blocked`)
para os dois lados.

## 20.2 `submitReport`

Entrada: `{ targetType, targetId, reason, details?, conversationId?,
messageIds? }`.

| `targetType` | `targetId` | Quem é denunciado (`targetUserId`) | Quem pode denunciar |
|---|---|---|---|
| `user` | uid | o próprio | qualquer um |
| `message` | id da mensagem (`conversationId` é obrigatório) | o autor; mensagem de sistema é recusada | participante da conversa |
| `listing` | id do anúncio | o dono | qualquer um |
| `session` | id da sessão | o outro participante | participante |
| `review` | id da avaliação | o autor | qualquer um, se visível; se cega, só o autor (que não vai se denunciar) |

Regras:

- O **servidor descobre quem é denunciado**: o app não escolhe. Ninguém se
  denuncia (`self_target`).
- **Alvo invisível é igual a inexistente** (`target_not_found`): a denúncia
  não serve para descobrir ids, nem se uma avaliação cega existe.
- **Evidência** (`conversationId` + até 20 `messageIds`): a conversa precisa
  ter o denunciante **e** o denunciado, e as mensagens precisam existir nela
  (`evidence_not_found`). Na denúncia de sessão, a conversa da sessão entra
  sozinha como evidência; na de mensagem, a própria mensagem entra na lista.
- `details` vai até 1000 caracteres e é obrigatório no motivo `other`.
- **Limite:** `config/app.rateLimits.reportsPerDay` (10), numa janela de 24 h
  contada a partir da primeira denúncia, em `private/data.rateLimit`
  (`rate_limited`). Denúncia em massa é vetor de assédio.
- **`priority`:** `high` para `underage`, `sexual_content` e `fraud` (MVP.md
  12.1), `low` para `spam` e `normal` para o resto.

### Aviso para a moderação

Quando a prioridade é `high`, a callable registra um aviso no Cloud Logging
(`submitReport: HIGH <motivo>`, com `reportId` e `targetUserId`). A
moderação filtra por esse texto no Logs Explorer e abre `reports` no
Console. Na v0, sem push nem e-mail (`decisions.md` do app, tarefa 31).

O MVP.md (7.2) previa um trigger em `reports`. Ele não foi feito: só esta
callable cria denúncias, e o trigger custaria uma invocação a mais sem
ganho. Se o aviso virar e-mail, ele entra aqui ou num trigger.

Para receber alerta em vez de procurar no log: Cloud Monitoring → alerta
baseado em log com o filtro `jsonPayload.message:"submitReport: HIGH"`.

## 20.3 Testes

`test/safety.test.ts` (18 testes):

- Payloads: `parseTargetUid`, `parseReportInput` (alvo, motivo, detalhe
  obrigatório em `other`, evidência sem conversa, mais de 20 mensagens),
  `priorityOf`; push de sessão cancelada por bloqueio vazio.
- `blockUser`: bloqueio, conversas trancadas, só `requested`/`accepted`
  canceladas (com `by: null` e evento sem ator), sessões com outra pessoa
  intactas; taxa de conclusão dos dois intacta; idempotente; jogador
  inexistente. `unblockUser` mantém a conversa trancada.
- `submitReport`: os 5 tipos de alvo com o `targetUserId` certo;
  prioridade; evidência; mensagem de sistema, própria e de conversa alheia;
  avaliação cega; a si mesmo; inexistente; sem perfil; limite diário com a
  virada da janela e o valor de `config/app`.

Regras: só o dono lê os próprios bloqueios, e o cliente não grava nem apaga.
