# Halflight

A real anonymous-confession-matching web app. Real email/password accounts on the backend, but everyone picks their own anonymous name at signup — your email is never visible to other users, only the name you chose. Confessions are matched by keyword overlap in real time, and matched pairs land in a live chat room powered by Socket.IO. Every chat is saved, so you can log back in later, see your past conversations, and ask an old partner to reconnect.

This is a genuine Node.js server, not a static file — it needs to actually be running for anything to work.

## Run it on your own computer

You need [Node.js](https://nodejs.org) installed (version 18 or newer).

1. Open a terminal in this folder.
2. Install dependencies:
   ```
   npm install
   ```
   (This installs `better-sqlite3`, pinned to a version with prebuilt binaries for Node 20 and 22+. If you see build errors on install, upgrading Node usually fixes it.)
3. Start the server:
   ```
   npm start
   ```
4. Open **http://localhost:3000** in your browser.

To test matching yourself, open the site in two different browser tabs (or one normal + one incognito window), create two different accounts, and submit two confessions that share a few words (e.g. "I hate my job" / "I'm so tired of my job"). They'll match and drop both tabs into the same live chat.

Data (accounts, rooms, messages) is stored in a real SQLite database, `halflight.db`, created next to `server.js` on first run. Delete it (and its `-shm`/`-wal` sidecar files) any time to wipe everything and start fresh.

**This only works for people on the same computer/network as your terminal, unless you deploy it — see below.**

## Making your data survive redeploys — this is important, read before you deploy

I got this wrong before, so to correct it clearly: **on Render's free tier specifically, there is no way to make the filesystem persistent.** Free web services on Render always have an ephemeral filesystem — every redeploy, restart, or spin-down (which happens automatically after 15 minutes of no traffic) wipes it, and persistent disks are a paid-plan-only feature there. Setting `DB_PATH` alone changes nothing on Render's free tier — there's no persistent place to point it at. That's exactly why you kept losing accounts.

You have three real options:

**Option A — move hosting to Fly.io (stays free, no code changes needed)**
Fly.io's free allowance includes small persistent volumes, unlike Render's. This project already supports it via `DB_PATH` — you just need to attach a volume:
1. Install the Fly CLI and run `fly launch` in this folder (it detects Node automatically).
2. Create a volume: `fly volumes create halflight_data --size 1`
3. In `fly.toml`, add a mount for it, e.g.:
   ```toml
   [mounts]
     source = "halflight_data"
     destination = "/data"
   ```
4. Set env vars: `fly secrets set SESSION_SECRET=<random string> DB_PATH=/data/halflight.db ADMIN_EMAILS=you@example.com`
5. Deploy: `fly deploy`

**Option B — stay on Render, upgrade to Starter ($7/month)**
Starter and above support attaching a persistent Disk. Same `DB_PATH` setup as before — dashboard → your service → Disks tab → attach one mounted at `/data` → set `DB_PATH=/data/halflight.db` as an env var. Nothing in the code changes.

**Option C — keep Render free, but move the database off the local filesystem entirely**
Use Render's free PostgreSQL instead of a local SQLite file. The catch: Render's free Postgres **also expires 30 days after creation** and needs manual recreation, so it's not truly permanent either — more of a "resets monthly" tier than "resets on every deploy." A better free-forever option in this category is [Turso](https://turso.tech) (hosted SQLite-compatible, generous free tier, doesn't expire) or [Neon](https://neon.tech) (hosted Postgres, free tier doesn't expire). Either works with Render's free tier since the database itself lives outside Render. This requires real code changes — swapping `better-sqlite3`'s synchronous calls for an async client — which I haven't done here. Tell me if you want this and I'll do the migration.

**My recommendation: Option A.** It's free, keeps every line of code you already have, and just needs the volume + a couple of `fly secrets`.

For local development, none of this matters — leave `DB_PATH` unset and it behaves exactly as before.

## What's new

**You choose your own anonymous name.** At signup there's a "Pick your anonymous name" field with a live availability check (names must be 3-24 characters, unique, and are what everyone else sees in chat — never your email).

**Confessions are open rooms you can browse, not a black box.** This is the biggest change: submitting a confession no longer drops it into an invisible queue that might never match. Every confession is immediately posted as an **open room** anyone can see under **Browse**, with the full text and its keywords. Anyone else can read it and tap "Join this conversation" to jump straight into a live chat with whoever posted it — no algorithm required. Automatic keyword matching still runs in the background as a bonus (if two open confessions share 2+ strong keywords, their posters get paired instantly), but it's no longer the only way in, and nobody has to sit and wait for it.

**Confess as many times as you want.** No one-confession, one-room limit — submit as many as you like, each becomes its own open room, and you can be in several chat rooms at once. "My Chats" (top bar) lists everything: your confessions still open and waiting, active rooms, and ended ones. Opening an active room drops you straight into live chat; opening an ended one shows the transcript with an option to reconnect.

**You don't have to stare at a loading screen.** The searching screen has a "Browse other confessions" button — step away to read and join someone else's open confession, or submit another one, without losing your place. A small pulsing "Still searching…" indicator stays in the top bar so you don't forget, and if your own confession gets matched while you're elsewhere, you get a toast notification instead of being silently teleported.

**Better keyword matching.** Short, meaningful words (2+ characters — abbreviations, slang) now count toward matching instead of being filtered out for being too short; only true filler words (the, and, a, etc.) are excluded. Matching also considers more keywords per confession (up to 20) for better overlap detection.

**Typing indicator, reporting, and blocking.** You'll see "They're typing…" in live chats. A "Report" button in the chat header lets you flag a conversation to admins, with an optional "also stop matching me with this person again" checkbox.

**Unread badges.** My Chats shows a dot next to rooms with messages you haven't read yet.

**Optional browser notifications.** Tap the bell icon in the top bar to enable real OS-level notifications for new matches and reconnect requests when the tab isn't focused. Fully opt-in — nothing changes if you don't enable it.

**Stale open confessions expire automatically.** One that's been open for more than 6 hours with nobody joining gets cleared out server-side, so Browse doesn't fill up with abandoned posts.

**Admin access, with real visibility into how rooms formed and a way to step in.** Set an `ADMIN_EMAILS` environment variable (comma-separated) before starting the server, e.g.:
```
ADMIN_EMAILS=you@example.com npm start
```
Any account signing up or logging in with one of those emails gets an "Admin" link in the top bar, which opens:
- **All conversations** — every matched room on the site. Each one shows *both original confessions*, whether the pairing was automatic (keyword match) or manual (someone chose it from Browse), and which keywords overlapped if any.
- **Reply anonymously.** Admins can open any room and send a message into it, appearing under the admin's own anonymous name — same as any regular user's — so the two people in the room have no way of knowing it came from an admin.
- **Reports** — everything users have flagged, with a link straight into that room's transcript.

Regular users never see any of this; the Admin link only appears for accounts whose email matches `ADMIN_EMAILS`.

## Put it online for real (so anyone can use it)

You need actual hosting for a Node server with WebSockets. See "Making your data survive redeploys" above before picking one — it materially affects which host makes sense.

**Render.com**
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables: `SESSION_SECRET` (random string), `ADMIN_EMAILS` (your email), and `DB_PATH` only if you're on a paid plan with a Disk attached — see above.
5. Deploy — you'll get a real `https://your-app.onrender.com` link.

**Fly.io** — see Option A above; this is the one with a genuinely free persistent volume.

**Railway.app** works similarly to Render; its free tier is credit-based rather than permanently free, and also needs a paid plan for a persistent Volume.

Whichever you use, always set `SESSION_SECRET` to something private (don't reuse the default in `server.js`) — that's what keeps login sessions secure.

## What's real here vs. what to harden before going public

**Real:** account creation with hashed passwords, live server-side keyword matching across everyone currently waiting, actual WebSocket chat via Socket.IO, session-based login that survives refresh.

**Worth adding before real users show up:**
- SQLite (what this now uses) is genuinely solid for a good while — comfortably hundreds of concurrent users on modest hosting. If you outgrow a single server, that's when you'd move to Postgres.
- No rate limiting on signup/login or confession submission — add some before opening this up publicly.
- No password reset flow.
- No content moderation on confessions or chat messages — consider basic filtering or a report button if this goes public.
- Reconnect requests only work while both people are online at the same time (no stored/offline notifications yet) — worth adding if this matters to your users.
- Admin access is granted purely by email match against `ADMIN_EMAILS` — fine for a small trusted group, but add real role management before handing admin out widely.
- No HTTPS is set up here; hosting platforms like Render provide this automatically.
- See "Making your data survive redeploys" above before deploying — don't skip the `DB_PATH` + persistent disk step.
