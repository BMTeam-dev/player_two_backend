import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from '../lib/admin.js';
import { deactivateListing as deactivate, parseListingInput, saveListing } from './listing.js';

function requireUid(auth: { uid: string } | undefined) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  return auth.uid;
}

export const upsertListing = onCall(async request => {
  const uid = requireUid(request.auth);
  return saveListing(db, uid, parseListingInput(request.data), Timestamp.now());
});

export const deactivateListing = onCall(async request => {
  const uid = requireUid(request.auth);
  const listingId = (request.data as { listingId?: unknown } | null)?.listingId;
  return deactivate(db, uid, listingId, Timestamp.now());
});
