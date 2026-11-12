# 16. Function `onMessageCreated` (chat)

[← Índice](DOCs.md)

| | |
|---|---|
| Tipo | trigger Firestore (`onDocumentCreated`) |
| Região | `southamerica-east1` |
| Arquivos | `functions/src/chat/onMessageCreated.ts` (gatilho), `functions/src/chat/messages.ts` (lógica), `functions/src/chat/severeTerms.ts` (filtro) |
| Testes | `test/chat.test.ts` |
| Disparo | criação de `conversations/{conversationId}/messages/{messageId}` |
| Escreve | `conversations/{id}` (`lastMessage`, `unread`, `updatedAt`), a própria mensagem (`flagged` ou exclusão), `users/{uid}/private/data.rateLimit` |

## 16.1 Por que um trigger

O cliente grava a mensagem de texto direto no Firestore. As regras garantem
que ele é participante, que a conversa não está trancada e que a mensagem é
`type: 'text'`, com `flagged: false` e `createdAt == request.time` (ver
[regras](03-regras-de-seguranca.md)). Uma callable por mensagem deixaria o
envio mais lento e custaria uma invocação a mais sem ganho: a escrita
direta já aparece na hora para quem enviou (cache local do Firestore).

O que as regras **não** conseguem fazer fica com o trigger:

1. **`lastMessage` e `unread` da conversa.** O cliente não pode escrever
   na conversa, exceto para zerar o próprio `unread`.
2. **Limite por minuto** (`config/app.rateLimits.messagesPerMinute`, 30).
   Regra não conta documentos.
3. **Filtro de termos graves**, que marca `flagged: true`.

## 16.2 Passo a passo

Tudo numa transaction:

1. Lê a mensagem, a conversa e `config/app`. Mensagem que não é de texto
   (as de sistema), sem autor ou de conversa inexistente: **ignora**. As
   mensagens de sistema já atualizam a conversa em quem as grava
   (`postSystemMessage`, [doc 15](15-functions-sessions.md#154-mensagens-de-sistema-e-unread)).
2. Lê `users/{autor}/private/data.rateLimit`. Janela fixa de 1 min **por
   pessoa, somando todas as conversas** (`messagesWindowStart`,
   `messagesCount`). Acima do limite, **apaga a mensagem** e para aí.
3. Soma 1 no contador da janela (`merge`, sem tocar no limite de pedidos
   de sessão do mesmo documento).
4. `hasSevereTerm(text)` → `flagged: true` na mensagem.
5. Na conversa: `unread` +1 para quem não enviou; `lastMessage` só se a
   mensagem for a mais nova (`createdAt >=` o `lastMessage.at` atual);
   `updatedAt`.

## 16.3 Decisões

| Decisão | Regra | Por quê |
|---|---|---|
| Excesso apagado | Acima de 30 mensagens/min, o trigger apaga a mensagem | Não há como recusar antes (as regras não contam). 30/min não atinge conversa normal, só flood. Spam apagado não faz falta como evidência: o resto da conversa continua lá |
| `flagged` não esconde | A mensagem continua visível para os dois; só fica marcada para a moderação | Falso positivo não pode sumir com mensagem normal; quem recebeu pode denunciar (tarefa 31) |
| Lista curta | Ódio, assédio sexual e ameaça. Palavrão comum ("porra") fica de fora | É linguagem normal de jogo; marcar tudo enterraria os casos graves. Revisar com o checklist de moderação (tarefa 35) |
| Normalização | Minúsculas, sem acento, leet (`0→o`, `1→i`, `3→e`, `4→a`, `5→s`, `7→t`, `@→a`, `$→s`) e letra repetida colapsada | Pega as variações óbvias (`v1aaad0`) sem regex por palavra |
| Mensagem atrasada | Conta no `unread`, mas não substitui um `lastMessage` mais novo | Triggers não chegam em ordem garantida |

## 16.4 Limitações conhecidas

- **Entrega "pelo menos uma vez".** Se o Firebase entregar o mesmo evento
  duas vezes (raro; retry está desligado), o `unread` soma 2. O efeito é
  só um número a mais na aba, zerado quando a pessoa abre a conversa.
- **O app não sabe que a mensagem foi apagada pelo limite**: ela some da
  conversa. Aceitável para um limite que só flood atinge.
- **Push de nova mensagem**: enviado por este mesmo trigger, depois da transaction (ver [push](17-push.md)).
