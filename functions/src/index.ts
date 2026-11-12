// Precisa ser o PRIMEIRO import: em ES modules, todo `export ... from` abaixo
// é avaliado antes do corpo deste arquivo, então um setGlobalOptions() escrito
// aqui rodaria depois das Functions já definidas - e elas iriam para a região
// padrão (us-central1). Aconteceu no primeiro deploy, em 29/10/2026.
import './globalOptions.js';

// As Functions entram aqui bloco a bloco (TASKS.md).
export { completeOnboarding } from './users/completeOnboarding.js';
export { expireAvailability } from './availability/expireAvailability.js';
export { onPresenceWritten } from './presence/onPresenceWritten.js';
export { deactivateListing, upsertListing } from './listings/listingCallables.js';
export {
  onListingWrittenSyncCards,
  onPlayerGameWrittenSyncCards,
  onUserWrittenSyncCards,
} from './search/syncSearchCards.js';
export {
  acceptSession,
  cancelSession,
  confirmSession,
  declineSession,
  markSessionDone,
  reportNoShow,
  requestSession,
  startSession,
} from './sessions/sessionCallables.js';
export { autoAdvanceSessions, autoCompleteSessions, expireSessionRequests } from './sessions/scheduledSessions.js';
export { onMessageCreated } from './chat/onMessageCreated.js';
