import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Inicializa uma única vez por instância - cada arquivo de Function importa
// daqui em vez de chamar initializeApp() por conta própria.
if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export const auth = getAuth();
// Funções, não instâncias: só a exclusão de conta usa Storage e RTDB pelo
// Admin SDK, e as outras não precisam pagar a inicialização no cold start.
export const storage = () => getStorage();
export const rtdb = () => getDatabase();
