# DayThread backend — v0.2.0

**Upgrade for the existing GitHub repository `daythread-backend` and the existing Render Web Service `https://daythread-backend.onrender.com`.**

> Do **not** create a second Render service, delete the database, change your Twilio number, or rotate working tokens merely to upgrade. The existing SMS inbound webhook remains `/webhooks/twilio/incoming`.

## What changed

- Adds `read_at` to the existing message table (safe additive PostgreSQL migration).
- Adds a read/unread API and global unread count; old received texts start as unread until manually marked read.
- Prevents duplicate inbound push notifications on Twilio webhook retries.
- Tracks outgoing statuses, including status callbacks received before the originating send is persisted.
- Optional Apple Push Notification service (APNs) for iPhone lock-screen alerts.
- Keeps the approved recipient list, Twilio signature validation, strict bearer-token access, outgoing hourly limit, and `DAYTHREAD_TRIAL_MODE=true` behavior.

## Repository update and Render redeployment

1. Unzip `DayThread_v0.2_Backend_For_daythread-backend.zip`.
2. Replace/add the **contents** at the root of your existing GitHub repository `daythread-backend`: `src/`, `test/`, `package.json`, `.env.example`, `README.md`, `render.yaml`, and `.gitignore`.
3. **Don't** upload any `.env`, actual token, Twilio Auth Token, or APNs `.p8` file.
4. Commit to `main` and let Render auto-deploy, or select **Manual Deploy → Deploy latest commit** on your existing web service.
5. Keep Root Directory **blank**, Node 20+, Build `npm install --omit=dev`, Start `npm start`, Health Check `/health`.
6. Existing Render variables stay the same. In particular:

```text
PUBLIC_BASE_URL=https://daythread-backend.onrender.com
DAYTHREAD_TRIAL_MODE=true
```

7. After deployment, visit `https://daythread-backend.onrender.com/health` and verify `"version":"0.2.0"`.
8. Confirm the existing Twilio inbound webhook still targets `https://daythread-backend.onrender.com/webhooks/twilio/incoming` with **POST**.
9. Send one new inbound SMS from your approved test iPhone, then refresh DayThread. Preserve your working database connection; old messages remain.

## New endpoints

All `/v1/` routes require `Authorization: Bearer <DAYTHREAD_APP_TOKEN>`.

- `GET /v1/messages?from=<ISO>&to=<ISO>` returns `{messages, hasMore, unreadCount}`. Each message also has `read_at` (null when unread).
- `POST /v1/messages/read` JSON `{"messageIds":["valid-uuid"]}` marks *inbound* messages read. Reading is an explicit button, not implied just by scrolling.
- `POST /v1/devices` JSON `{"token":"64+ hex chars", "environment":"sandbox"}` registers an APNs device; returns **503** if APNs is not configured.
- `DELETE /v1/devices` with the same JSON unregisters the device.
- `POST /v1/messages` and the two Twilio webhook paths retain their previous roles.

## OPTIONAL: background push alerts

**This section is optional.** Without APNs, DayThread v0.2 still loads and polls for new SMS while open. iOS does not allow reliable background polling, so background alerts require a push-enabled Apple Developer configuration.

1. In your paid Apple Developer team, enable **Push Notifications** for the app identifier `com.seegill.DayThread` (or your own bundle ID if you change it).
2. In Xcode Signing & Capabilities, confirm Push Notifications is enabled and the provisioning profile supports the `aps-environment` entitlement.
3. In Apple Developer → **Keys**, create an APNs Auth Key (.p8), and note its Key ID and your Apple Team ID.
4. In Render **Environment**, add:

| Name | Value |
|---|---|
| `APNS_TEAM_ID` | Your Apple Developer Team ID |
| `APNS_KEY_ID` | ID of the APNs authentication key |
| `APNS_BUNDLE_ID` | `com.seegill.DayThread` (must match the app's actual bundle ID) |
| `APNS_PRIVATE_KEY_BASE64` | Base64-encoded **contents** of your downloaded `.p8` key |

To base64-encode the `.p8` file on macOS without printing it in this chat:

```bash
base64 -i /path/to/AuthKey_XXXXXXXXXX.p8 | tr -d '\n' | pbcopy
```

Paste the copied value into **Render's Secret Environment** only. Never commit the `.p8` file or encoded value to GitHub. Redeploy Render; the optional push service enables automatically. In DayThread Settings, tap **Enable push notifications** and grant iOS permission. You must run the app on a **physical iPhone** with correct provisioning; simulator push behavior doesn't validate this flow. Debug builds send to APNs **sandbox**, release builds to APNs **production**.

Privacy: push payload contains only **“New SMS received”**; it never sends SMS text or contact information to Apple. APNs support is implemented but has **not** been validated against a live Apple developer account in this environment. On an APNs 410/BadDeviceToken response the registered device entry is removed.

## Trial safeguards

On a Twilio 30-day trial, keep `DAYTHREAD_TRIAL_MODE=true` on Render and **Twilio trial safeguards** enabled in the iPhone app. Incoming SMS, names, unread tracking, manual read, and foreground refresh can be tested. Custom outgoing replies are intentionally disabled. After Twilio upgrade and applicable U.S. carrier registrations, change both settings only when outbound texting is permitted.

## Tests

```sh
npm install
npm test
```

Tests validate configuration, E.164 normalization, read-marker UUID limits, APNs registration input, APNs key format and optional behavior. Database migrations and live Twilio/APNs end-to-end must be checked on Render/iPhone.

## Limitations

One-to-one SMS via a **separate** Twilio number; no Apple Messages database, iMessage, existing-number takeover, group-chat preservation, or attachment downloads. The unread count covers all inbound messages retained in this prototype database. This backend is a personal single-user prototype; before broader use add stronger per-device authentication, retention rules, abuse monitoring, request limiting across multiple server instances, and operational monitoring.
