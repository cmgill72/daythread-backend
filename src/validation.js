import crypto from 'node:crypto';

export function normalizeE164(number) {
  if (typeof number !== 'string') return null;
  const cleaned = number.replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  // Convenience for US numbers; do not guess country codes for other formats.
  if (/^\d{10}$/.test(cleaned)) return '+1' + cleaned;
  if (/^1\d{10}$/.test(cleaned)) return '+' + cleaned;
  return null;
}

export function normalizeBody(body) {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length <= 1200 ? trimmed : null;
}

export function isAuthorized(header, expectedToken) {
  if (!expectedToken || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const incoming = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return incoming.length === expected.length && crypto.timingSafeEqual(incoming, expected);
}

export function parseDateRange(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const duration = end - start;
  if (duration <= 0 || duration > 48 * 60 * 60 * 1000) return null;
  return [start.toISOString(), end.toISOString()];
}

export function parseAllowedRecipients(value) {
  return new Set((value || '').split(',').map(v => normalizeE164(v)).filter(Boolean));
}
