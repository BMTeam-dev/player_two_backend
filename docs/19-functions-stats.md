# 19. Functions de estatísticas do perfil (tarefa 30)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | 2 triggers Firestore (`onDocumentWritten`) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/stats/statsTriggers.ts` (gatilhos), `functions/src/stats/stats.ts` (lógica), `scripts/rebuild-stats.ts` |
| Testes | `test/stats.test.ts` |
| Disparo | `onSessionWrittenStats`: escrita em `sessions/{id}`. `onReviewWrittenStats`: escrita em `reviews/{id}` |
| Escreve | `users/{uid}.stats` (e, por consequência, os `searchCards` via `onUserWrittenSyncCards`) |

## 19.1 O que é cada número

| Campo | Fórmula |
|---|---|
| `ratingAvg`, `ratingCount` | média (2 casas) e quantidade das avaliações **visíveis** recebidas (`targetId == uid`). Sem avaliação: `0` e `0` |
| `sessionsCompleted` | sessões `completed` em que a pessoa participou, nos dois papéis |
| `completionRate` | `concluídas / (concluídas + canceladas por ela depois de aceitas + ausências dela)`, 2 casas. Sem histórico: `1` |
| `avgResponseMinutes` | média (inteira) de `sessions.responseMinutes` dos pedidos que ela recebeu e respondeu. Nenhum: `null` |

Decisões:

- **Só avaliações visíveis.** Se a média contasse as cegas, ela mudaria
  antes da revelação e entregaria uma nota ainda escondida.
- **Taxa nos dois papéis.** O MVP.md (6.1) escreve a taxa do ponto de vista
  do provider. No MyNoobPro quem pede sessão também é jogador, e furar com
  um duo pesa igual, então conta o que a pessoa fez em qualquer papel.
  Cancelar um pedido ainda não aceito (`fromStatus: 'requested'`) não pesa.
  Isso é desistir antes de combinar.
- **Ausência conta para quem faltou** (`noShow.absentUid`), não para quem
  registrou. Um registro falso de ausência derruba a taxa de um inocente. O
  caminho para isso é a denúncia (tarefa 31) e a moderação.
- **Pedido que expirou sem resposta** não entra no tempo de resposta: não
  há um tempo para medir. Se isso esconder providers que nunca respondem,
  dá para somar o TTL como tempo de resposta.

## 19.2 Por que recontar em vez de somar

`computeStats` recalcula tudo do zero com 5 consultas de agregação
(`count()` e `average()`), em vez de somar e subtrair contadores a cada
evento. Cada recálculo custa algumas leituras: 1 por consulta, até 1000
documentos contados. Em troca:

- é **idempotente**. Um trigger repetido ou fora de ordem não deixa um
  número errado para sempre: o próximo recálculo acerta;
- o **mesmo código** corrige o histórico (`npm run db:rebuild-stats`);
- as consultas de `count()` usam só filtros de igualdade (e
  `array-contains`) e não precisam de índice composto: o Firestore junta os
  índices de campo único.

**Mas `average()` precisa de índice composto com o campo da média.** São
dois: `reviews (targetId, visible, rating)` e `sessions (providerId,
responseMinutes)`, ambos em `firestore.indexes.json`. A documentação de
agregação do Firestore diz o contrário, e o emulador não cobra índice
nenhum, então os testes passaram. O erro só apareceu no primeiro
`db:rebuild-stats` em produção, em 18/11/2026, com `FAILED_PRECONDITION:
The query requires an index`. Até os índices ficarem prontos, os dois
triggers também falham.

`refreshUserStats` compara com o que já está no perfil e só grava se mudou.
Gravar em `users/{uid}` dispara a sync dos `searchCards`, que copiam nota e
taxa. Por isso, uma escrita sem mudança custaria mais um trigger à toa.
`updatedAt` não muda, porque ele marca uma edição do perfil pela pessoa.

## 19.3 Quando recalcula

- **Sessão** (`sessionStatsUids`): quando o status muda para `accepted`,
  `declined`, `completed`, `cancelled` ou `no_show`, para os dois
  participantes. Isso vale para as callables e para as agendadas, como a
  `autoCompleteSessions`. Escritas que não mudam o status, como a
  `reviewedBy`, não disparam o recálculo.
- **Avaliação** (`reviewStatsUid`): quando `visible` muda, ou seja, quando a
  avaliação é revelada pela `submitReview` ou pela `revealBlindReviews`, ou
  quando uma avaliação visível é apagada. A avaliação cega recém-criada não
  dispara o recálculo.

O cálculo usa dois campos novos na sessão, gravados pelas transições
(tarefa 30):

- `responseMinutes`: minutos entre o pedido e o aceite ou a recusa;
- `cancellation.fromStatus`: o status de onde a sessão foi cancelada.

Sessões canceladas antes desse campo existir não têm `fromStatus` e não
pesam na taxa.

## 19.4 Limitações conhecidas

- **Corrida entre dois recálculos da mesma pessoa.** Dois eventos quase
  simultâneos podem gravar fora de ordem, e o número antigo vence. O
  próximo evento corrige. Se isso incomodar, dá para fazer as agregações
  dentro de uma transaction.
- **`listings.ownerSnapshot.ratingAvg`** só é atualizado quando o anúncio é
  salvo, e não acompanha as stats. O app não lê esse campo hoje (ver
  `debitos_tecnicos.md` no app).

## 19.5 Testes

`test/stats.test.ts` (8 testes):

- Quando recalcular: os status que contam e os que não contam, para os dois
  participantes; avaliação cega, revelada, criada já visível e apagada.
- `computeStats`: sem histórico; média só das visíveis e só das recebidas;
  taxa com cancelamento depois do aceite, pedido cancelado (não pesa),
  ausência e os dois papéis; taxa 0 sem nenhuma sessão concluída; tempo de
  resposta só dos pedidos respondidos.
- `refreshUserStats`: grava só quando muda e ignora usuário inexistente.

Em `test/sessions.test.ts`, as transições gravam `responseMinutes` ao aceitar
e ao recusar, e `cancellation.fromStatus` ao cancelar.
