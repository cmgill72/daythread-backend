# DayThread Backend v0.1.1 — Twilio Trial

This repository contains only the **DayThread backend**. It runs on Render, stores messages in Postgres, and accepts validated Twilio SMS webhooks. The iPhone Xcode app is distributed separately.

## Repository layout

- `package.json` — Node 20+ backend
- `src/server.js` — REST endpoints and verified Twilio webhooks
- `src/db.js` — PostgreSQL schema and storage
- `src/validation.js` — validation helpers
- `test/` — validation tests
- `render.yaml` — optional Render Blueprint; backend commands run from repository root
- `.env.example` — config names only; **do not commit a populated `.env`**

## Render deployment

**If using New → Blueprint:** connect this `daythread-backend` repository to Render; its root-level `render.yaml` creates `daythread-api` and `daythread-db`. Review the Render plan and database charges before confirmation.

**If using an existing Render Web Service instead:** GitHub repo `daythread-backend`, **Root Directory blank**, runtime Node, Build `npm install --omit=dev`, Start `npm start`, Health Check `/health`. You also need a PostgreSQL database and must set `DATABASE_URL` manually for this route.

Set these environment variables in the Render dashboard; never commit secrets:

- `DATABASE_URL` — Render PostgreSQL internal connection string (automatically wired when using Blueprint).
- `TWILIO_ACCOUNT_SID` — from Twilio console.
- `TWILIO_AUTH_TOKEN` — from Twilio console (secret).
- `TWILIO_FROM_NUMBER` — actual Twilio trial or purchased SMS number in E.164 format.
- `PUBLIC_BASE_URL` — your exact public HTTPS Render URL, **without trailing slash**.
- `DAYTHREAD_APP_TOKEN` — 64-character random secret generated with `openssl rand -hex 32`; enter this in the iPhone app Settings, never in Git.
- `ALLOWED_RECIPIENTS` — comma-separated consenting test numbers in E.164 format; required even in trial mode.
- `DAYTHREAD_TRIAL_MODE=true` — disallows free-form outbound sends during the 30-day trial.

Visit `https://<your-render-service>/health` after deployment; expect a small JSON response with `status: ok`.

## Twilio inbound webhook

In Twilio's SMS inbound configuration, set HTTP POST to:

`https://<your-render-service>/webhooks/twilio/incoming`

The backend verifies Twilio's request signature. The publicly configured base URL must match the Twilio callback host and scheme.

For testing, send an SMS to the Twilio-managed number from an allowed/verified test handset. During trial mode the inbound message can be displayed in DayThread, but the custom reply API returns a 409 instead of sending.

## Local validation

```sh
npm install
npm test
```

For full instructions and the iOS app, use the companion `DayThread_v0.1.1_Twilio_Trial_Ready.zip` package.
