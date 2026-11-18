import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';

/** Erro de validação: `details.reason` é o que o app usa para escolher a mensagem. */
export type SafetyErrorReason =
  | 'invalid_input'
  | 'self_target'
  | 'no_profile'
  | 'user_not_found'
  | 'target_not_found'
  | 'evidence_not_found'
  | 'rate_limited';

export const fail = (code: FunctionsErrorCode, reason: SafetyErrorReason, message: string) =>
  new HttpsError(code, message, { reason });

export { isId } from '../sessions/shared.js';
