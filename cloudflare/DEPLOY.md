# Pulse Cloudflare deployment (iPhone-friendly)

The existing Cloudflare Worker is named `pulse-notifications`. The Worker code lives at `cloudflare/pulse-notifications-worker.js`.

## Why this exists
Cloudflare's web code editor does not reliably accept pasted code on iPhone. GitHub Actions can deploy the code instead. **No deployment occurs automatically.**

## One-time setup
In the GitHub repository go to **Settings → Secrets and variables → Actions → New repository secret** and add:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID from the dashboard URL (do not put credentials in code).
- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with permissions to edit Workers scripts and the necessary account resources. Keep this token secret.
- `CLOUDFLARE_KV_NAMESPACE_ID`: the ID of the existing KV namespace `pulse-reminders`, shown on its Cloudflare namespace details page.

## Deploy
Open **GitHub → Actions → Deploy Pulse notifications to Cloudflare → Run workflow**. The workflow checks that all three secrets exist, then deploys to the existing `pulse-notifications` Worker.

## Current limitations
This is an early backend scaffold, **not a functioning reminder delivery system**. It can store subscriptions and reminder preferences, but it does not yet implement VAPID web push encryption, cron scheduling, or the client-side subscription flow. It must not be advertised as working notifications. Do not delete OneSignal or enable a new push subscription until the replacement has been implemented and tested.

The Worker expects KV binding `PULSE_REMINDERS`. Its `/health` endpoint reports `notificationsActive: false` until delivery is implemented.
