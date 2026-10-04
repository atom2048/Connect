export const DELIVERY_TERMINAL_STATUSES = new Set([
  'completed',
  'stale',
  'expired',
  'skipped',
  'permanent_failed',
]);

function timestampMs(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

export function providerStatusCode(value) {
  const raw = value?.statusCode
    ?? value?.status
    ?? value?.response?.statusCode
    ?? value?.response?.status
    ?? (typeof value?.code === 'number' ? value.code : 0);
  const code = Number(raw);
  return Number.isFinite(code) && code > 0 ? code : 0;
}

export function normalizeSecretValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function taskGenerationMatches(record, requestedTaskGeneration) {
  if (requestedTaskGeneration === null || requestedTaskGeneration === undefined) return true;
  return Number(record?.taskGeneration || 0) === Number(requestedTaskGeneration);
}

export function deliveryRecoveryEligible(record, now, { graceMs, leaseMarginMs }) {
  const status = record?.status;
  const timestamp = timestampMs(record?.lastAttemptAt || record?.updatedAt || record?.createdAt);
  const stale = timestamp > 0 && timestamp < now - graceMs;
  if (['pending', 'retryable_failed'].includes(status) && stale) return true;
  if (status === 'processing') {
    const lease = timestampMs(record?.leaseUntil);
    return lease > 0 && lease < now - leaseMarginMs;
  }
  return false;
}

export function flattenDeliveryQuerySnapshots(querySnapshots) {
  return querySnapshots.flatMap(querySnapshot => querySnapshot?.docs || []);
}
