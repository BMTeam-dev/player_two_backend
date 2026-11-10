# 10. Testes

[← Índice](DOCs.md)

## 10.1 Como rodam

```bash
npm test          # firebase emulators:exec --project demo-mynoobpro --only firestore "vitest run"
npm run typecheck # tsc da raiz (scripts/, test/) + tsc das Functions
```

1. O `emulators:exec` sobe **só o emulador do Firestore**, roda o vitest e
   derruba o emulador no fim.
2. O projeto é **`demo-mynoobpro`**. Projetos com prefixo `demo-` nunca
   acessam serviços reais, mesmo com credencial na máquina.
3. `vitest.config.ts` roda os arquivos **em série** (`fileParallelism:
   false`). Todos compartilham o mesmo emulador, e um teste que limpa as
   coleções não pode apagar os dados de outro no meio. O timeout é de 20 s
   por teste.

Pré-requisito: **Java 21+** (os emuladores rodam na JVM).

## 10.2 Dois tipos de teste

### Regras (`test/firestore.rules.test.ts`)

Usa `@firebase/rules-unit-testing` e o SDK **web** (`firebase/firestore`),
exatamente como o app. Cada teste age como um usuário (`alice`, `bob`,
`carol` ou sem login) e verifica com `assertSucceeds` ou `assertFails`.

Cobre os pontos onde um erro custa caro: vazamento de dados de outra pessoa e
cliente escrevendo campo de servidor.

| Bloco | O que garante |
|---|---|
| `config` | qualquer um lê `config/app`; ninguém escreve |
| `users` | sem login não lê; logado lê os outros; dono edita só campos editáveis e dentro dos limites; não remove todos os idiomas ou plataformas; não altera `username`, `gameIds`, `profileCompletedAt`, `stats`, `status` nem `companionStatus`; avatar só do próprio caminho; disponibilidade com prazo coerente e sem "agora" eterno; ninguém edita perfil alheio; cliente não cria perfil; `private` só o dono lê |
| `users/{uid}/games` | só jogo do catálogo; troca de jogo principal em batch; `updatedAt` precisa ser o horário do servidor; só o dono remove |
| `searchCards` | lê cartão visível e não lê oculto; cliente não escreve |
| `sessions` | só participantes leem; ninguém altera status direto |
| `messages` | participante envia a própria mensagem; não envia em nome de outro, nem em conversa trancada, nem mensagem de sistema; não-participante não lê; zera só o próprio `unread` |
| `reports` | cliente não cria nem lê |

### Lógica das Functions

Usam o **Admin SDK** da raiz e importam a **lógica pura** de
`functions/src/` (não o adaptador). Cada arquivo cria o próprio app com nome
único (ex: `initializeApp({ projectId: 'demo-mynoobpro' }, 'search-cards-test')`),
limpa as coleções no `beforeEach` e passa um `NOW` fixo.

| Arquivo | Lógica testada | Doc |
|---|---|---|
| `completeOnboarding.test.ts` | `ageOn`, `parseOnboardingInput`, `createProfile` | [5](05-function-completeOnboarding.md#56-testes) |
| `expireAvailability.test.ts` | `expireAvailabilities` | [6](06-function-expireAvailability.md#66-testes) |
| `mirrorPresence.test.ts` | `mirrorPresence` | [7](07-function-onPresenceWritten.md#75-testes) |
| `searchCards.test.ts` | `syncUserCards` | [8](08-functions-searchCards.md#86-testes) |
| `listings.test.ts` | `parseListingInput`, `saveListing`, `deactivateListing` | [14](14-functions-listings.md#145-testes) |
| `sessions.test.ts` | `parseRequestInput`, `requestExpiresAtMs`, `createSessionRequest`, `parseTransitionInput`, `transitionSession` | [15](15-functions-sessions.md#157-testes) |
| `scheduledSessions.test.ts` | `expireSessionRequests`, `autoAdvanceSessions`, `autoCompleteSessions` | [15](15-functions-sessions.md#157-testes) |

## 10.3 Por que a lógica recebe `db` e `now`

Os testes usam o `firebase-admin` da **raiz**, e as Functions usam o de
`functions/node_modules`. Um `Timestamp` criado por uma cópia do pacote é
recusado pelo serializador da outra. Por isso a lógica:

- recebe `db` e `now` como parâmetros;
- grava `Date` em vez de `Timestamp.fromMillis(...)`.

Um `now` fixo também deixa os testes determinísticos (ex: o aniversário na
véspera em `ageOn`).

## 10.4 O que não é testado

- **Os adaptadores** (`onCall`, `onSchedule`, `onDocumentWritten`,
  `onValueWritten`): `request.auth`, a leitura de `event.params` e o
  `before`/`after` do trigger de listings. Eles são curtos, mas um erro neles
  só aparece no emulador completo ou em produção.
- **`storage.rules` e `database.rules.json`**: não têm teste automatizado.
- **Os scripts.**

Para validar os adaptadores, use `npm run emulators` e exercite o fluxo pela
UI do emulador ou pelo app (ver [doc 11](11-operacao-e-deploy.md)).

## 10.5 Escrevendo um teste novo

1. Crie `test/<nome>.test.ts`.
2. Para lógica de Function: `initializeApp({ projectId: 'demo-mynoobpro' }, '<nome-unico>')`,
   `deleteApp` no `afterAll`, `recursiveDelete` das coleções usadas no
   `beforeEach`.
3. Para regras: siga o `firestore.rules.test.ts`, com `initializeTestEnvironment`
   lendo o `firestore.rules` e `withSecurityRulesDisabled` para preparar dados.
4. Use um `NOW` fixo, nunca `Date.now()`.
