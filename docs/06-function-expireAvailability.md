# 6. Function `expireAvailability`

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | agendada (`onSchedule`, Cloud Scheduler) |
| Região | `southamerica-east1` |
| Frequência | `every 10 minutes`, fuso `America/Sao_Paulo` |
| Arquivos | `functions/src/availability/expireAvailability.ts` (adaptador), `functions/src/availability/expire.ts` (lógica) |
| Testes | `test/expireAvailability.test.ts` |
| Escreve | `users/{uid}.availability` e `updatedAt` |

## 6.1 O problema

O cliente grava a própria disponibilidade (`now`, `today` ou `window`) com
um prazo em `availability.expiresAt`. Se a pessoa fecha o app, ninguém volta
a mudar esse campo, e ela continuaria "disponível agora" na busca para
sempre.

Esta Function passa para `offline` todo usuário cujo prazo venceu.

## 6.2 Passo a passo (`expireAvailabilities`)

1. Consulta `users` onde `availability.expiresAt <= now`, em páginas de
   **300**.
   - `offline` tem `expiresAt: null`, e o Firestore não inclui `null` num
     filtro `<=`. Por isso a consulta só traz disponibilidades realmente
     vencidas, e quem já expirou não volta na execução seguinte.
2. Para cada documento, faz um `update` com:

   ```ts
   { availability: { state: 'offline', gameIds: [], windowStart: null,
                     windowEnd: null, expiresAt: null, note: null },
     updatedAt: now }
   ```

   com a pré-condição **`lastUpdateTime: doc.updateTime`**.
3. Se o documento mudou entre a leitura e a escrita (ex: a pessoa acabou de
   renovar a disponibilidade), a escrita falha e a escolha nova é mantida.
4. Usa `BulkWriter` com `onWriteError(() => false)` em vez de `batch`. Num
   batch, uma escrita recusada pela pré-condição cancelaria todas as outras.
   No BulkWriter, cada uma é independente e não há nova tentativa.
5. Repete enquanto a página vier cheia, até o limite de **20 páginas**
   (6.000 usuários) por execução. O que sobrar fica para a execução
   seguinte, 10 minutos depois. O teto evita que um bug (ex: uma escrita que
   nunca tira o documento da consulta) faça a função rodar até o timeout.
6. Retorna quantos documentos mudou. O adaptador registra no log só quando o
   número é maior que zero.

## 6.3 Atraso aceito

Uma disponibilidade vencida pode ficar até **10 minutos** a mais na busca
(MVP.md 7.3). O app já mostra como offline quem passou do `expiresAt`, então
o atraso só aparece para quem ainda não atualizou a tela.

## 6.4 Efeitos em cadeia

Cada `users/{uid}` alterado dispara `onUserWrittenSyncCards`, que passa os
cartões daquela pessoa para `availabilityState: 'offline'` (ver
[doc 8](08-functions-searchCards.md)).

## 6.5 Custo

Com ninguém vencido, cada execução custa **uma leitura** (consulta vazia).
São 144 execuções por dia, bem dentro da cota gratuita do Cloud Scheduler
(3 jobs grátis por conta de faturamento).

## 6.6 Testes

`test/expireAvailability.test.ts`, com `NOW` fixo:

- passa para offline só quem venceu (não mexe em quem ainda está no prazo
  nem em quem já está offline);
- não roda de novo sobre quem já expirou;
- pagina quando há mais vencidos que uma página.

O agendamento em si não roda no emulador. O que é testado é a lógica pura.
