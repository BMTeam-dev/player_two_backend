# 18. Functions de avaliação (tarefa 29)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | `submitReview`: callable (HTTPS). `revealBlindReviews`: agendada (Cloud Scheduler) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/reviews/reviewFunctions.ts` (adaptadores), `functions/src/reviews/review.ts` (lógica) |
| Testes | `test/reviews.test.ts`, bloco `reviews` de `test/firestore.rules.test.ts` |
| Disparo | app, na tela de avaliação; `revealBlindReviews` todo dia às 04:00 (horário de Brasília) |
| Escreve | `reviews/{sessionId}_{authorUid}`, `sessions/{id}.reviewedBy` |

## 18.1 Avaliação cega

Cada lado de uma sessão `completed` avalia o outro uma vez: nota de 1 a 5,
tags (`ReviewTag`) e um comentário opcional de até 300 caracteres. A
avaliação nasce com `visible: false`. As regras deixam só o autor ler uma
avaliação cega, nem o avaliado lê (ver [regras](03-regras-de-seguranca.md)).

Ela vira `visible: true` em dois casos:

1. **O outro lado também avaliou.** A segunda chamada de `submitReview`
   revela as duas, na mesma transaction.
2. **Passou `reviewWindowDays` (7) desde a criação** e o outro lado não
   avaliou. Quem revela é a `revealBlindReviews`.

Por que cega: quem avalia por último não consegue ler a avaliação do outro
antes de mandar a sua. Assim, nenhuma nota baixa é retaliação.

## 18.2 `submitReview`

Entrada: `{ sessionId, rating, tags?, comment? }`.

1. `parseReviewInput` valida o payload. A nota precisa ser um inteiro de 1 a
   5 e as tags precisam ser de `ReviewTag`; tags repetidas são removidas. O
   comentário passa por trim, e vazio vira `null`.
2. O comentário passa pelo mesmo filtro de termos graves do chat
   (`severeTerms.ts`). No chat, a mensagem só é **marcada**. Aqui ela é
   **recusada** (`comment_not_allowed`), porque o comentário fica público no
   perfil de outra pessoa.
3. Numa transaction, a função lê a sessão, a avaliação do próprio usuário, a
   do outro lado e o perfil do autor. Depois confere:
   - se quem chamou participa da sessão. Para quem não participa, o erro é
     `session_not_found`, o mesmo de uma sessão que não existe;
   - se o status é `completed` (`invalid_state`);
   - se `now ≤ completedAt + reviewWindowDays` (`review_window_closed`). O
     prazo vem de `config/app` e o padrão é 7 dias;
   - se ainda não existe avaliação deste autor nesta sessão
     (`already_reviewed`). O ID determinístico `{sessionId}_{authorUid}`
     garante isso;
   - se a conta do autor está `active` (`account_restricted`). Conta
     suspensa não avalia, porque seria um jeito de retaliar quem a
     denunciou.
4. Por fim, grava a avaliação com `authorSnapshot` e `visible =` "o outro já
   avaliou", torna visível a do outro, se houver, e marca
   `sessions/{id}.reviewedBy.<papel> = true`.

O app sabe se já avaliou pela `reviewedBy` da sessão, sem precisar ler
`reviews`. Isso importa porque um `get` em `reviews/{id}` que **não existe**
é recusado pelas regras: a regra lê `resource.data`, e documento
inexistente não tem `resource`.

Retorno: `{ reviewId, visible }`.

`reviewedBy` muda a sessão, mas não o `status`. Por isso o
`onSessionWrittenPush` ignora essa escrita e nenhum push é enviado.

## 18.3 `revealBlindReviews`

A função consulta `visible == false` com `createdAt <= now - reviewWindowDays`,
usando o índice `reviews (visible, createdAt ↑)` (ver
[índices](04-indices.md)). Ela vai em páginas de 200, até 10 páginas por
execução, e grava `visible: true` em batch. Não precisa de transaction:
nesse meio-tempo, a única escrita que pode acontecer é a mesma revelação.

O prazo conta a partir da **criação** da avaliação, e não da conclusão da
sessão, porque é isso que o índice permite. Como uma avaliação só é criada
depois da conclusão, ela nunca é revelada antes de o outro lado perder o
direito de avaliar, e a avaliação continua cega. No pior caso, quem avaliou
no último dia espera até 7 dias a mais para a avaliação aparecer.

## 18.4 O que fica para outras tarefas

- **`stats.ratingAvg` e `stats.ratingCount`**: tarefa 30. Ainda está em
  aberto se a média conta só as avaliações visíveis (o que mantém a
  cegueira: a nota média não pode mudar antes da revelação) ou todas.
- **Denunciar avaliação** (`ReportTargetType: 'review'`): tarefa 31.
- **Push** avisando que alguém te avaliou: fora da v0.

## 18.5 Testes

`test/reviews.test.ts` (11 testes):

- `parseReviewInput`: normalização, nota/tags/comentário/id inválidos e termo grave.
- `submitReview`: primeira avaliação cega e segunda revelando as duas, com
  `reviewedBy`; avaliação repetida; terceiro e sessão inexistente com o mesmo
  erro; os 8 status diferentes de `completed`; prazo de 7 dias no limite e
  lido de `config/app`; conta suspensa.
- `revealBlindReviews`: revela só as cegas vencidas, idempotente, prazo lido
  de `config/app`.

Bloco `reviews` em `test/firestore.rules.test.ts` (3 testes): avaliação cega
só o autor lê; visível qualquer usuário logado lê, inclusive pela consulta do
perfil (`targetId` + `visible == true` + `createdAt ↓`), e sem o filtro de
`visible` a consulta é recusada; cliente não cria, edita nem apaga.
