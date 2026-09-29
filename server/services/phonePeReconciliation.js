import { enqueueCriticalJob, safeJobId } from '../utils/jobQueue.js';

const PHONEPE_RECONCILIATION_QUEUE = 'payments';
const PHONEPE_TOKEN_ORDER_JOB = 'phonepe-token-order-reconcile';
const PHONEPE_PRODUCT_ORDER_JOB = 'phonepe-product-order-reconcile';
const PHONEPE_TERMINAL_FAILURE_STATES = new Set([
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'EXPIRED',
  'TIMEOUT',
  'TIMED_OUT'
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function phonePeReconciliationJobSpec(kind, merchantOrderId, env = process.env) {
  const normalizedId = String(merchantOrderId || '').trim();
  if (!normalizedId) throw new Error('merchantOrderId is required for PhonePe reconciliation');
  if (!['token-order', 'product-order'].includes(kind)) throw new Error(`Unsupported PhonePe reconciliation kind: ${kind}`);

  const attempts = boundedInteger(env.PHONEPE_SHORT_POLL_ATTEMPTS, 6, 1, 100);
  const intervalMs = boundedInteger(env.PHONEPE_SHORT_POLL_MS, 5000, 250, 300_000);
  const jobName = kind === 'token-order' ? PHONEPE_TOKEN_ORDER_JOB : PHONEPE_PRODUCT_ORDER_JOB;

  return {
    queueName: PHONEPE_RECONCILIATION_QUEUE,
    jobName,
    data: { merchantOrderId: normalizedId },
    options: {
      jobId: safeJobId('phonepe', kind, 'reconcile', normalizedId),
      attempts,
      delay: intervalMs,
      backoff: { type: 'fixed', delay: intervalMs }
    }
  };
}

async function enqueuePhonePeReconciliation(kind, merchantOrderId, { enqueue = enqueueCriticalJob, env = process.env } = {}) {
  const spec = phonePeReconciliationJobSpec(kind, merchantOrderId, env);
  return enqueue(spec.queueName, spec.jobName, spec.data, spec.options);
}

function phonePeTerminalFailure(state) {
  return PHONEPE_TERMINAL_FAILURE_STATES.has(String(state || '').toUpperCase());
}

function pendingPhonePeReconciliationError(kind, state) {
  const error = new Error(`PhonePe ${kind} remains ${String(state || 'PENDING').toUpperCase()}`);
  error.code = 'PHONEPE_RECONCILIATION_PENDING';
  return error;
}

export {
  PHONEPE_PRODUCT_ORDER_JOB,
  PHONEPE_RECONCILIATION_QUEUE,
  PHONEPE_TOKEN_ORDER_JOB,
  enqueuePhonePeReconciliation,
  pendingPhonePeReconciliationError,
  phonePeReconciliationJobSpec,
  phonePeTerminalFailure
};
