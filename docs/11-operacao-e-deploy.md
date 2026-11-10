# 11. Operação e deploy

[← Índice](DOCs.md)

> Na v0 existe **um único projeto Firebase** (`mynoobpro-26215`), o mesmo dos
> usuários do beta. Todo deploy vai direto para produção.

## 11.1 Rodar localmente

Pré-requisitos: Node 22+, Java 21+ e `npm install` na raiz (que instala
também `functions/`).

```bash
npm run emulators        # compila as Functions e sobe todos os emuladores
                         # UI: http://localhost:4000
                         # dados importados/exportados em .emulator-data/
# em outro terminal, na primeira vez:
npm run dev:bootstrap    # config/app + jogos
npm run dev:seed         # 30 jogadores de teste
```

| Emulador | Porta |
|---|---|
| Auth | 9099 |
| Functions | 5001 |
| Firestore | 8080 |
| Realtime Database | 9000 |
| Storage | 9199 |
| UI | 4000 |

- `npm run emulators:fresh` sobe os emuladores sem os dados salvos.
- O emulador **não recompila sozinho**. Depois de mudar uma Function, rode
  `npm run build` (ou deixe `npm --prefix functions run build:watch` aberto)
  e o emulador recarrega o `lib/`.
- Do emulador Android, o host da máquina é `10.0.2.2`.
- Login de teste: `dev01@mynoobpro.test` … `dev30@mynoobpro.test`, senha
  `senha123`.
- O `onSchedule` (`expireAvailability`) não roda sozinho no emulador.

## 11.2 Publicar

Faça login uma vez com `npx firebase login`. Antes de **todo** deploy, rode:

```bash
npm run typecheck && npm test
```

| Comando | O que publica |
|---|---|
| `npm run db:deploy` | `firestore.rules`, `firestore.indexes.json`, `database.rules.json`, `storage.rules` |
| `npm run functions:deploy` | todas as Functions |
| `npx firebase deploy --only functions:<nome>` | uma Function |
| `npm run db:bootstrap` | `config/app` + catálogo (exige `gcloud auth application-default login`) |
| `npm run db:rebuild-cards` | recalcula todos os `searchCards` |

### Ordem quando uma mudança mexe em várias partes

1. **Índices e regras** (`db:deploy`). Índices podem levar minutos para ficar
   prontos.
2. **Dados** (`db:bootstrap`), se `config` ou o catálogo mudaram.
3. **Functions** (`functions:deploy`).
4. **Scripts de correção** (`db:rebuild-cards`), se necessário.
5. **App**, por último.

### Primeiro deploy de `searchCards` (pendente)

1. `npm run db:deploy`: publica os índices de `searchCards`.
2. `npx firebase deploy --only functions:onUserWrittenSyncCards,functions:onPlayerGameWrittenSyncCards,functions:onListingWrittenSyncCards`.
3. `npm run db:rebuild-cards`: cria os cartões de quem já tem perfil.
4. Conferir no Console que `searchCards` tem um documento por jogo de perfil.

## 11.3 Conferir em produção

- **Console → Functions**: lista, região, versão e erros.
- **Logs**: `npx firebase functions:log --only <nome>` ou o Cloud Logging.
  - `expireAvailability` registra `info` quando expira alguém.
  - A sync de `searchCards` registra `debug` quando muda algo.
- **Console → Firestore → Índices**: status dos índices.
- **Cloud Scheduler**: job `firebase-schedule-expireAvailability-southamerica-east1`.

## 11.4 Branches

As branches são empilhadas, uma por bloco do `TASKS.md`:

```text
main ─ feat/availability ─ feat/presence ─ feat/search-cards
```

| Branch | Último commit | Conteúdo |
|---|---|---|
| `main` | `9b4df28` | commit inicial (regras, índices, scripts) |
| `feat/availability` | `906e969` | `completeOnboarding`, correção de região, `expireAvailability` |
| `feat/presence` | `55a50fb` | `onPresenceWritten` |
| `feat/search-cards` | `3d7b6da` | `searchCards` + janela de disponibilidade |

O PR de cada branch aponta para a anterior.

## 11.5 Custos e limites

- Plano **Blaze**, com alertas de orçamento de US$ 10, 25 e 50.
- `maxInstances: 10` por Function. É um teto de custo contra loops.
- `expireAvailability`: 144 execuções por dia, ~1 leitura cada quando
  ninguém vence.
- A sync de `searchCards` é a parte mais cara. Cada mudança de perfil, jogo,
  anúncio **ou presença** relê o usuário, os jogos, os anúncios, os cartões e
  o catálogo (ver [pontos de atenção](12-pontos-de-atencao.md)).
- Estimativas detalhadas: `PRECOS.md`, no repo do app.

## Incidentes e lições

### 29/10/2026: Functions publicadas em `us-central1`

**O que aconteceu:** o primeiro deploy de `completeOnboarding` foi para
`us-central1` em vez de `southamerica-east1`.

**Causa:** o `setGlobalOptions()` estava no corpo do `index.ts`. Em ES
modules, os `export ... from` são avaliados **antes** do corpo do arquivo,
então as Functions já tinham sido definidas com a região padrão.

**Correção** (`9a11144`): o `setGlobalOptions` foi para
`functions/src/globalOptions.ts`, importado como **primeira linha** do
`index.ts`.

**Lição:** depois de um deploy, confira a região no Console ou na saída do
CLI.
