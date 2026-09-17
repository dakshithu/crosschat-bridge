# Setup Guide — Discord ⇄ Zoom Bridge on GitHub Actions

## ⚠️ Important: this must be a PUBLIC repo to stay free

GitHub Actions gives you **unlimited minutes on public repositories**, but only
**2,000 minutes/month on private repositories**. Running this ~24/7 uses
roughly 43,000+ minutes/month — way over the private free tier. So:

- Repo **code** must be public (no secrets live in the code — see below).
- Your **secrets** (bot token, webhook URLs) stay private regardless, stored
  as encrypted GitHub Secrets, never visible in the repo or logs.
- Anyone could technically see that a "Discord-Zoom Bridge" workflow exists
  and runs on a schedule, but not what it sends or your tokens.

If you're not comfortable with a public repo, the only reliable alternative
is a paid VPS (~€4-5/mo on Hetzner).

## 0. Rotate your old secrets first

The bot token, Discord webhook, and Zoom webhook that were in your original
file were exposed. Before doing anything else:

1. Discord Developer Portal → your bot → **Reset Token**
2. Delete and recreate the Discord webhook in the channel's Integrations settings
3. Delete and recreate the Zoom incoming webhook in the Zoom Team Chat app config

Use the **new** values everywhere below.

## 1. Create the GitHub repo

1. Create a new **public** repo on GitHub, e.g. `crosschat-bridge`.
2. Push these files to it (`index.js`, `package.json`, `.gitignore`,
   `.env.example`, `.github/workflows/bridge.yml`).

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/crosschat-bridge.git
git push -u origin main
```

## 2. Generate the initial Zoom login session (auth.json)

This has to be done once, locally, with a real browser window, since Zoom
login can't be automated headlessly (2FA, captchas, etc.).

1. On your own computer: `git clone` the repo, `npm install`,
   `npx playwright install chromium`.
2. Copy `.env.example` to `.env` and fill in your **new** rotated values.
   Leave `IS_HEADLESS=false`.
3. Run `node index.js`. A real browser window opens — log into Zoom manually
   in it. Once you're in the chat and messages are flowing, leave it running
   for a minute, then stop it with Ctrl+C (this saves `auth.json`).
4. Base64-encode the resulting `auth.json`:
   - Mac/Linux: `base64 -i auth.json | tr -d '\n' > auth.b64`
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("auth.json")) | Out-File auth.b64`

## 3. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add each of these:

| Secret name | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | your new bot token |
| `DISCORD_CHANNEL_ID` | the Discord channel ID |
| `DISCORD_WEBHOOK_URL` | your new Discord webhook URL |
| `ZOOM_INVITE_URL` | the Zoom chat invite URL |
| `ZOOM_VERIFICATION_TOKEN` | the Zoom verification token |
| `ZOOM_INCOMING_WEBHOOK_URL_RAW` | your new Zoom incoming webhook URL |
| `ZOOM_AUTH_STATE_B64` | contents of `auth.b64` from step 2 |

## 4. Run it

Go to the **Actions** tab → "Discord-Zoom Bridge" workflow → **Run workflow**
(this is the `workflow_dispatch` trigger, for a manual first test). Watch the
logs to confirm it launches, logs into Zoom using the saved session, and
relays messages both ways.

Once that works, it will run automatically every 5 hours from then on via
the `cron` schedule — each run picks up the previous run's saved session
from the GitHub Actions cache, so you generally won't need to repeat step 2.

## Ongoing maintenance — realistic expectations

- **Zoom sessions can still expire** (password change, security policy,
  long inactivity). If the bridge starts failing to find the chat, redo
  step 2 and update `ZOOM_AUTH_STATE_B64` — this is the "once in a while"
  manual touch you signed up for.
- **Scheduled cron runs are not exact-to-the-minute** on GitHub — expect
  a few minutes of drift, occasionally more during high load on GitHub's
  side. There may be a short gap in coverage between one run ending and
  the next starting.
- **If Zoom changes their Team Chat web UI**, the DOM-scraping selectors in
  `index.js` (the `_chatMessage_` class names, etc.) may break and need
  updating — same risk that existed running this anywhere else.
