# 5. Function `completeOnboarding`

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | callable (`onCall`), HTTPS |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/users/completeOnboarding.ts` (adaptador), `functions/src/users/onboarding.ts` (lógica) |
| Testes | `test/completeOnboarding.test.ts` |
| Quem chama | O app, no fim do passo "perfil" do onboarding |
| Escreve | `usernames/{username}`, `users/{uid}`, `users/{uid}/private/data` |

## 5.1 Por que é uma Function

As regras **proíbem** o cliente de criar `users/{uid}`. Três coisas não
podem ficar nas mãos do cliente:

1. **Idade mínima (18).** O cliente poderia mentir o cálculo.
2. **Username único.** Só uma transação no servidor garante que dois
   cadastros simultâneos não fiquem com o mesmo nome.
3. **Campos de servidor** (`stats`, `status`, `companionStatus`,
   `profileCompletedAt`…) nascem com valores fixos, não com o que o cliente
   mandar.

## 5.2 Chamada pelo app

```ts
const completeOnboarding = httpsCallable(functions, 'completeOnboarding');
await completeOnboarding({
  username: 'BiaClutch',
  displayName: 'Bia Clutch',
  birthDate: '2000-05-10',      // YYYY-MM-DD
  termsVersion: '2026-10-v1',   // a versão que o app leu de config/app
  languages: ['pt'],
  platforms: ['pc'],
  hasMic: true,
  playstyles: ['chill'],        // opcional
  region: 'SP',                 // opcional
});
// → { uid, username }
```

## 5.3 Passo a passo

### Adaptador (`completeOnboarding.ts`)

1. Sem `request.auth`, o adaptador lança `unauthenticated`.
2. Sem `token.email`, lança `failed-precondition`. O login é só via Google,
   então o e-mail sempre vem. Faltar e-mail indica conta criada por outro
   caminho (ex: anônima).
3. Calcula `now = Timestamp.now()`.
4. Chama `parseOnboardingInput(request.data, now.toDate())`.
5. Chama `createProfile(db, { uid, email, emailVerified }, input, now)`.

### Validação (`parseOnboardingInput`)

| Campo | Regra | `reason` no erro |
|---|---|---|
| payload | precisa ser objeto | `invalid_input` |
| `username` | `trim` + minúsculas; `^[a-z0-9_]{3,20}$` | `username_invalid` |
| `username` | fora da lista reservada (`admin`, `suporte`, `mynoobpro`, `staff`…) | `username_reserved` |
| `displayName` | 2 a 30 caracteres após `trim` (mesmo limite das regras) | `invalid_input` |
| `birthDate` | `YYYY-MM-DD`, data existente, idade ≤ 120 | `invalid_input` |
| `birthDate` | idade ≥ 18 | `underage` (`failed-precondition`) |
| `termsVersion` | string não vazia | `invalid_input` |
| `languages` | 1 a 3 itens de `LANGUAGES`, sem repetição | `invalid_input` |
| `platforms` | 1 a 5 itens de `PLATFORMS`, sem repetição | `invalid_input` |
| `hasMic` | boolean | `invalid_input` |
| `playstyles` | 0 a 6 itens de `PLAYSTYLES` (padrão `[]`) | `invalid_input` |
| `region` | `null` ou sigla de UF (`^[A-Z]{2}$`) | `invalid_input` |

O limite do `displayName` é o mesmo das regras de propósito. Se fosse
diferente, o perfil poderia nascer com um nome que o próprio dono não
conseguiria mais salvar ao editar o perfil.

#### `ageOn`: idade no fuso de Brasília

A idade é calculada no calendário de **UTC-3**. Com UTC puro, quem faz 18
anos hoje seria recusado entre 21h e meia-noite do dia anterior. A função
também recusa datas que não existem: `Date.UTC(2007, 1, 31)` vira 03/03 sem
erro, então ela compara ano, mês e dia de volta.

### Gravação (`createProfile`)

Tudo acontece numa **transação**:

1. Lê `users/{uid}`, `usernames/{username}` e `config/app`.
2. Se o perfil já existe, lança `already_onboarded` (`already-exists`).
3. Se o username existe e é de **outro** uid, lança `username_taken`. Se for
   do mesmo uid, segue: é uma nova tentativa da mesma pessoa.
4. Se `termsVersion` ≠ `config/app.termsVersion`, lança `terms_outdated`.
   Isso cobre o caso de os termos mudarem durante o cadastro: o aceite
   registrado seria de um texto que a pessoa não viu.
5. Grava os três documentos:

| Documento | Conteúdo |
|---|---|
| `usernames/{username}` | `{ uid, createdAt }` |
| `users/{uid}` | dados do input + `country: 'BR'`, `availability` offline, `isOnline: false`, `companionStatus: 'none'`, `stats` zerados (`completionRate: 1`), `status: 'active'`, `gameIds: []`, `emailVerified`, `profileCompletedAt`, `createdAt`, `updatedAt` |
| `users/{uid}/private/data` | `email`, `birthDate`, `ageConfirmedAt`, `termsVersion`, `termsAcceptedAt`, `fcmTokens: []`, todas as `notificationPrefs` ligadas, `rateLimit` zerado |

6. Retorna `{ uid, username }`.

Se duas chamadas concorrentes tentam o mesmo username, a transação de uma
delas é reexecutada, vê o `usernames/{username}` já criado e falha com
`username_taken`.

## 5.4 Erros que o app trata

O app escolhe a mensagem por `error.details.reason`:

| `code` | `reason` |
|---|---|
| `unauthenticated` | — |
| `invalid-argument` | `invalid_input`, `username_invalid`, `username_reserved` |
| `failed-precondition` | `underage`, `terms_outdated`, `invalid_input` (sem e-mail) |
| `already-exists` | `username_taken`, `already_onboarded` |

## 5.5 Efeitos em cadeia

A criação de `users/{uid}` dispara `onUserWrittenSyncCards`. Como o perfil
nasce sem jogos, nenhum cartão é criado e `gameIds` continua `[]` (ver
[doc 8](08-functions-searchCards.md)).

## 5.6 Testes

`test/completeOnboarding.test.ts` cobre:

- `ageOn`: aniversário no fuso de Brasília e datas inexistentes;
- `parseOnboardingInput`: normalização do username, menor de idade
  (inclusive na véspera), username inválido ou reservado, listas fora do
  enum, vazias ou repetidas, `displayName` e `region` inválidos;
- `createProfile` no emulador: criação dos três documentos, username
  duplicado, perfil já existente e termos desatualizados.
