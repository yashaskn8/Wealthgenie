export const GENIEPROOF_MAX_CASES_PER_USER = 25;
export const GENIEPROOF_RETENTION_DAYS = 90;
export const GENIEPROOF_RETENTION_MS = GENIEPROOF_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function getGenieProofExpiry(assessedAt) {
  return new Date(new Date(assessedAt).getTime() + GENIEPROOF_RETENTION_MS);
}
