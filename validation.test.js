import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeE164, normalizeBody, isAuthorized, parseDateRange, parseAllowedRecipients } from '../src/validation.js';

test('normalizes US numbers and global E.164', () => {
  assert.equal(normalizeE164('(210) 555-0123'), '+12105550123');
  assert.equal(normalizeE164('+44 20 7946 0123'), '+442079460123');
  assert.equal(normalizeE164('abc'), null);
  assert.equal(normalizeE164('+0000000'), null);
});
test('rejects invalid body and keeps whitespace within text', () => {
  assert.equal(normalizeBody('  hello there  '), 'hello there');
  assert.equal(normalizeBody('    '), null);
  assert.equal(normalizeBody('x'.repeat(1201)), null);
});
test('bearer token authentication', () => {
  assert.equal(isAuthorized('Bearer strong-secret-123', 'strong-secret-123'), true);
  assert.equal(isAuthorized('Bearer strong-secret-124', 'strong-secret-123'), false);
  assert.equal(isAuthorized('Basic strong-secret-123', 'strong-secret-123'), false);
});
test('date boundaries are valid', () => {
  assert.deepEqual(parseDateRange('2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
    ['2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z']);
  assert.equal(parseDateRange('2026-10-20T00:00:00Z', '2026-10-19T00:00:00Z'), null);
  assert.equal(parseDateRange('bad', 'bad'), null);
});
test('recipient allowlist normalizes numbers', () => {
  assert.ok(parseAllowedRecipients('(210) 555-0123, +12105550124').has('+12105550123'));
});
