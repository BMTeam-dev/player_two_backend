import { setGlobalOptions } from 'firebase-functions/v2';

// Mesma região do Firestore (southamerica-east1). Exceção futura: o trigger
// de presença precisa ficar na região da instância do Realtime Database,
// que não existe em São Paulo - ver MVP.md, seção 7.2.
//
// `maxInstances` limita quantas instâncias uma Function pode escalar: teto
// de custo caso um bug (ex: trigger em loop) dispare chamadas demais.
setGlobalOptions({ region: 'southamerica-east1', maxInstances: 10 });

// As Functions entram aqui bloco a bloco (TASKS.md). Ex., no Bloco 1:
// export { completeOnboarding } from './users/completeOnboarding.js';
