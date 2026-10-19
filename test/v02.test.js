import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseMessageIds, parseDeviceRegistration } from '../src/validation.js';
import { apnsConfigured, createPushSender } from '../src/push.js';

const u1 = 'a1b2c3d4-12ab-4abc-8abc-112233445566';
const u2 = 'a1b2c3d4-12ab-4abc-8abc-112233445567';
test('read marker input accepts UUIDs and deduplicates', () => {
  assert.deepEqual(parseMessageIds([u1,u1,u2]), [u1,u2]);
  assert.equal(parseMessageIds([]), null);
  assert.equal(parseMessageIds(['not-a-uuid']), null);
  assert.equal(parseMessageIds(Array(501).fill(u1)), null);
});
test('push registration rejects bad tokens and environments', () => {
  const token = 'abcd'.repeat(16);
  assert.deepEqual(parseDeviceRegistration({token, environment:'sandbox'}), {token, environment:'sandbox'});
  assert.equal(parseDeviceRegistration({token:'abc', environment:'sandbox'}), null);
  assert.equal(parseDeviceRegistration({token, environment:'other'}), null);
});
test('push remains optional when no APNs configuration exists', () => {
  assert.equal(apnsConfigured({}), false);
  assert.equal(createPushSender({}), null);
});
test('APNs key format validated on startup', () => {
  const env = { APNS_TEAM_ID:'TEAM123456', APNS_KEY_ID:'KEY123456',
    APNS_PRIVATE_KEY_BASE64:Buffer.from('not a key').toString('base64'), APNS_BUNDLE_ID:'com.seegill.DayThread' };
  assert.throws(() => createPushSender(env), /Invalid APNS_PRIVATE_KEY_BASE64/);
});
test('valid P8 private keys are accepted for APNs signing', () => {
  const {privateKey} = crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1'});
  const env = { APNS_TEAM_ID:'TEAM123456', APNS_KEY_ID:'KEY123456',
    APNS_PRIVATE_KEY_BASE64:Buffer.from(privateKey.export({format:'pem', type:'pkcs8'})).toString('base64'),
    APNS_BUNDLE_ID:'com.seegill.DayThread' };
  assert.equal(typeof createPushSender(env), 'function');
});
