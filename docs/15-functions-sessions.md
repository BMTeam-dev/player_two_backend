# 15. Functions de sessão

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | callables (`onCall`), HTTPS |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/sessions/sessionCallables.ts` (adaptadores), `request.ts` (pedido), `transitions.ts` (transições), `shared.ts` (erros, eventos, mensagem de sistema) |
| Testes | `test/sessions.test.ts` |
| Quem chama | O app, nas telas de sessão (tarefa 24) |
| Escreve | `sessions/{id}`, `sessions/{id}/events`, `conversations/{id}`, `conversations/{id}/messages`, `users/{uid}/private/data.rateLimit` |

## 15.1 Por que são Functions

Uma sessão envolve **duas pessoas**, e as regras proíbem o cliente de
escrever em `sessions`. Cada transição precisa validar, numa transaction,
**quem** está agindo e **em que estado** a sessão está. Sem isso, aceitar e
cancelar ao mesmo tempo poderiam passar os dois.

## 15.2 Máquina de estados (MVP.md 6.1)

```text
requested ──accept (provider)──► accepted ──start──► in_progress ──markDone──► awaiting_confirmation ──confirm (2º lado)──► completed
    ├──decline (provider)──► declined
    └──(sem resposta: tarefa 23)──► expired
requested | accepted ──cancel──► cancelled
accepted | in_progress ──reportNoShow (depois do horário)──► no_show
```

| Callable | Quem | De | Para | Condição extra | Chat |
|---|---|---|---|---|---|
| `acceptSession` | provider | `requested` | `accepted` | antes de `requestExpiresAt` | "X aceitou a sessão." |
| `declineSession` | provider | `requested` | `declined` | | "X recusou o pedido." |
| `cancelSession` | os dois | `requested`, `accepted` | `cancelled` | motivo opcional (≤ 200) | "X cancelou a sessão." |
| `startSession` | os dois | `accepted` | `in_progress` | a partir de 15 min antes do início | |
| `markSessionDone` | os dois | `in_progress` | `awaiting_confirmation` | já confirma o lado de quem marcou | |
| `confirmSession` | os dois | `awaiting_confirmation` | `completed` quando os dois confirmaram | repetir é ignorado | "Sessão concluída..." |
| `reportNoShow` | os dois | `accepted`, `in_progress` | `no_show` | depois do início; `absentUid` = o outro | "X informou que a outra pessoa não apareceu." |

Todas recebem `{ sessionId }` (`cancelSession` também `reason`) e devolvem
`{ sessionId, status }`. Cada transição grava um `events/{id}` com
`fromStatus`, `toStatus`, `actorId` e `meta` (o motivo do cancelamento).

Quem não participa da sessão recebe `session_not_found`, o mesmo erro de um
id inexistente: assim não dá para descobrir se a sessão existe.

## 15.3 `requestSession`

```ts
await requestSession({
  providerId: 'bob',
  listingId: 'abc',          // omitido ou null = convite direto, sem anúncio
  gameId: 'valorant',
  scheduledStartMs: null,    // null = agora; senão até 7 dias à frente
  durationMinutes: 60,       // 15-240, de 15 em 15 (com anúncio, vale a do anúncio)
  message: 'Bora?',          // opcional, até 300
});
// → { sessionId, conversationId }
```

Verificações, nesta ordem:

| Verificação | `reason` |
|---|---|
| não é para si mesmo | `self_request` |
| requester com perfil completo | `no_profile` |
| requester com `status == 'active'` | `account_restricted` |
| provider existe, perfil completo e ativo | `provider_unavailable` |
| nenhum dos dois bloqueou o outro | `blocked` |
| anúncio ativo, do provider e do mesmo jogo | `listing_unavailable` |
| provider tem o jogo no perfil, e o jogo está ativo | `game_not_offered` |
| não há outro pedido `requested` desta dupla, neste sentido | `already_requested` |
| menos de `rateLimits.sessionRequestsPerHour` pedidos na última hora | `rate_limited` |

O bloqueio dá a mesma resposta nos dois sentidos, para quem foi bloqueado
não descobrir.

Com anúncio, a sessão copia `category`, `priceCents` (em `listedPriceCents`,
o registro do combinado) e `sessionMinutes`. Sem anúncio, é `play_together`,
grátis, com a duração do payload.

**Prazo para responder (`requestExpiresAt`)**: "agora" vence em
`sessionRequestTtlMinutes.now` (15 min). Com horário, vence no início
marcado, limitado a `scheduled` (12 h) e nunca antes de `now` (15 min).

**Limite por hora**: janela fixa em `users/{uid}/private/data.rateLimit`.
Se a janela tem mais de 1 h, recomeça com o pedido atual.

Na mesma transaction, cria:

- a sessão `requested`, com `scheduledEnd = scheduledStart + durationMinutes`;
- o evento `created`;
- a conversa da sessão (1 por pedido, decisão de 24/10/2026), já com a
  mensagem de sistema `session_requested` e `unread` 1 para o provider.

## 15.4 Mensagens de sistema e `unread`

As callables gravam a mensagem de sistema **e** já atualizam `lastMessage` e
`unread` da conversa (+1 para quem não causou o evento). O trigger de
mensagens da tarefa 25 deve tratar **só** as mensagens de texto, senão as de
sistema seriam contadas duas vezes.

O `unread` é calculado a partir da conversa lida na transaction, sem
`FieldValue.increment` (ver [testes, 10.3](10-testes.md#103-por-que-a-lógica-recebe-db-e-now)).

`SystemEvent` ganhou `session_declined` e `session_no_show`.

## 15.5 O que fica para outras tarefas

- **Expirar pedidos, começar/terminar pelo horário e concluir após 24 h**:
  funções agendadas da tarefa 23. Até lá, um pedido vencido continua
  `requested`, mas não pode mais ser aceito (`request_expired`).
- **Push** de pedido recebido e aceito: trigger de `sessions` (tarefa 26).
- **`stats`** (`sessionsCompleted`, `completionRate`): trigger de
  `sessions` (tarefa 30).
- **Telas**: tarefa 24.

## 15.6 Testes

`test/sessions.test.ts` (14 testes):

- `parseRequestInput`, `requestExpiresAtMs`, `parseTransitionInput`.
- `requestSession`: tudo o que é criado, preço/categoria/duração do anúncio,
  anúncio inativo ou de outra pessoa, pedir para si, jogador inexistente ou
  banido, conta suspensa, bloqueio nos dois sentidos, jogo fora do perfil,
  pedido duplicado e limite por hora com virada da janela.
- Transições: ator errado, terceiro, pedido vencido, estado inválido,
  recusa, cancelamento com motivo, "começar" cedo demais, fluxo completo até
  `completed` com confirmação repetida, "não apareceu" antes e depois do
  horário.
