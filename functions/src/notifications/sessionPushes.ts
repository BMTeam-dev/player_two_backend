import type { Session, SessionStatus } from '../types.js';
import { sessionLink, type PushIntent } from './push.js';

type SessionFields = Pick<Session, 'id' | 'requesterId' | 'providerId' | 'participantSnapshots' | 'status' | 'cancellation'>;

const nameOf = (s: SessionFields, uid: string) => s.participantSnapshots?.[uid]?.displayName ?? 'Um jogador';

/**
 * Pushes de uma escrita em `sessions/{id}` (MVP.md, seção 13):
 * - pedido novo → provider;
 * - aceito, recusado ou expirado → requester;
 * - cancelado → o outro lado (decisions.md, tarefa 26).
 * Início, fim e conclusão não geram push: quem jogou já está acompanhando.
 */
export function sessionPushes(before: SessionFields | null, after: SessionFields | null, gameName: string): PushIntent[] {
  if (!after || before?.status === after.status) {
    return [];
  }
  const base = { link: sessionLink(after.id), tag: `session_${after.id}` } as const;
  const requester = nameOf(after, after.requesterId);
  const provider = nameOf(after, after.providerId);

  if (!before) {
    return after.status === 'requested'
      ? [
          {
            ...base,
            to: after.providerId,
            pref: 'sessionRequests',
            channel: 'sessions',
            title: 'Novo pedido de sessão',
            body: `${requester} quer jogar ${gameName} com você. Responda no app.`,
          },
        ]
      : [];
  }

  const toRequester: Partial<Record<SessionStatus, { title: string; body: string }>> = {
    accepted: { title: 'Pedido aceito', body: `${provider} aceitou sua sessão de ${gameName}.` },
    declined: { title: 'Pedido recusado', body: `${provider} recusou o pedido de ${gameName}.` },
    expired: { title: 'Pedido expirado', body: `${provider} não respondeu a tempo. Que tal chamar outro jogador?` },
  };
  const message = toRequester[after.status];
  if (message && before.status === 'requested') {
    return [{ ...base, to: after.requesterId, pref: 'sessionUpdates', channel: 'sessions', ...message }];
  }

  if (after.status === 'cancelled' && after.cancellation) {
    const by = after.cancellation.by;
    const to = by === after.requesterId ? after.providerId : after.requesterId;
    const wasRequest = before.status === 'requested';
    return [
      {
        ...base,
        to,
        pref: 'sessionUpdates',
        channel: 'sessions',
        title: wasRequest ? 'Pedido cancelado' : 'Sessão cancelada',
        body: `${nameOf(after, by)} cancelou ${wasRequest ? 'o pedido' : 'a sessão'} de ${gameName}.`,
      },
    ];
  }
  return [];
}
