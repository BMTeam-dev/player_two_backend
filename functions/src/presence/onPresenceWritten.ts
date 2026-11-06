import { Timestamp } from 'firebase-admin/firestore';
import { onValueWritten } from 'firebase-functions/v2/database';
import { db } from '../lib/admin.js';
import type { Presence } from '../types.js';
import { mirrorPresence } from './mirror.js';

// us-central1, não southamerica-east1 como o resto: o trigger do RTDB precisa
// ficar na região da instância, e não há Realtime Database em São Paulo. Sem
// `instance`, vale para todas as instâncias do projeto (só existe a padrão,
// e assim o mesmo código roda no emulador).
export const onPresenceWritten = onValueWritten(
  { ref: '/status/{uid}', region: 'us-central1' },
  async event => {
    const presence = event.data.after.exists() ? (event.data.after.val() as Presence) : null;
    await mirrorPresence(db, event.params.uid, presence, Timestamp.now());
  },
);
