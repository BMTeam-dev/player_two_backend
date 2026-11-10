# 3. Regras de segurança

[← Índice](DOCs.md)

São três arquivos, um por serviço. As regras são a **única barreira** entre o
cliente e os dados: o app não passa por servidor nenhum.

> **Lembrete:** Cloud Functions e scripts usam o Admin SDK e **ignoram todas
> estas regras**. As regras valem só para o app (cliente).

---

## 3.1 `firestore.rules`

### Decisões no cabeçalho do arquivo

1. **Cliente lê direto, só escreve no que é dele.** Por isso quase todo
   `allow write` é `false`.
2. **Banimento não é checado nas regras.** Checar `users/{uid}.status` em
   cada requisição custaria um `get()` extra por leitura. Quem corta o
   contato na hora é a Function de moderação (tarefa 32), que:
   - desabilita a conta no Auth e revoga os tokens;
   - tranca as conversas (`lockedAt`);
   - esconde os cartões (`visible: false`).

   Atenção: as regras **não** checam revogação de token, então um ID token
   já emitido continua passando em `signedIn()` por até 1 hora. É por isso
   que trancar conversas e esconder cartões é obrigatório.

### Funções auxiliares

| Função | O que valida |
|---|---|
| `signedIn()` | Há usuário autenticado |
| `isUser(uid)` | É o próprio dono do documento |
| `incoming()` | Atalho para `request.resource.data` (o documento depois da escrita) |
| `changedKeys()` | Campos que mudaram em relação ao documento atual |
| `isStr(v, min, max)` | String com tamanho entre `min` e `max` |
| `isOptStr(v, max)` | `null` ou string até `max` |
| `isListIn(v, allowed, max)` | Lista com até `max` itens, todos dentro de `allowed` |
| `platforms()`, `languages()`, `objectives()`, `playstyles()` | Os enums de `types.ts`, repetidos aqui |
| `isOwnAvatarUrl(v, uid)` | `null` ou URL do **próprio** Storage em `avatars/{uid}/...` |
| `validAvailability(a)` | Formato e prazos da disponibilidade (ver abaixo) |

> Os enums das regras precisam acompanhar `types.ts`. Um valor novo no enum
> sem atualizar a regra faz o app receber `permission-denied`.

### `isOwnAvatarUrl`: por que existe

Sem ela, o cliente poderia gravar em `avatarUrl` qualquer URL externa, o que
contornaria:

- o limite de tipo e tamanho do `storage.rules`;
- a moderação de imagem.

A regex exige `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/avatars%2F<uid>%2F...`.

### `validAvailability`: passo a passo

O cliente grava a disponibilidade **direto**, sem callable. Sem limites, um
"agora" com `expiresAt` daqui a um ano ficaria no topo da busca para sempre.
A validação:

1. O objeto tem **exatamente** as chaves `state`, `gameIds`, `windowStart`,
   `windowEnd`, `expiresAt` e `note` (`hasOnly` + `hasAll`).
2. `gameIds` é uma lista com até 10 itens, e `note` é `null` ou tem até 120 caracteres.
3. Conforme o `state`:

| `state` | `expiresAt` | `windowStart` / `windowEnd` |
|---|---|---|
| `offline` | `null` | `null` / `null` |
| `now` | timestamp ≤ agora + **125 min** | `null` / `null` |
| `today` | timestamp ≤ agora + **24 h** | `null` / `null` |
| `window` | **igual a** `windowEnd` | timestamps, `start < end`, `end` ≤ agora + **7 dias** |

Os 125 min espelham `config/app.availabilityNowTtlMinutes` (120) mais 5 de
folga para diferença de relógio. O valor fica fixo na regra porque ler
`config/app` custaria um `get()` por escrita.

### Regras por coleção

#### `config/{docId}`
- **Leitura: todos, inclusive sem login.** O app checa `minAppVersion` antes do login.
- Escrita: ninguém (só admin).

#### `games/{gameId}`
- Leitura: autenticados. Escrita: ninguém.

#### `usernames/{username}`
- Leitura: autenticados, para o app consultar se um username está livre.
- Escrita: ninguém. A reserva é feita pela `completeOnboarding`, em transação.

#### `users/{uid}`
- **Leitura:** qualquer autenticado (perfil público).
- **Criação e exclusão:** ninguém. A criação é pela `completeOnboarding`; a exclusão, pela Function da tarefa 33.
- **Atualização:** só o dono, e só se:
  1. os campos alterados estão em `displayName`, `avatarUrl`, `bio`,
     `region`, `languages`, `platforms`, `hasMic`, `playstyles` e
     `availability`. Espelha `USER_EDITABLE_FIELDS`. Fica de fora tudo que é
     do servidor: `username`, `gameIds`, `stats`, `status`,
     `companionStatus`, `isOnline`, `updatedAt`...;
  2. `displayName` tem de 2 a 30 caracteres;
  3. `avatarUrl` é do próprio Storage;
  4. `bio` tem até 300 caracteres e `region`, até 2;
  5. há **ao menos 1** idioma (máx. 3) e **ao menos 1** plataforma (máx. 5).
     São filtros da busca: um perfil sem nenhum sumiria de qualquer
     combinação de filtros;
  6. `hasMic` é booleano e `playstyles` tem até 6, dentro do enum;
  7. `availability` passa em `validAvailability`.

  Como a regra valida o **documento resultante** inteiro, mesmo um update que
  mude só `bio` precisa deixar os outros campos válidos.

#### `users/{uid}/private/{docId}`
- Leitura: só o dono.
- Criação e exclusão: ninguém.
- Atualização: só o dono, só em `fcmTokens` (lista com até 10) e `notificationPrefs` (map).

#### `users/{uid}/games/{gameId}`
- Leitura: autenticados (o perfil público mostra os jogos).
- Exclusão: o dono.
- Criação e atualização: o dono, e só se:
  - as chaves estão em `gameId`, `rankId`, `rankOrder`, `roles`, `objectives`, `platforms`, `isMain`, `inGameNick` e `updatedAt`;
  - `gameId` é igual ao ID do documento e **o jogo existe em `games/`** (custa um `exists()`);
  - `rankId` tem de 1 a 40 caracteres, `rankOrder` é inteiro e `roles` tem até 5;
  - `objectives` e `platforms` estão dentro dos enums;
  - `isMain` é booleano e `inGameNick` é opcional, com até 40;
  - `updatedAt == request.time` (o cliente usa `serverTimestamp()`).

  `rankOrder` só tem o **tipo** checado aqui. O valor real vem do catálogo
  quando a Function monta o cartão de busca, então um valor adulterado nunca
  chega à busca.

#### `users/{uid}/blocks/{targetUid}`
- Leitura: só o dono. Escrita: ninguém (Function `blockUser`, tarefa 31).

#### `searchCards/{cardId}`
- Leitura: autenticados, **só se `visible == true`**.
- Escrita: ninguém.
- Consequência importante: regras **não filtram resultados**. Uma consulta
  de lista que não tenha `where('visible', '==', true)` é **recusada
  inteira**. O app sempre inclui esse filtro.

#### `listings/{listingId}`
- Leitura: autenticados. Escrita: ninguém (`upsertListing`/`deactivateListing`, tarefa 21).

#### `lfgPosts/{postId}` e `members/{memberUid}`
- v0.1, mas já protegidos: leitura por autenticados, escrita por ninguém.

#### `sessions/{sessionId}`
- Leitura: só quem está em `participantIds`.
- Escrita: ninguém. Toda transição de status é por callable (tarefa 22).
- `events/{eventId}`: leitura só por participantes, via `get()` da sessão (custa uma leitura extra).

#### `conversations/{conversationId}`
- Leitura: só participantes.
- Criação e exclusão: ninguém (a Function cria junto com a sessão).
- **Única escrita do cliente:** zerar o **próprio** contador ao abrir o
  chat. Só a chave `unread` pode mudar, dentro dela só a entrada do próprio
  uid, e o novo valor precisa ser `0`. O incremento é do trigger de Message.
  Sem essa exceção, marcar como lida exigiria uma callable a cada abertura.

#### `conversations/{id}/messages/{messageId}`
- Leitura: participantes (via `get()` da conversa).
- **Criação pelo cliente**, só se:
  - quem envia é participante e a conversa **não está trancada** (`lockedAt == null`);
  - as chaves são exatamente as de `Message`, e `id` é igual ao ID do documento;
  - `senderId` é o próprio uid e `type == 'text'`, com 1 a 1000 caracteres;
  - `systemEvent == null` e `flagged == false`. Mensagens de sistema e a marcação de palavrões são das Functions;
  - `createdAt == request.time`.
- Edição e exclusão: **nunca**. O histórico é evidência em denúncias.

#### `reviews/{reviewId}`
- Leitura: autenticados, se `visible == true`, **ou** o próprio autor (vê a avaliação antes da revelação).
- Escrita: ninguém (tarefa 29). Avaliação **cega**: fica invisível até os dois lados avaliarem ou o prazo vencer.
- Na consulta de lista, vale a mesma regra de `searchCards`: precisa de `where('visible', '==', true)`.

#### `reports/{reportId}` e `moderationActions/{actionId}`
- Nenhum acesso do cliente. Denúncias entram pela callable `submitReport`
  (tarefa 31), que aplica o limite diário, confere a evidência e calcula a
  prioridade. Denúncia em massa é um vetor de assédio, por isso nada aqui é
  escrito direto.

---

## 3.2 `storage.rules`

Na v0, o Storage só guarda avatares.

| Caminho | Leitura | Escrita |
|---|---|---|
| `avatars/{uid}/{fileName}` | autenticados | **criação/atualização:** só o dono, `image/jpeg`, `png` ou `webp`, **menor que 2 MB**. **Exclusão:** só o dono |
| qualquer outro | ninguém | ninguém |

O app grava sempre no mesmo nome (`avatars/{uid}/avatar`), então trocar a
foto sobrescreve o arquivo em vez de acumular arquivos. A moderação de imagem
é manual na v0; o Cloud Vision entra na v0.1.

---

## 3.3 `database.rules.json` (Realtime Database)

```json
"status": { "$uid": {
  ".read":  "auth.uid === $uid",
  ".write": "auth.uid === $uid",
  ".validate": "newData.hasChildren(['state', 'lastChanged'])",
  "state":       { ".validate": "'online' | 'offline'" },
  "lastChanged": { ".validate": "isNumber() && <= now" },
  "$other":      { ".validate": false }
}}
```

- A raiz é fechada (`.read`/`.write: false`).
- Cada pessoa lê e escreve **só** `status/{seu uid}`. Ninguém lê a presença
  dos outros no RTDB: para os outros, a presença aparece pelo Firestore
  (`users.isOnline`), espelhada pela Function.
- `lastChanged <= now` impede datas no futuro. Uma data futura faria a
  Function descartar todos os eventos seguintes como "fora de ordem" (ver
  [doc 7](07-function-onPresenceWritten.md)).
- `$other: false` bloqueia campos extras.
