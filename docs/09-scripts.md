# 9. Scripts e dados

[← Índice](DOCs.md)

Os scripts rodam **na máquina de quem opera**, com `tsx` (TypeScript sem
compilar) e o Admin SDK. Eles não são Cloud Functions. Para a diferença, veja
o [doc 13](13-do-codigo-ao-firebase.md#139-e-os-scripts-de-scripts).

## 9.1 Proteção contra produção

Os três scripts decidem o alvo pela variável `FIRESTORE_EMULATOR_HOST`:

| Situação | Comportamento |
|---|---|
| Variável definida | grava no **emulador** |
| Variável ausente, sem `--prod` | **aborta** com erro |
| Variável ausente, com `--prod` | grava em **produção** com `applicationDefault()` |

Os scripts `npm run dev:*` já definem a variável. Os `npm run db:*` passam
`--prod`. Rodar `tsx scripts/x.ts` direto, sem nenhum dos dois, falha. Isso é
intencional.

Credencial para produção (uma vez por máquina):

```bash
gcloud auth application-default login
```

O `.gitignore` bloqueia arquivos de service account (`*serviceAccount*.json`,
`*-sa.json`). Não use chave em arquivo.

## 9.2 `scripts/bootstrap.ts`

Grava o que o app **precisa** para funcionar: `config/app` e o catálogo de
jogos.

```bash
npm run dev:bootstrap    # emulador
npm run db:bootstrap     # produção
```

1. Lê `scripts/data/config.json` e `scripts/data/games.json`.
2. Confere que todo `config.activeGameIds` existe em `games.json`. Se não
   existir, aborta antes de gravar.
3. Num `batch`, grava `config/app` (+ `updatedAt: serverTimestamp()`) e cada
   `games/{id}`, ambos com `merge: true`.

É **idempotente**: rodar de novo atualiza, não duplica. Como usa `merge`, um
campo removido do JSON **não** some do banco. Remover um campo exige o
Console ou um script próprio.

## 9.3 `scripts/seed-dev.ts` (só emulador)

Cria 30 jogadores de teste para a tela Explorar ter conteúdo.

```bash
npm run dev:seed    # com os emuladores rodando e depois do dev:bootstrap
```

- Exige `FIRESTORE_EMULATOR_HOST` **e** `FIREBASE_AUTH_EMULATOR_HOST`. Não
  tem modo `--prod`.
- Apaga o seed anterior: usuários `@mynoobpro.test` no Auth e as coleções
  `users`, `usernames`, `searchCards` e `listings` inteiras.
- PRNG com semente fixa (42): gera sempre os mesmos dados.
- Para cada jogador: conta no Auth (`devNN@mynoobpro.test` / `senha123`),
  `usernames`, `users`, `private/data`, 1 ou 2 jogos, e um anúncio para 1 em
  cada 4 (companions).
- Grava os `searchCards` **diretamente** (ver
  [pontos de atenção](12-pontos-de-atencao.md)).
- Faz commit em batches de até 400 operações.

## 9.4 `scripts/rebuild-search-cards.ts`

Recalcula os `searchCards` de todos os usuários com **a mesma lógica dos
triggers** (`syncUserCards`, importada de `functions/src/search/cards.ts`).

```bash
npm run dev:rebuild-cards   # emulador
npm run db:rebuild-cards    # produção
```

Quando usar:

- depois de mudar o catálogo (ex: a ordem dos ranks), porque não há trigger
  em `games/*`;
- logo após o primeiro deploy dos triggers, para criar os cartões de quem já
  tinha perfil.

Passo a passo:

1. Lê os ids de `users` e os `uid` de `searchCards` (com `select()`, sem
   baixar os documentos inteiros). A união inclui os donos de cartões órfãos,
   para que a sync os apague.
2. Chama `syncUserCards` para cada uid, **em série**.
3. Imprime o total gravado, apagado e com `gameIds` corrigido.

É idempotente: quem já está certo não é escrito. Em série é lento com muitos
usuários, mas não compete com os triggers por contenção de transação.

Note que as escritas do script em `users/{uid}.gameIds` disparam os triggers
em produção. Eles rodam, não encontram diferença e não escrevem.

## 9.5 `scripts/data/`

### `config.json`

Conteúdo de `config/app`, sem `updatedAt`. Os campos estão descritos no
[doc 2](02-modelo-de-dados.md#configapp-appconfig). Para mudar a configuração
em produção, edite o arquivo e rode `npm run db:bootstrap`.

Mudar `termsVersion` obriga quem estiver no meio do cadastro a aceitar os
termos de novo (ver [doc 5](05-function-completeOnboarding.md)).

### `games.json`

Catálogo: `valorant`, `lol` e `cs2`, com `ranks` (`id`, `label`, `order`),
`roles`, `platforms`, `maxPartySize`, `active` e `sortOrder`.

- `ranks[].order` é a fonte de verdade do `rankOrder` nos cartões.
- **Não renomeie o `id` de um rank em uso.** Quem tem esse rank perde o
  cartão até escolher outro (`buildCard` retorna `null`).
- Depois de mudar ranks: `npm run db:bootstrap` e `npm run db:rebuild-cards`.
