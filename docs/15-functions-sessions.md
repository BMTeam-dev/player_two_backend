# 15. Functions de sessão

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | callables (`onCall`), HTTPS |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/sessions/sessionCallables.ts` e `scheduledSessions.ts` (adaptadores), `request.ts` (pedido), `transitions.ts` (transições), `scheduled.ts` (transições automáticas), `shared.ts` (erros, eventos, mensagem de sistema) |
| Testes | `test/sessions.test.ts`, `test/scheduledSessions.test.ts` |
| Quem chama | O app, nas telas de sessão (tarefa 24); o Cloud Scheduler, nas agendadas |
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
    └──(sem resposta: expireSessionRequests)──► expired
requested | accepted ──cancel──► cancelled
accepted | in_progress | awaiting_confirmation ──reportNoShow (depois do horário)──► no_show

accepted ──(horário chegou: autoAdvanceSessions)──► in_progress ──(fim passou)──► awaiting_confirmation ──(24 h: autoCompleteSessions)──► completed
```

| Callable | Quem | De | Para | Condição extra | Chat |
|---|---|---|---|---|---|
| `acceptSession` | provider | `requested` | `accepted` | antes de `requestExpiresAt` | "X aceitou a sessão." |
| `declineSession` | provider | `requested` | `declined` | | "X recusou o pedido." |
| `cancelSession` | os dois | `requested`, `accepted` | `cancelled` | motivo opcional (≤ 200) | "X cancelou a sessão." |
| `startSession` | os dois | `accepted` | `in_progress` | a partir de 15 min antes do início | |
| `markSessionDone` | os dois | `in_progress` | `awaiting_confirmation` | já confirma o lado de quem marcou | |
| `confirmSession` | os dois | `awaiting_confirmation` | `completed` quando os dois confirmaram | repetir é ignorado | "Sessão concluída..." |
| `reportNoShow` | os dois | `accepted`, `in_progress`, `awaiting_confirmation` | `no_show` | depois do início; em `awaiting_confirmation`, só quem ainda não confirmou; `absentUid` = o outro | "X informou que a outra pessoa não apareceu." |

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

`SystemEvent` ganhou `session_declined`, `session_no_show` e `session_expired`.

## 15.5 Transições automáticas (tarefa 23)

Três funções agendadas (`onSchedule`, fuso `America/Sao_Paulo`), com o
evento gravado com `actorId: null`:

| Função | Frequência | Consulta (índice) | Transição | Chat |
|---|---|---|---|---|
| `expireSessionRequests` | a cada 10 min | `status == requested`, `requestExpiresAt <= now` | `requested` → `expired` | "O pedido expirou sem resposta." |
| `autoAdvanceSessions` | a cada 10 min | `status == accepted`, `scheduledStart <= now` | `accepted` → `in_progress` (`startedAt`) | |
| | | `status == in_progress`, `scheduledEnd <= now` | `in_progress` → `awaiting_confirmation` (`endedAt`, evento `marked_done`) | |
| `autoCompleteSessions` | a cada 1 h | `status == awaiting_confirmation`, `endedAt <= now - autoCompleteAfterHours` | `awaiting_confirmation` → `completed` (evento `auto_completed`) | "Sessão concluída automaticamente..." |

Passo a passo de cada uma:

1. Consulta em páginas de **100**, até **10 páginas** por execução (o que
   sobrar fica para a próxima, como em `expireAvailability`).
2. Para cada sessão, uma **transaction** relê o documento e confere de novo o
   status e o horário. Se alguém agiu entre a consulta e a escrita (ex: o
   provider aceitou no último segundo), a sessão é pulada.
3. Até 10 transactions em paralelo. Uma que falha não derruba as outras
   (`Promise.allSettled`).

No `autoAdvanceSessions`, o início roda antes do fim: uma sessão aceita e
nunca iniciada, cujo horário de fim já passou, vai até
`awaiting_confirmation` na mesma execução.

Mensagens automáticas não têm autor, então somam 1 no `unread` dos dois
participantes.

**"Sem objeção"** é: ninguém usou o "não apareceu" nas 24 h. Por isso o
`reportNoShow` também vale em `awaiting_confirmation`, para quem ainda não
confirmou: o avanço pelo horário leva até lá mesmo uma sessão em que ninguém
apareceu, e essa é a única forma de contestar antes da conclusão automática.

## 15.6 O que fica para outras tarefas

- **Push** de pedido recebido e aceito: trigger de `sessions` (tarefa 26).
- **`stats`** (`sessionsCompleted`, `completionRate`): trigger de
  `sessions` (tarefa 30).
- **Telas**: tarefa 24.

## 15.7 Testes

`test/sessions.test.ts` (15 testes):

- `parseRequestInput`, `requestExpiresAtMs`, `parseTransitionInput`.
- `requestSession`: tudo o que é criado, preço/categoria/duração do anúncio,
  anúncio inativo ou de outra pessoa, pedir para si, jogador inexistente ou
  banido, conta suspensa, bloqueio nos dois sentidos, jogo fora do perfil,
  pedido duplicado e limite por hora com virada da janela.
- Transições: ator errado, terceiro, pedido vencido, estado inválido,
  recusa, cancelamento com motivo, "começar" cedo demais, fluxo completo até
  `completed` com confirmação repetida, "não apareceu" antes e depois do
  horário, e em `awaiting_confirmation` só para quem não confirmou.

`test/scheduledSessions.test.ts` (5 testes): expiração só dos vencidos, com
evento e aviso; paginação com 120 pedidos; início e fim pelo horário,
inclusive a sessão esquecida que passa pelos dois; conclusão após 24 h,
com sessões meio confirmadas; prazo lido de `config/app`.
