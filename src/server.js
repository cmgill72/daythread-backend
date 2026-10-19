import express from 'express';
import twilio from 'twilio';
import { createDatabase } from './db.js';
import { createPushSender } from './push.js';
import { isAuthorized, normalizeE164, normalizeBody, parseAllowedRecipients,
  parseDateRange, parseMessageIds, parseDeviceRegistration } from './validation.js';

const env = process.env;
const required = ['DATABASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'PUBLIC_BASE_URL', 'DAYTHREAD_APP_TOKEN', 'ALLOWED_RECIPIENTS'];
const missing = required.filter(name => !env[name]);
if (missing.length) { console.error('Missing required environment variables:', missing.join(', ')); process.exit(1); }

const fromNumber = normalizeE164(env.TWILIO_FROM_NUMBER);
const allowedRecipients = parseAllowedRecipients(env.ALLOWED_RECIPIENTS);
const trialMode = env.DAYTHREAD_TRIAL_MODE === 'true';
const baseURL = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
if (!fromNumber || !baseURL.startsWith('https://') || !allowedRecipients.size || env.DAYTHREAD_APP_TOKEN.length < 32) {
  console.error('Invalid configuration: requires E.164 sender/allowlist, HTTPS URL, token >=32 chars.'); process.exit(1);
}

let sendPush = null;
try { sendPush = createPushSender(env); } catch (e) { console.error('APNs disabled:', e.message); }
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const db = createDatabase(env.DATABASE_URL);
const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

function requireTwilio(req, res, next) {
  const signature = req.get('X-Twilio-Signature') || '';
  const url = `${baseURL}${req.originalUrl}`;
  if (!twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, req.body || {})) return res.status(403).send('Forbidden');
  next();
}

async function notifyDevices() {
  if (!sendPush) return;
  try {
    const devices = await db.listPushTokens();
    await Promise.all(devices.map(async ({ token, environment }) => {
      try {
        const result = await sendPush(token, environment);
        if (result.status === 410 || result.reason === 'BadDeviceToken' || result.reason === 'Unregistered') {
          await db.deletePushToken(token);
        } else if (result.status !== 200) {
          console.error('APNs rejected notification:', result.status, result.reason);
        }
      } catch (error) { console.error('APNs delivery failed:', error.name); }
    }));
  } catch (error) { console.error('Push lookup failed:', error.name); }
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'daythread', version: '0.2.0' }));

app.post('/webhooks/twilio/incoming', express.urlencoded({ extended: false, limit: '64kb' }), requireTwilio, async (req, res) => {
  try {
    const sender = normalizeE164(req.body.From);
    const destination = normalizeE164(req.body.To);
    const sid = typeof req.body.MessageSid === 'string' ? req.body.MessageSid : null;
    const mediaCount = Math.max(0, Math.min(99, Number.parseInt(req.body.NumMedia || '0', 10) || 0));
    if (!sender || destination !== fromNumber || !sid) return res.status(400).send('Invalid message');
    const body = String(req.body.Body || '').slice(0, 16000) || (mediaCount ? '📎 Media received (attachments not supported)' : '[Empty message]');
    const inserted = await db.insertMessage({ provider_sid: sid, direction: 'inbound', peer: sender,
      from_number: sender, to_number: destination, body, status: 'received', media_count: mediaCount });
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    if (inserted) void notifyDevices(); // APNs must never hold up the Twilio webhook response.
  } catch (error) {
    console.error('Incoming webhook failed:', error.name);
    res.status(500).send('Unable to save message');
  }
});

app.post('/webhooks/twilio/status', express.urlencoded({ extended: false, limit: '16kb' }), requireTwilio, async (req, res) => {
  try {
    const sid = typeof req.body.MessageSid === 'string' ? req.body.MessageSid : '';
    const status = typeof req.body.MessageStatus === 'string' ? req.body.MessageStatus : '';
    const supported = new Set(['queued', 'accepted', 'scheduled', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'canceled', 'read']);
    if (sid && supported.has(status)) await db.recordStatus(sid, status);
    res.status(204).end();
  } catch (error) { console.error('Status webhook failed:', error.name); res.status(500).end(); }
});

app.use('/v1', express.json({ limit: '48kb' }), (req, res, next) => {
  if (!isAuthorized(req.get('Authorization'), env.DAYTHREAD_APP_TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/v1/messages', async (req, res) => {
  try {
    const range = parseDateRange(req.query.from, req.query.to);
    if (!range) return res.status(400).json({ error: 'Provide valid from/to ISO dates, max 48 hours.' });
    const result = await db.listMessages(...range);
    res.json({ ...result, unreadCount: await db.unreadCount() });
  } catch (error) { console.error('List messages failed:', error.name); res.status(500).json({ error: 'Unable to load messages.' }); }
});

app.post('/v1/messages/read', async (req, res) => {
  const ids = parseMessageIds(req.body?.messageIds);
  if (!ids) return res.status(400).json({ error: 'Provide 1–500 valid messageIds.' });
  try {
    const marked = await db.markRead(ids);
    res.json({ marked, unreadCount: await db.unreadCount() });
  } catch (error) { console.error('Mark read failed:', error.name); res.status(500).json({ error: 'Unable to mark read.' }); }
});

app.post('/v1/devices', async (req, res) => {
  if (!sendPush) return res.status(503).json({ error: 'Push notifications are not yet enabled on this backend. Foreground refresh works without them.' });
  const registration = parseDeviceRegistration(req.body);
  if (!registration) return res.status(400).json({ error: 'Invalid APNs device registration.' });
  try { await db.registerPushToken(registration.token, registration.environment); res.status(204).end(); }
  catch (error) { console.error('Device registration failed:', error.name); res.status(500).json({ error: 'Registration failed.' }); }
});

app.delete('/v1/devices', async (req, res) => {
  const registration = parseDeviceRegistration(req.body);
  if (!registration) return res.status(400).json({ error: 'Invalid APNs device registration.' });
  try { await db.deletePushToken(registration.token); res.status(204).end(); }
  catch (error) { console.error('Device unregistration failed:', error.name); res.status(500).json({ error: 'Unregistration failed.' }); }
});

const recentSends = [];
app.post('/v1/messages', async (req, res) => {
  const destination = normalizeE164(req.body?.to);
  const body = normalizeBody(req.body?.body);
  if (!destination || !body) return res.status(400).json({ error: 'Provide an E.164 phone number and a message (1–1200 characters).' });
  if (trialMode) return res.status(409).json({ error: 'Twilio trial mode: incoming SMS works, but free-form replies are blocked. Upgrade/register before switching DAYTHREAD_TRIAL_MODE=false.' });
  if (destination === fromNumber) return res.status(400).json({ error: 'Cannot send to DayThread number.' });
  if (!allowedRecipients.has(destination)) return res.status(403).json({ error: 'Recipient not on approved test list.' });
  const now = Date.now();
  while (recentSends.length && recentSends[0] < now - 3600000) recentSends.shift();
  if (recentSends.length >= 30) return res.status(429).json({ error: 'Hourly safety limit reached (30 sends).' });
  recentSends.push(now);
  try {
    const sent = await client.messages.create({ from: fromNumber, to: destination, body,
      statusCallback: `${baseURL}/webhooks/twilio/status` });
    await db.insertMessage({ provider_sid: sent.sid, direction: 'outbound', peer: destination,
      from_number: fromNumber, to_number: destination, body, status: sent.status || 'accepted' });
    const message = await db.getMessageBySID(sent.sid);
    res.status(201).json({ message });
  } catch (error) {
    console.error('Send failed:', error.code || error.name);
    res.status(502).json({ error: 'Send or save failed. Check Twilio before retrying to avoid duplicates.' });
  }
});

app.use((error, _req, res, _next) => { console.error('Request rejected:', error.name); res.status(400).json({ error: 'Invalid request.' }); });

try {
  await db.initialize();
  const port = Number.parseInt(env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => console.log(`DayThread v0.2 backend listening on port ${port}`));
} catch (error) { console.error('Database initialization failed:', error.name); process.exit(1); }
