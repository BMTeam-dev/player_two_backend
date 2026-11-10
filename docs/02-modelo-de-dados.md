# 2. Modelo de dados

[← Índice](DOCs.md)

A fonte de verdade é o `MODELO_DE_DADOS.md`, no repo do app. Este documento
descreve como o modelo aparece **no código** do backend.

## 2.1 `functions/src/types.ts`

Arquivo único com todos os enums e interfaces. Três detalhes importam:

1. **O app mantém uma cópia** em `player-2/src/shared/types.ts`. A ordem é
   sempre: muda aqui primeiro, depois copia para o app. As duas cópias
   precisam ficar idênticas. Uma forma de conferir é um `diff` dos blocos.
2. **`TimestampLike` é estrutural** (`seconds`, `nanoseconds`, `toDate()`). Os
   Timestamps do `firebase-admin` e do `@react-native-firebase/firestore`
   satisfazem essa interface, então o mesmo arquivo serve nos dois lados sem
   importar nenhum SDK.
3. **Os enums são `const` arrays** (`PLATFORMS`, `LANGUAGES`...), com o tipo
   derivado deles. Assim a mesma lista serve para tipar e para validar em
   tempo de execução (ex.: `isSubsetOf(raw.languages, LANGUAGES, 1, 3)` no
   onboarding).

### Enums

| Enum | Valores |
|---|---|
| `Platform` | `pc`, `playstation`, `xbox`, `switch`, `mobile` |
| `Language` | `pt`, `en`, `es` |
| `Objective` | `casual`, `ranked`, `coop`, `party`, `coaching`, `companion` |
| `Category` | `play_together`, `companion`, `coaching` |
| `Playstyle` | `chill`, `tryhard`, `teaching`, `funny`, `strategic`, `silent` |
| `AvailabilityState` | `now`, `today`, `window`, `offline` |
| `CompanionStatus` | `none`, `pending`, `approved`, `suspended` |
| `UserStatus` | `active`, `suspended`, `banned` |
| `SessionStatus` | `requested`, `declined`, `expired`, `accepted`, `in_progress`, `awaiting_confirmation`, `completed`, `cancelled`, `no_show` |
| `ReviewTag` | `friendly`, `skilled`, `good_teacher`, `punctual`, `good_comms`, `toxic`, `no_show`, `late` |
| `ReportReason` | `harassment`, `hate_speech`, `sexual_content`, `fraud`, `boosting_or_account_sharing`, `cheating`, `toxicity`, `spam`, `underage`, `other` |

Constante derivada: `AVAILABILITY_RANK = { now: 3, today: 2, window: 1, offline: 0 }`,
usada para ordenar a busca.

## 2.2 Coleções

```text
Firestore
├── config/app ............................ AppConfig          (admin)
├── games/{gameId} ........................ Game               (admin)
├── usernames/{username} .................. Username           (Function)
├── users/{uid} ........................... User               (cliente* + Function)
│   ├── private/data ...................... UserPrivate        (Function + cliente*)
│   ├── games/{gameId} .................... PlayerGame         (cliente*)
│   └── blocks/{targetUid} ................ Block              (Function - tarefa 31)
├── searchCards/{uid}_{gameId} ............ SearchCard         (Function)
├── listings/{listingId} .................. Listing            (Function - tarefa 21)
├── lfgPosts/{postId} ..................... LfgPost            (v0.1)
│   └── members/{uid} ..................... LfgMember          (v0.1)
├── sessions/{sessionId} .................. Session            (Function - tarefa 22)
│   └── events/{eventId} .................. SessionEvent       (Function)
├── conversations/{conversationId} ........ Conversation       (Function + cliente*)
│   └── messages/{messageId} .............. Message            (cliente* + Function)
├── reviews/{sessionId}_{authorUid} ....... Review             (Function - tarefa 29)
├── reports/{reportId} .................... Report             (Function - tarefa 31)
└── moderationActions/{actionId} .......... ModerationAction   (Function/admin)

Realtime Database
└── status/{uid} .......................... Presence           (cliente*)

Storage
└── avatars/{uid}/avatar .................. imagem             (cliente*)
```

`*` = o cliente escreve direto, limitado pelas regras (ver [doc 3](03-regras-de-seguranca.md)).

## 2.3 Entidades em uso hoje

As entidades abaixo já são lidas ou escritas por código publicado. As demais
(`Session`, `Conversation`, `Message`, `Review`, `Report`, `ModerationAction`,
`LfgPost`) já têm tipo e regra, mas ainda não têm Function.

### `config/app`: `AppConfig`

Configuração do produto, lida pelo app e pelas Functions.

| Campo | Valor atual | Usado por |
|---|---|---|
| `minAppVersion` | `0.0.1` | app (antes do login; por isso a regra deixa ler sem auth) |
| `activeGameIds` | `valorant`, `lol`, `cs2` | `bootstrap` valida que existem |
| `maxActiveListingsPerUser` | 3 | `upsertListing` (tarefa 21) |
| `sessionRequestTtlMinutes` | `{ now: 15, scheduled: 720 }` | tarefa 22 |
| `availabilityNowTtlMinutes` | 120 | app; a regra limita em 125 min |
| `autoCompleteAfterHours` | 24 | tarefa 23 |
| `reviewWindowDays` | 7 | tarefa 29 |
| `rateLimits` | sessões/h 20, mensagens/min 30, denúncias/dia 10 | tarefas 22, 25, 31 |
| `searchWeights` | disponibilidade 40, online 20, rank 15, nota 15, conclusão 10 | ordenação do Explorar no app |
| `termsVersion` | `2026-10-v1` | `completeOnboarding` exige aceite desta versão |
| `updatedAt` | `serverTimestamp()` do bootstrap | — |

### `games/{gameId}`: `Game`

```ts
{ id, name, iconUrl, platforms[], ranks: [{ id, label, order }], roles: [{ id, label }],
  maxPartySize, active, sortOrder }
```

`ranks[].order` é a **fonte de verdade** do `rankOrder` nos cartões de busca. O
valor que o cliente grava no `PlayerGame` é ignorado (ver [doc 8](08-functions-searchCards.md)).

### `usernames/{username}`: `Username`

`{ uid, createdAt }`. O ID do documento é o username em minúsculas. Garante
unicidade: a reserva acontece na mesma transação que cria o perfil.

### `users/{uid}`: `User` (perfil público)

| Grupo | Campos | Quem escreve |
|---|---|---|
| Identidade | `uid`, `username`, `country`, `createdAt`, `profileCompletedAt`, `emailVerified` | `completeOnboarding` |
| Editáveis | `displayName`, `avatarUrl`, `bio`, `region`, `languages`, `platforms`, `hasMic`, `playstyles`, `availability` | **cliente** (lista em `USER_EDITABLE_FIELDS` e nas regras) |
| Desnormalizados | `gameIds` (principal primeiro) | `syncUserCards` |
| Presença | `isOnline`, `lastSeenAt` | `onPresenceWritten` |
| Reputação | `stats { ratingAvg, ratingCount, sessionsCompleted, completionRate, avgResponseMinutes }` | Functions de avaliação/sessão (futuras) |
| Moderação | `status`, `companionStatus` | admin / Functions de moderação |
| Controle | `updatedAt` | Functions (o cliente não altera) |

`availability` é um objeto:

```ts
{ state: 'now'|'today'|'window'|'offline', gameIds: string[],
  windowStart, windowEnd, expiresAt: Timestamp|null, note: string|null }
```

### `users/{uid}/private/data`: `UserPrivate`

Dados que **só o dono** lê: `email`, `birthDate`, `ageConfirmedAt`,
`termsVersion`, `termsAcceptedAt`, `fcmTokens`, `notificationPrefs` e
`rateLimit`. O cliente só altera `fcmTokens` e `notificationPrefs`.

### `users/{uid}/games/{gameId}`: `PlayerGame`

```ts
{ gameId, rankId, rankOrder, roles[], objectives[], platforms[], isMain, inGameNick, updatedAt }
```

Escrito pelo cliente. `updatedAt` precisa ser exatamente `request.time` (o
cliente envia `serverTimestamp()`).

### `searchCards/{uid}_{gameId}`: `SearchCard`

Cópia desnormalizada de `User` + `PlayerGame` + `Listing`, uma por jogo do
jogador. Só a Function escreve. É o que a tela Explorar consulta: assim a
busca é **uma** consulta indexada em vez de juntar três coleções no cliente.

| Origem | Campos copiados |
|---|---|
| `User` | `uid`, `username`, `displayName`, `avatarUrl`, `languages`, `playstyles`, `hasMic`, `isOnline`, `ratingAvg`, `ratingCount`, `sessionsCompleted`, `completionRate` |
| `User.availability` (só se o jogo está em `availability.gameIds`) | `availabilityState`, `availabilityRank`, `availabilityExpiresAt`, `availabilityWindowStart`, `availabilityWindowEnd` |
| `PlayerGame` | `gameId`, `rankId`, `roles`, `objectives`, `platforms` |
| `Game.ranks` | `rankOrder` |
| `Listing` ativo do jogo | `listingId`, `category`, `priceCents` |
| Calculados | `isCompanion` (`companionStatus == 'approved'`), `visible` (`status == 'active'` e perfil completo), `updatedAt` |

### `listings/{listingId}`: `Listing`

Anúncio "Estou disponível". Ainda não há Function que crie anúncios (tarefa
21), mas o trigger `onListingWrittenSyncCards` já reage a eles e o seed cria
alguns no emulador.

### RTDB `status/{uid}`: `Presence`

`{ state: 'online'|'offline', lastChanged: number }`. `lastChanged` é em
milissegundos, gravado com `ServerValue.TIMESTAMP`.

## 2.4 Convenções

- **Datas:** sempre `Timestamp` no Firestore. No RTDB, milissegundos.
- **Dinheiro:** centavos inteiros (`priceCents`). O preço é só referência:
  o app nunca cobra.
- **IDs determinísticos** quando há unicidade: `searchCards/{uid}_{gameId}`,
  `reviews/{sessionId}_{authorUid}`, `usernames/{username}`.
- **Snapshots** (`ownerSnapshot`, `participantSnapshots`, `authorSnapshot`):
  cópias de nome e avatar no momento da escrita, para listas não precisarem
  ler `users/*`.
