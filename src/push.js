// Optional APNs delivery. If credentials aren't configured, inbound SMS still works normally.
import crypto from 'node:crypto';
import http2 from 'node:http2';

export function apnsConfigured(env) {
  return Boolean(env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY_BASE64 && env.APNS_BUNDLE_ID);
}

export function createPushSender(env) {
  if (!apnsConfigured(env)) return null;
  const key = Buffer.from(env.APNS_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  if (!key.includes('BEGIN PRIVATE KEY')) throw new Error('Invalid APNS_PRIVATE_KEY_BASE64; expected base64 of the .p8 file.');
  let jwt = '';
  let issuedAt = 0;
  const authorization = () => {
    const now = Math.floor(Date.now() / 1000);
    if (jwt && now - issuedAt < 45 * 60) return jwt;
    issuedAt = now;
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })).toString('base64url');
    const signed = `${head}.${payload}`;
    const sig = crypto.sign('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' });
    jwt = `${signed}.${sig.toString('base64url')}`;
    return jwt;
  };
  return async (token, environment) => {
    const host = environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const connection = http2.connect(host);
    // HTTP/2 sessions emit 'error' independently of stream errors; never let APNs crash the API.
    connection.on('error', () => {});
    const content = JSON.stringify({
      aps: { alert: { title: 'DayThread', body: 'New SMS received' }, sound: 'default', badge: 1 }
    });
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { connection.destroy(); reject(new Error('APNs timeout')); }, 9000);
        let status = 0;
        let response = '';
        const request = connection.request({
          ':method': 'POST', ':path': `/3/device/${token}`,
          authorization: `bearer ${authorization()}`,
          'apns-topic': env.APNS_BUNDLE_ID,
          'apns-push-type': 'alert', 'apns-priority': '10',
          'content-type': 'application/json'
        });
        request.setEncoding('utf8');
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { response += chunk; });
        request.on('end', () => {
          clearTimeout(timeout);
          let reason = '';
          try { reason = JSON.parse(response).reason || ''; } catch { /* empty on success */ }
          resolve({ status, reason });
        });
        request.on('error', err => { clearTimeout(timeout); reject(err); });
        connection.once('error', err => { clearTimeout(timeout); reject(err); });
        request.end(content);
      });
    } finally {
      connection.close();
    }
  };
}
