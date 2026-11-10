# 8. Functions de `searchCards`

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | 3 triggers do Firestore (`onDocumentWritten`) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/search/syncSearchCards.ts` (adaptadores), `functions/src/search/cards.ts` (lógica) |
| Testes | `test/searchCards.test.ts` |
| Escreve | `searchCards/{uid}_{gameId}` e `users/{uid}.gameIds` |
| Estado | publicadas em 10/11/2026 |

## 8.1 Para que servem

A tela Explorar precisa de dados do perfil (`User`), do jogo do perfil
(`PlayerGame`), do catálogo (`Game`) e do anúncio (`Listing`). Juntar isso no
cliente custaria várias consultas por resultado.

A solução é uma **cópia desnormalizada**: um documento em `searchCards` por
par (jogador, jogo), com tudo o que a busca filtra e mostra. O Explorar faz
**uma** consulta indexada (ver [doc 4](04-indices.md)). Só as Functions
escrevem nessa coleção.

## 8.2 Os três triggers

```ts
onUserWrittenSyncCards        → 'users/{uid}'
onPlayerGameWrittenSyncCards  → 'users/{uid}/games/{gameId}'
onListingWrittenSyncCards     → 'listings/{listingId}'
```

Os três chamam a **mesma** função, `syncUserCards(db, uid, now)`, que
recalcula **todos** os cartões do usuário do zero.

Essa escolha custa mais leituras que um update pontual, mas evita que um
cartão fique diferente da origem por um caso esquecido.

O trigger de `listings` pega o `ownerId` de `before` e de `after`. Se um
anúncio trocar de dono (não deveria acontecer), os dois donos são
sincronizados.

## 8.3 Passo a passo (`syncUserCards`)

Tudo numa **transação**. Se dois triggers do mesmo usuário rodam juntos (ex:
editar um jogo e a presença mudar), eles leem e escrevem em série, e o
último nunca grava um cartão montado com dados velhos.

1. **Lê** em paralelo:
   - `users/{uid}`;
   - os cartões atuais (`searchCards` onde `uid == uid`);
   - `users/{uid}/games/*`;
   - os anúncios ativos (`listings` onde `ownerId == uid` e `active == true`).
2. Se o usuário existe:
   - lê no catálogo os `games/{gameId}` de cada jogo do perfil (`tx.getAll`);
   - para cada jogo do perfil, ignora jogos que não estão mais no catálogo,
     escolhe o anúncio ativo **mais recente** daquele jogo e chama
     `buildCard`;
   - calcula `gameIds` com o jogo principal (`isMain`) primeiro.
3. **Compara** cada cartão novo com o atual usando `sameCard`, que ignora
   `updatedAt` e normaliza Timestamp/Date e a ordem das chaves:
   - cartão diferente ou novo → `set`;
   - cartão atual sem correspondente → `delete` (jogo removido, ou usuário
     apagado);
   - `gameIds` diferente → `update` em `users/{uid}`.
4. Retorna `{ written, deleted, gameIdsChanged }`. O adaptador registra no
   log (`debug`) só quando algo mudou.

### `buildCard`: como cada campo é montado

| Campo | Origem / regra |
|---|---|
| `rankId`, `rankOrder` | `rankOrder` vem de `games/{gameId}.ranks`, **nunca** do `PlayerGame` (o cliente poderia adulterar). Se o `rankId` não existe mais no catálogo, `buildCard` retorna `null` e o jogo fica sem cartão |
| `availabilityState` | o estado do usuário **só se** o jogo está em `availability.gameIds`; senão `'offline'`. Quem está "agora" só no Valorant aparece offline na busca de LoL |
| `availabilityRank` | `now: 3`, `today: 2`, `window: 1`, `offline: 0` |
| `availabilityExpiresAt`, `availabilityWindowStart`, `availabilityWindowEnd` | copiados só quando o jogo está na disponibilidade; senão `null` |
| `isCompanion` | `companionStatus == 'approved'` |
| `listingId`, `category`, `priceCents` | do anúncio ativo do jogo, ou `null`/`null`/`0` |
| `visible` | `status == 'active'` **e** `profileCompletedAt != null`. Suspensos e banidos somem da busca |
| demais | cópia direta de `User` e `PlayerGame` (ver [doc 2](02-modelo-de-dados.md)) |

## 8.4 Por que não entra em loop

`onUserWrittenSyncCards` reage a **qualquer** escrita em `users/{uid}`,
inclusive à escrita de `gameIds` feita pela própria sync. O ciclo é:

1. A pessoa edita o perfil e o trigger roda. Cartões e `gameIds` são gravados.
2. A escrita de `gameIds` dispara o trigger de novo, que recalcula, encontra
   tudo igual e **não escreve nada**. Fim.

O mesmo vale para as escritas de `onPresenceWritten` e `expireAvailability`:
elas mudam o usuário, o trigger roda e atualiza só o que mudou.

**A idempotência é obrigatória.** Se um campo novo do cartão não for estável
(ex: um `Date.now()` dentro do cartão que não seja ignorado pelo
`normalize`), o trigger entra em loop infinito. O `maxInstances: 10` limita o
custo, mas não para o loop.

## 8.5 O que **não** dispara a sync

- **Mudanças no catálogo** (`games/*`): não há trigger. Depois de mudar
  ranks (ex: ordem ou ids), rode `npm run db:rebuild-cards` (ver
  [doc 9](09-scripts.md)).
- **Usuários que já existiam antes dos triggers**: precisam do mesmo script
  uma vez, depois do deploy.

## 8.6 Testes

`test/searchCards.test.ts`:

- cria um cartão por jogo, com `rankOrder` do catálogo e `gameIds` com o
  principal primeiro;
- disponibilidade vale só nos jogos escolhidos;
- janela de horário vai para o cartão só nos jogos escolhidos;
- não escreve nada quando nada mudou (garantia contra loop);
- reescreve só o cartão que mudou e apaga o do jogo removido;
- suspenso ou banido fica invisível;
- rank que não existe mais no catálogo tira o cartão da busca;
- copia o anúncio ativo do jogo;
- usuário apagado perde todos os cartões.
