# 1. Arquitetura

[← Índice](DOCs.md)

## 1.1 Sem servidor próprio

O app fala direto com os serviços do Firebase. Não existe API REST, Express
nem VM. Tudo o que roda "no servidor" está em uma de três formas:

1. **Regras de segurança.** São avaliadas pelo próprio Firebase a cada
   leitura ou escrita do cliente. Elas fazem papel de "controller + validação"
   para o que o cliente pode fazer sozinho.
2. **Cloud Functions.** É o código TypeScript que roda com o Admin SDK e,
   portanto, **ignora as regras**. Elas cobrem o que envolve outra pessoa,
   dinheiro, idade, unicidade ou dados desnormalizados.
3. **Scripts administrativos.** Rodam na máquina de quem opera, também com o
   Admin SDK, para carregar o catálogo e corrigir dados.

## 1.2 Princípio central: cliente lê, Function escreve

Está no topo do `firestore.rules` e guia o resto do projeto:

> O cliente lê direto, mas só **escreve** direto no que é dele: o próprio
> perfil, os próprios jogos, as próprias mensagens. Tudo que envolve outra
> pessoa passa por Cloud Function.

Na prática:

| Quem escreve | O quê | Por quê |
|---|---|---|
| Cliente (com validação nas regras) | `users/{uid}` (só campos editáveis), `users/{uid}/games/*`, `users/{uid}/private/data` (só `fcmTokens` e `notificationPrefs`), mensagens de texto, zerar o próprio `unread`, `/status/{uid}` no RTDB, avatar no Storage | É dado da própria pessoa; uma callable aqui seria só latência e custo |
| Cloud Function | criação do perfil, `usernames`, `searchCards`, `isOnline`/`lastSeenAt`, expiração da disponibilidade e, nas próximas tarefas, `listings`, `sessions`, `reviews`, `reports`, bloqueios | Precisa de transação, de dados de terceiros, de regra que o cliente poderia burlar, ou de desnormalização |
| Admin (script ou Console) | `config/app`, `games/*`, `status` de moderação | Configuração do produto |

## 1.3 Serviços e regiões

| Serviço | Instância | Região | Observação |
|---|---|---|---|
| Firestore | `(default)`, modo produção | `southamerica-east1` (São Paulo) | Banco principal |
| Realtime Database | `mynoobpro-26215-default-rtdb` | `us-central1` | **Não existe RTDB em São Paulo.** Usado só para presença, porque tem `onDisconnect` |
| Storage | `mynoobpro-26215.firebasestorage.app` | `southamerica-east1` | Só avatares na v0 |
| Cloud Functions (2ª geração) | — | `southamerica-east1` | Padrão definido em `globalOptions.ts` |
| Cloud Functions: `onPresenceWritten` | — | `us-central1` | Trigger de RTDB precisa estar na região da instância |
| Auth | — | global | Login **só via Google** (decisão de 24/10/2026) |

Projeto: **`mynoobpro-26215`**, plano Blaze, com alertas de orçamento de US$ 10, 25 e 50.

## 1.4 Estrutura de pastas

```text
player-2-backend/
├── firebase.json             # o que o CLI publica + portas dos emuladores
├── .firebaserc               # projeto padrão: mynoobpro-26215
├── firestore.rules           # regras do Firestore         → doc 3
├── firestore.indexes.json    # índices compostos           → doc 4
├── database.rules.json       # regras do RTDB (presença)   → doc 3
├── storage.rules             # regras do Storage (avatar)  → doc 3
├── package.json              # scripts npm da raiz (emulador, testes, deploy)
├── tsconfig.json             # typecheck de scripts/ e test/
├── vitest.config.ts          # testes em série (emulador compartilhado)
├── functions/                # código publicado como Cloud Functions
│   ├── package.json          # firebase-functions 7 + firebase-admin 14, Node 22
│   ├── tsconfig.json         # compila src/ → lib/
│   └── src/
│       ├── index.ts          # ponto de entrada: exporta todas as Functions
│       ├── globalOptions.ts  # região padrão + teto de instâncias
│       ├── types.ts          # entidades e enums (o app mantém uma cópia)
│       ├── lib/admin.ts      # inicializa o Admin SDK uma única vez
│       ├── users/            # completeOnboarding         → doc 5
│       ├── availability/     # expireAvailability          → doc 6
│       ├── presence/         # onPresenceWritten           → doc 7
│       └── search/           # syncSearchCards             → doc 8
├── scripts/                  # bootstrap, seed, rebuild    → doc 9
│   └── data/                 # config.json e games.json
├── test/                     # vitest contra o emulador    → doc 10
└── docs/                     # esta documentação
```

### Padrão de cada pasta de Function

Toda Function é dividida em **dois arquivos**:

| Arquivo | Conteúdo | Exemplo |
|---|---|---|
| Lógica pura | Uma função exportada que recebe `db` e `now` por parâmetro e faz o trabalho | `availability/expire.ts` → `expireAvailabilities(db, now)` |
| Adaptador | Declara o gatilho (`onCall`, `onSchedule`, `onDocumentWritten`...), pega o `db` de `lib/admin.ts` e chama a lógica | `availability/expireAvailability.ts` |

Isso existe por um motivo técnico. Os testes rodam com o `firebase-admin` da
**raiz** do repositório, e as Functions com o de `functions/node_modules`.
Um `Timestamp` ou `FieldValue` criado por uma cópia do pacote é **recusado**
pelo serializador da outra. Por isso a lógica:

- recebe `db` e `now` de fora, em vez de importar;
- grava `Date` em vez de `Timestamp.fromMillis(...)` quando precisa criar
  uma data (o Firestore converte do mesmo jeito).

## 1.5 Configuração, arquivo por arquivo

### `functions/src/index.ts`

```ts
import './globalOptions.js';     // PRECISA ser o primeiro import
export { completeOnboarding } from './users/completeOnboarding.js';
...
```

**Por que `globalOptions` vem primeiro:** em ES modules, todos os
`export ... from` são avaliados **antes** do corpo do arquivo. Um
`setGlobalOptions()` escrito no corpo rodaria depois das Functions já
definidas, e elas iriam para a região padrão (`us-central1`). Isso aconteceu
de fato no primeiro deploy, em 29/10/2026 (ver [Operação](11-operacao-e-deploy.md#incidentes-e-lições)).

### `functions/src/globalOptions.ts`

```ts
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });
```

- `region`: a mesma do Firestore, para menor latência e para não pagar
  tráfego entre regiões.
- `maxInstances: 10`: **teto de custo**. Se um bug colocar um trigger em loop,
  cada Function escala no máximo até 10 instâncias.

### `functions/src/lib/admin.ts`

Inicializa o Admin SDK **uma vez por instância**, com o guarda
`getApps().length === 0`, e exporta `db` (Firestore) e `auth`. Todos os
adaptadores importam daqui.

### `firebase.json`

- Aponta os arquivos de regras e índices de cada serviço.
- `functions.predeploy` roda `npm run build` (tsc) antes de publicar: o
  Firebase envia `functions/lib/`, não o TypeScript.
- Emuladores: Auth `9099`, Functions `5001`, Firestore `8080`, RTDB `9000`,
  Storage `9199`, UI `4000`. `singleProjectMode: true` impede misturar projetos.

### `functions/tsconfig.json` e `tsconfig.json` (raiz)

- Os dois usam `module/moduleResolution: nodenext` e `target: es2023`. Por
  isso os imports internos terminam em `.js` (ex.: `'./cards.js'`), mesmo
  apontando para arquivos `.ts`.
- `functions/` compila `src/` para `lib/` com `strict`, `noUnusedLocals` e `noImplicitReturns`.
- A raiz só faz typecheck (`noEmit`) de `scripts/` e `test/`. Os scripts
  rodam com `tsx`, sem compilar.

### `package.json` (raiz)

| Script | O que faz |
|---|---|
| `postinstall` | Instala também `functions/` (um `npm install` só basta) |
| `build` | Compila as Functions |
| `typecheck` | Checa os tipos de scripts, testes e Functions |
| `emulators` | Compila e sobe todos os emuladores, importando e exportando `.emulator-data/` |
| `emulators:fresh` | Mesma coisa, mas sem dados salvos |
| `dev:bootstrap` / `dev:seed` / `dev:rebuild-cards` | Scripts contra o **emulador** |
| `test` | Sobe o emulador do Firestore com o projeto `demo-mynoobpro`, roda o vitest e derruba |
| `db:deploy` | Publica as regras e os índices (Firestore, RTDB, Storage) **em produção** |
| `db:bootstrap` / `db:rebuild-cards` | Scripts contra **produção** (exigem `--prod`) |
| `functions:deploy` | Publica as Functions **em produção** |

### Versões

| Pacote | Versão | Onde |
|---|---|---|
| Node | 22 | `functions/package.json` (`engines`) |
| `firebase-functions` | ^7.4.0 | functions |
| `firebase-admin` | ^14.5.0 | functions e raiz |
| `firebase-tools` | ^15.34.0 | raiz (CLI via `npx firebase`) |
| `firebase` (SDK web) | ^13.0.0 | raiz, só para os testes de regras |
| `@firebase/rules-unit-testing` | ^6.0.0 | raiz |
| `vitest` | ^5.0.5 | raiz |
| `typescript` | ^6.0.3 | ambos |
