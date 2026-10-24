# player-2-backend

Regras, índices, Cloud Functions e scripts do Firebase do **MyNoobPro**
(codinome Player 2). O app (repo `player-2`) fala **direto** com o Firebase;
este repositório só guarda e testa o que o Firebase executa. Nada daqui roda
num servidor próprio.

Plano e modelo de dados: `MVP.md` e `MODELO_DE_DADOS.md` no repo do app.

## O que tem aqui

| Arquivo/pasta | Para que serve |
|---|---|
| `firestore.rules` | Quem lê/escreve o quê no Firestore (+ validação de campos) |
| `firestore.indexes.json` | Índices das consultas compostas (busca, sessões, chat) |
| `database.rules.json` | Regras do Realtime Database (presença online) |
| `storage.rules` | Regras do Storage (avatares: só imagem, < 2 MB, só o dono) |
| `functions/` | Cloud Functions em TypeScript (entram bloco a bloco - ver `TASKS.md` do app) |
| `functions/src/types.ts` | Entidades e enums; o app mantém uma cópia |
| `scripts/data/` | Catálogo de jogos e `config/app` |
| `scripts/bootstrap.ts` | Grava config + jogos (emulador ou produção) |
| `scripts/seed-dev.ts` | 30 jogadores fake - **só emulador** |
| `test/` | Testes das regras contra o emulador |

## Pré-requisitos

- Node 22+
- Java 21+ (emuladores)
- `npm install` (instala também `functions/`)

O Firebase CLI vem como dependência (`npx firebase ...`). Para deploy, é
preciso `npx firebase login` antes.

## Desenvolvimento local (não toca no Firebase real)

```bash
npm run emulators        # sobe Auth, Firestore, Functions, RTDB e Storage locais
                         # UI em http://localhost:4000; dados salvos em .emulator-data/
# em outro terminal, na primeira vez:
npm run dev:bootstrap    # config/app + 3 jogos
npm run dev:seed         # 30 jogadores de teste (recria do zero a cada execução)
```

Login de teste no app (com o app apontando para o emulador de Auth):
`dev01@mynoobpro.test` ... `dev30@mynoobpro.test`, senha `senha123`.

Do emulador Android, o host da máquina é `10.0.2.2` (ex.: Firestore em
`10.0.2.2:8080`).

## Testes

```bash
npm test         # sobe o emulador do Firestore com um projeto demo, roda vitest e derruba
npm run typecheck
```

Os testes usam o projeto `demo-mynoobpro`: projetos `demo-*` nunca acessam
serviços reais.

## Publicar no Firebase (só quando decidido)

Estes comandos **enviam para o projeto real** `mynoobpro-26215`:

```bash
npm run db:deploy          # regras e índices (Firestore, RTDB, Storage)
npm run db:bootstrap       # config + jogos no banco real (exige credencial:
                           #   gcloud auth application-default login)
npm run functions:deploy   # Cloud Functions
```

Rode `npm test` antes de todo deploy: na v0 existe um único projeto, o mesmo
dos usuários do beta.
