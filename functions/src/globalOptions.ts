import { setGlobalOptions } from 'firebase-functions/v2';

// Mesma região do Firestore (southamerica-east1). Exceção: o trigger de
// presença (presence/onPresenceWritten.ts) fica em us-central1, a região da
// instância do Realtime Database, que não existe em São Paulo.
//
// `maxInstances` limita quantas instâncias uma Function pode escalar: teto
// de custo caso um bug (ex: trigger em loop) dispare chamadas demais.
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });
