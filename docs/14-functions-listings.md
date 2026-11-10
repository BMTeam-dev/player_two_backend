# 14. Functions `upsertListing` e `deactivateListing`

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | callables (`onCall`), HTTPS |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/listings/listingCallables.ts` (adaptadores), `functions/src/listings/listing.ts` (lógica) |
| Testes | `test/listings.test.ts` |
| Quem chama | O app, na tela "Anúncio" (`EditListing`) e ao remover um jogo do perfil |
| Escreve | `listings/{listingId}` |

## 14.1 Por que são Functions

As regras **proíbem** o cliente de escrever em `listings`. Três coisas
dependem do servidor:

1. **Limites que olham outros documentos**: no máximo 1 anúncio ativo por
   jogo e `config/app.maxActiveListingsPerUser` (3) no total. Só uma
   transação garante isso com dois "Salvar" seguidos.
2. **Preço só para companion aprovado**: `priceCents > 0` exige
   `companionStatus == 'approved'`, um campo que só admin/Function altera.
3. **`ownerSnapshot`** (nome, avatar e nota do dono) vem do perfil, não do
   que o cliente mandar.

## 14.2 Chamada pelo app

```ts
const upsertListing = httpsCallable(functions, 'upsertListing');
await upsertListing({
  listingId: 'abc123',        // omitido ou null = anúncio novo
  gameId: 'valorant',
  category: 'play_together',  // play_together | companion | coaching
  title: 'Duo de Valorant',   // 3-60 caracteres
  description: '...',         // até 500
  priceCents: 0,              // 0-100000; > 0 só companion aprovado
  pricingUnit: 'hour',        // hour | session
  sessionMinutes: 60,         // 15-240, de 15 em 15
  languages: ['pt'],
  platforms: ['pc'],
});
// → { listingId }

const deactivateListing = httpsCallable(functions, 'deactivateListing');
await deactivateListing({ listingId: 'abc123' });
// → { listingId }
```

## 14.3 Passo a passo

### `upsertListing`

1. Sem `request.auth`, lança `unauthenticated`.
2. `parseListingInput` valida e normaliza o payload (título e descrição com
   `trim`). Qualquer campo fora das regras dá `invalid_input`.
3. `saveListing`, numa transaction, lê o usuário, `config/app`, o jogo no
   perfil (`users/{uid}/games/{gameId}`), o jogo no catálogo, os anúncios
   ativos do dono e, na edição, o anúncio atual. Então verifica, nesta ordem:

| Verificação | `reason` | Código |
|---|---|---|
| perfil existe e tem `profileCompletedAt` | `no_profile` | `failed-precondition` |
| `status == 'active'` | `account_restricted` | `permission-denied` |
| edição: anúncio existe e é do chamador | `listing_not_found` | `not-found` |
| edição: o `gameId` não mudou | `invalid_input` | `invalid-argument` |
| jogo está no perfil e ativo no catálogo | `game_not_in_profile` | `failed-precondition` |
| preço > 0 só com `companionStatus == 'approved'` | `price_requires_companion` | `permission-denied` |
| nenhum **outro** anúncio ativo no mesmo jogo | `game_has_listing` | `already-exists` |
| **outros** anúncios ativos < `maxActiveListingsPerUser` | `limit_reached` | `resource-exhausted` |

4. Grava o documento inteiro com `active: true`, `ownerSnapshot` do perfil,
   `updatedAt = now` e `createdAt` mantido na edição.

O anúncio sendo editado não conta nos limites. Editar um anúncio **inativo**
o reativa, e aí ele conta: se a pessoa já está no limite, recebe
`limit_reached`.

Por que o jogo não muda na edição: as sessões pedidas a partir do anúncio
(tarefa 22) guardam o `listingId` e esperam o mesmo jogo. Trocar de jogo é
remover um anúncio e criar outro.

Por que exigir o jogo no perfil: os cartões de busca são um por jogo do
perfil (doc [8](08-functions-searchCards.md)). Um anúncio de um jogo fora do
perfil apareceria no perfil público, mas nunca na busca.

### `deactivateListing`

1. Sem `request.auth`, lança `unauthenticated`.
2. Numa transaction, lê o anúncio. Se não existe ou é de outra pessoa:
   `listing_not_found`.
3. Se está ativo, grava `active: false` e `updatedAt`. Se já está inativo, não
   escreve nada.

O documento não é apagado: a tarefa 22 vai guardar o `listingId` nas sessões.

## 14.4 Efeitos em outras partes

- **Busca**: toda escrita em `listings` dispara `onListingWrittenSyncCards`,
  que atualiza `listingId`, `category` e `priceCents` no cartão do jogo.
- **Remover um jogo do perfil**: o app chama `deactivateListing` para o
  anúncio daquele jogo antes de apagar o jogo. Se o app falhar no meio, o
  anúncio fica ativo, mas fora da busca, porque não há cartão sem o jogo.
- **`ownerSnapshot` desatualizado**: a cópia é feita ao salvar. Ainda não há
  trigger que a atualize quando o perfil muda (ver
  [pontos de atenção](12-pontos-de-atencao.md)). O app não lê esse campo hoje.

## 14.5 Testes

`test/listings.test.ts` (12 testes):

- `parseListingInput`: normalização, título/descrição, preço (inteiro,
  limites), duração (faixa e passo de 15), enums e `gameId` com `/`.
- `saveListing`/`deactivateListing` no emulador: criação com snapshot;
  edição mantendo `createdAt` e sem trocar de jogo; anúncio de outra pessoa;
  preço só para companion; jogo fora do perfil ou inativo, perfil incompleto
  e conta suspensa; 1 por jogo, limite total, edição fora do limite e
  reativação; desativação idempotente.
