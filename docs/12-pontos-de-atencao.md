# 12. Pontos de atenção

[← Índice](DOCs.md)

Achados da leitura do código no commit `3d7b6da` (o mesmo código da `main` em `6e743bc`). Nenhum é um bug que quebra
o app hoje. São riscos, custos ou inconsistências para resolver ou aceitar
conscientemente.

## 12.1 Custo da sync de `searchCards` com a presença

**O quê:** `onPresenceWritten` escreve `isOnline`/`lastSeenAt` em
`users/{uid}`, e isso dispara `onUserWrittenSyncCards`. A sync relê o
usuário, os cartões, os jogos, os anúncios e o catálogo a cada vez que o app
vai para o primeiro ou o segundo plano.

**Ordem de grandeza:** com 2 jogos, são cerca de 6 a 8 leituras por mudança
de presença (usuário, cartões, jogos, anúncios e catálogo), mais 1 escrita
por cartão, porque o `isOnline` muda de fato.

**Opções:**

- aceitar no beta e medir pelo `PRECOS.md`;
- no trigger de `users`, comparar `before`/`after` e sair cedo quando só
  mudaram campos que não vão para o cartão;
- tirar `isOnline` do cartão e mostrar a presença por outra via.

## 12.2 `seed-dev` grava `searchCards` direto

O comentário do próprio script diz que essa parte "pode ser removida" quando
o trigger existir, e o trigger já existe. Hoje:

- com o emulador de Functions rodando, os triggers recalculam os mesmos
  cartões logo depois do seed. É trabalho dobrado, e a lógica do seed (cópia
  manual de `buildCard`) pode divergir da real. Todo campo novo do cartão
  precisa ser repetido à mão nos dois lugares.

**Sugestão:** remover a escrita de `searchCards` do seed e deixar os
triggers gerarem (ou chamar `syncUserCards` no fim, como o
`rebuild-search-cards`).

## 12.3 Catálogo sem trigger

Mudanças em `games/*` não atualizam os cartões. É preciso lembrar de rodar
`npm run db:rebuild-cards`. Quem tinha um rank renomeado ou removido some da
busca sem aviso até escolher outro rank.

**Sugestão:** documentar o passo no fluxo de mudança de catálogo (já está no
[doc 9](09-scripts.md)) ou criar um trigger em `games/{gameId}`.

## 12.4 Adaptadores sem teste

Os testes cobrem a lógica pura, mas não os adaptadores (ver
[doc 10](10-testes.md#104-o-que-não-é-testado)). Erros como ler o parâmetro
errado de `event.params` ou inverter `before`/`after` só aparecem no
emulador completo ou em produção.

**Sugestão:** um teste de fumaça com `firebase-functions-test`, ou um roteiro
manual no emulador antes de cada deploy.

## 12.5 Regras de Storage e RTDB sem teste

Só o `firestore.rules` tem testes. `storage.rules` (tipo e tamanho do
avatar) e `database.rules.json` (`lastChanged <= now`, que protege o
`mirrorPresence`) dependem de revisão manual.

## 12.6 `expireAvailability` e escritas concorrentes

A pré-condição `lastUpdateTime` faz a expiração ser pulada se **qualquer**
campo do usuário mudou entre a leitura e a escrita. Isso inclui a presença e
o `gameIds` da sync. A expiração fica para a execução seguinte (+10 min).

É raro e o efeito é só atraso, mas soma com o atraso normal de até 10 min.

## 12.7 Enums duplicados em três lugares

`types.ts` (backend), a cópia no app e as funções `platforms()`,
`languages()` etc. no `firestore.rules`. Um valor novo esquecido nas regras
faz o app receber `permission-denied`.

**Sugestão:** um teste que lê o `firestore.rules` e compara as listas com os
arrays de `types.ts`.

## 12.8 README desatualizado

A tabela do `README.md` descreve `test/` como "Testes das regras contra o
emulador". Hoje a pasta também testa a lógica das Functions.

## 12.9 Ambiente único

Não há projeto de staging. Todo `deploy` vai para os usuários do beta, e a
única barreira é `npm test` (ver [doc 11](11-operacao-e-deploy.md)). Um
projeto `mynoobpro-staging` passa a valer a pena quando entrarem as Functions
de sessão (tarefa 22), que mexem em dados de duas pessoas.

## 12.10 O que vem depois

Já há tipos, regras e índices, mas ainda não há Function para:

| Tarefa | Function prevista | Prepara |
|---|---|---|
| 21 | `upsertListing` | `listings`, limite `maxActiveListingsPerUser` |
| 22–23 | ciclo de sessões (pedido, aceite, expiração, conclusão) | `sessions`, `events`, índices de `status` |
| 25 | mensagens de sistema e rate limit do chat | `conversations`, `messages` |
| 29 | avaliações | `reviews`, `stats` do usuário |
| 31 | `submitReport`, `blockUser` | `reports`, `blocks` |
| 32 | moderação (banimento) | desabilitar a conta, trancar conversas, esconder cartões |

Para cada uma, siga o checklist do [doc 13](13-do-codigo-ao-firebase.md#1310-checklist-para-uma-function-nova).
