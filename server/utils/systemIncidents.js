import { createHash } from 'node:crypto';
import SystemIncident from '../models/SystemIncident.js';

function cleanText(value, maxLength = 800) {
  return String(value || '')
    .replace(/\b([a-z0-9_-]*(?:authorization|password|secret|api[_-]?key|token|key))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, (url) => url.split('?')[0])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function incidentFingerprint({ service, kind, title }) {
  return createHash('sha256')
    .update([service, kind, title].map((value) => cleanText(value, 180).toLowerCase()).join('|'))
    .digest('hex');
}

async function recordSystemIncident(entry = {}) {
  if (SystemIncident.db?.readyState !== 1) return null;
  const now = new Date();
  const fingerprint = entry.fingerprint || incidentFingerprint(entry);
  try {
    return await SystemIncident.findOneAndUpdate(
      { fingerprint },
      {
        $setOnInsert: { fingerprint, firstSeenAt: now },
        $set: {
          service: cleanText(entry.service || 'api', 80),
          kind: cleanText(entry.kind || 'unknown', 80),
          severity: ['info', 'warning', 'critical'].includes(entry.severity) ? entry.severity : 'warning',
          status: 'open',
          title: cleanText(entry.title || 'System failure', 180),
          message: cleanText(entry.message, 800),
          lastSeenAt: now,
          resolvedAt: null,
          metadata: entry.metadata || undefined
        },
        $inc: { occurrences: 1 }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    console.warn('[system-incidents] could not record incident', error?.message || error);
    return null;
  }
}

async function resolveSystemIncident(entry = {}) {
  if (SystemIncident.db?.readyState !== 1) return null;
  const fingerprint = entry.fingerprint || incidentFingerprint(entry);
  return SystemIncident.findOneAndUpdate(
    { fingerprint, status: { $ne: 'resolved' } },
    { $set: { status: 'resolved', resolvedAt: new Date() } },
    { new: true }
  ).catch(() => null);
}

export { cleanText, incidentFingerprint, recordSystemIncident, resolveSystemIncident };
