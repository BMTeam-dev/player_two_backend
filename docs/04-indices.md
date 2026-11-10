# 4. Índices

[← Índice](DOCs.md)

O Firestore cria sozinho um índice para **cada campo isolado**. Uma consulta
que filtra ou ordena por **mais de um campo** precisa de um **índice
composto**, declarado em `firestore.indexes.json`. Sem ele, a consulta falha
com `FAILED_PRECONDITION` e um link para criar o índice no Console.

> **Regra do projeto:** todo índice novo entra no `firestore.indexes.json`,
> nunca só pelo link do Console. Assim ele fica versionado e é publicado com
> `npm run db:deploy`.

## 4.1 Como ler um índice

```json
{ "collectionGroup": "searchCards", "fields": [
  { "fieldPath": "gameId", "order": "ASCENDING" },
  { "fieldPath": "visible", "order": "ASCENDING" },
  { "fieldPath": "availabilityRank", "order": "DESCENDING" },
  { "fieldPath": "ratingAvg", "order": "DESCENDING" } ] }
```

- Os **filtros de igualdade** (`==`, `array-contains`) vêm primeiro, em
  qualquer ordem entre si.
- Depois vêm os campos de **ordenação** (`orderBy`) ou de desigualdade
  (`<`, `<=`…), **na mesma ordem e direção** da consulta.
- `arrayConfig: "CONTAINS"` serve para filtros `array-contains` (ex:
  `participantIds`).

## 4.2 `searchCards`: a tela Explorar

Toda consulta de busca filtra `gameId == X` e `visible == true` e ordena por
disponibilidade e depois por nota.

O filtro `visible == true` **é obrigatório**. A regra só libera a leitura de
cartões visíveis, e regras não filtram resultados: uma consulta sem esse
filtro é recusada inteira (ver [doc 3](03-regras-de-seguranca.md)).

| # | Igualdade | Ordenação | Consulta que atende |
|---|---|---|---|
| 1 | `gameId`, `visible` | `availabilityRank ↓`, `ratingAvg ↓` | Explorar sem filtro extra |
| 2 | `gameId`, `visible`, `isCompanion` | `availabilityRank ↓`, `ratingAvg ↓` | Filtro "só companions" |
| 3 | `gameId`, `visible`, `availabilityState` | `availabilityRank ↓`, `ratingAvg ↓` | Filtro por estado ("agora", "hoje"…) |
| 4 | `gameId`, `visible` | `availabilityRank ↓`, `ratingAvg ↓`, `rankOrder ↑` | Desempate por rank |

Exemplo de consulta (app):

```ts
query(collection(db, 'searchCards'),
  where('gameId', '==', 'valorant'),
  where('visible', '==', true),
  orderBy('availabilityRank', 'desc'),
  orderBy('ratingAvg', 'desc'),
  limit(20));
```

`availabilityRank` (`now: 3`, `today: 2`, `window: 1`, `offline: 0`) existe
só para essa ordenação. O Firestore não ordena por um enum de texto na ordem
que o produto quer. O peso fino da relevância (`config/app.searchWeights`) é
aplicado **no app**, sobre a página que veio do Firestore.

Os filtros que não estão no índice (idioma, plataforma, microfone, papel…)
também são aplicados no app, sobre a página retornada. Se algum deles virar
filtro no servidor, ele precisa de um índice novo.

## 4.3 `listings`

| Igualdade | Ordenação | Consulta |
|---|---|---|
| `ownerId`, `active` | `createdAt ↓` | "Meus anúncios ativos", do mais novo ao mais antigo |

A consulta do `syncUserCards` (`ownerId == uid` e `active == true`, sem
`orderBy`) **não** precisa deste índice. O Firestore resolve filtros só de
igualdade combinando os índices de campo único.

## 4.4 `sessions` (tarefas 22 e 23, ainda sem Function)

| Igualdade / contém | Ordenação ou intervalo | Consulta prevista |
|---|---|---|
| `participantIds` contém | `scheduledStart ↓` | Histórico de sessões da pessoa |
| `participantIds` contém, `status` | `scheduledStart ↓` | Sessões da pessoa num estado (ex: pendentes) |
| `status` | `requestExpiresAt ↑` | Job que expira pedidos não respondidos |
| `status` | `scheduledStart ↑` | Job de lembretes / início de sessão |
| `status` | `scheduledEnd ↑` | Job que passa sessões para "aguardando confirmação" |
| `status` | `endedAt ↑` | Job de conclusão automática (`autoCompleteAfterHours`) |

## 4.5 `conversations`, `reviews`, `reports`

| Coleção | Igualdade / contém | Ordenação | Consulta prevista |
|---|---|---|---|
| `conversations` | `participantIds` contém | `lastMessage.at ↓` | Lista de conversas, a mais recente primeiro |
| `reviews` | `targetId`, `visible` | `createdAt ↓` | Avaliações visíveis no perfil de alguém |
| `reviews` | `visible` | `createdAt ↑` | Job que publica avaliações (janela dupla-cega) |
| `reports` | `status` | `priority ↓`, `createdAt ↑` | Fila de moderação |

## 4.6 Consultas das Functions de hoje

| Function | Consulta | Índice |
|---|---|---|
| `expireAvailability` | `users` onde `availability.expiresAt <= now` | campo único (automático) |
| `syncUserCards` | `searchCards` onde `uid == X` | campo único |
| `syncUserCards` | `listings` onde `ownerId == X` e `active == true` | combinação de campos únicos |

## 4.7 Publicar

```bash
npm run db:deploy    # regras + índices de Firestore, RTDB e Storage
```

Um índice novo leva de alguns segundos a minutos para ficar pronto (status
"Building" no Console). **Publique os índices antes da versão do app que usa
a consulta.**

O deploy **não apaga** índices que existem no projeto e sumiram do arquivo.
Ele avisa e pergunta. Para conferir a diferença:
`npx firebase firestore:indexes`.
