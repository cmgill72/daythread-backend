import 'node:process';
import express from 'express';
import twilio from 'twilio';
import { createDatabase } from './db.js';
import { isAuthorized, normalizeE164, normalizeBody, parseAllowedRecipients, parseDateRange } from './validation.js';

const env = process.env;
const required = ['DATABASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'PUBLIC_BASE_URL', 'DAYTHREAD_APP_TOKEN', 'ALLOWED_RECIPIENTS'];
const missing = required.filter(name => !env[name]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const fromNumber = normalizeE164(env.TWILIO_FROM_NUMBER);
const allowedRecipients = parseAllowedRecipients(env.ALLOWED_RECIPIENTS);
const baseURL = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
if (!fromNumber || !baseURL.startsWith('https://') || !allowedRecipients.size || env.DAYTHREAD_APP_TOKEN.length < 32) {
  console.error('Invalid configuration: requires valid E.164 sender/allowlist, HTTPS public origin, and app token of at least 32 characters.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const db = createDatabase(env.DATABASE_URL);
const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

// Verify Twilio signatures against the exact publicly configured URL.
function requireTwilio(req, res, next) {
  const signature = req.get('X-Twilio-Signature') || '';
  const expectedURL = `${baseURL}${req.originalUrl}`;
  const valid = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, expectedURL, req.body || {});
  if (!valid) return res.status(403).send('Forbidden');
  next();
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'daythread', version: '0.1.0' }));

app.post('/webhooks/twilio/incoming', express.urlencoded({ extended: false, limit: '64kb' }), requireTwilio, async (req, res) => {
  try {
    const sender = normalizeE164(req.body.From);
    const destination = normalizeE164(req.body.To);
    const sid = typeof req.body.MessageSid === 'string' ? req.body.MessageSid : null;
    const mediaCount = Math.max(0, Math.min(99, Number.parseInt(req.body.NumMedia || '0', 10) || 0));
    if (!sender || destination !== fromNumber || !sid) return res.status(400).send('Invalid message');
    const body = String(req.body.Body || '').slice(0, 16000) || (mediaCount ? '📎 Media received (attachments not supported in v0.1)' : '[Empty message]');
    await db.insertMessage({ provider_sid: sid, direction: 'inbound', peer: sender,
      from_number: sender, to_number: destination, body, status: 'received', media_count: mediaCount });
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
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
    if (sid && supported.has(status)) await db.updateStatus(sid, status);
    res.status(204).end();
  } catch (error) {
    console.error('Status webhook failed:', error.name);
    res.status(500).end();
  }
});

app.use('/v1', express.json({ limit: '16kb' }), (req, res, next) => {
  if (!isAuthorized(req.get('Authorization'), env.DAYTHREAD_APP_TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/v1/messages', async (req, res) => {
  try {
    const range = parseDateRange(req.query.from, req.query.to);
    if (!range) return res.status(400).json({ error: 'Provide a valid from/to ISO date range up to 48 hours.' });
    res.json(await db.listMessages(...range));
  } catch (error) {
    console.error('List messages failed:', error.name);
    res.status(500).json({ error: 'Unable to load messages.' });
  }
});

// Simple in-process cost guard for a single-user prototype. For production, use persistent limits.
const recentSends = [];
app.post('/v1/messages', async (req, res) => {
  const destination = normalizeE164(req.body?.to);
  const body = normalizeBody(req.body?.body);
  if (!destination || !body) return res.status(400).json({ error: 'Provide an E.164 phone number and a message (1–1200 characters).' });
  if (destination === fromNumber) return res.status(400).json({ error: 'Cannot send to the DayThread number itself.' });
  if (!allowedRecipients.has(destination)) return res.status(403).json({ error: 'Recipient is not on your approved test list.' });
  const now = Date.now();
  while (recentSends.length && recentSends[0] < now - 3600000) recentSends.shift();
  if (recentSends.length >= 30) return res.status(429).json({ error: 'Hourly safety limit reached (30 outgoing messages).' });
  recentSends.push(now);
  try {
    const sent = await client.messages.create({ from: fromNumber, to: destination, body,
      statusCallback: `${baseURL}/webhooks/twilio/status` });
    const message = await db.insertMessage({ provider_sid: sent.sid, direction: 'outbound', peer: destination,
      from_number: fromNumber, to_number: destination, body, status: sent.status || 'accepted' });
    res.status(201).json({ message });
  } catch (error) {
    console.error('Send failed:', error.code || error.name);
    // Avoid recording a false failure if Twilio accepted a message before a DB error.
    res.status(502).json({ error: 'Send or save failed. Check Twilio before retrying to avoid duplicates.' });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Request rejected:', error.name);
  res.status(400).json({ error: 'Invalid request.' });
});

try {
  await db.initialize();
  const port = Number.parseInt(env.PORT || '3000', 10);
  app.listen(port, '0.0.0.0', () => console.log(`DayThread backend listening on port ${port}`));
} catch (error) {
  console.error('Database initialization failed:', error.name);
  process.exit(1);
}
