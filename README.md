# Day Planner v2

A notes-driven day planner. Brain-dump your day (or paste an email/agenda), and it produces
a scheduled plan. A deterministic engine does all the placement so the output is trustworthy;
an AI layer only *orders* the tasks and interprets messy input. It works offline and gets
better when you plug in an AI key and a calendar.

This is the productionized version of the single-file prototype: real build, real persistence,
server-side API key, and real `.ics` calendar import/export.

## What's different from the prototype

- **Runs in any browser** — no sandbox APIs. Settings, templates, and your last plan persist
  via `localStorage` (see `src/storage.js`; swap it for a DB later without touching app code).
- **AI key stays on the server** — the browser calls `/api/plan` (a serverless function),
  which forwards to Anthropic using `ANTHROPIC_API_KEY`. No key ships to the client.
- **Real calendar import** — upload an `.ics` file exported from Google/Outlook/Apple Calendar.
  Events on the selected day are parsed with `ical.js`, recurring events are expanded, and times
  are converted to your local zone, then pinned to their exact times.
- **Graceful degradation** — with no backend/network, the app still works fully using the local
  planner and manual/`.ics`/paste input.

## Architecture

- `src/app.js` — state, UI, and the scheduling engine (parsing, the greedy timeline **packer**,
  `.ics` build). The packer guarantees no overlaps, nothing past the window, and nothing dropped.
- `src/api.js` — thin client for the `/api/plan` proxy; throws `noBackend` so the app can fall back.
- `src/storage.js` — `localStorage` adapter (get/set/list/delete).
- `api/plan.js` — serverless proxy holding the Anthropic key.
- The AI is **advisory**: it returns an ordering + interpreted tasks; JavaScript places them.

## Quick start (local, no AI needed)

```bash
npm install
npm run dev        # http://localhost:5173
```

Without a backend, planning uses the local engine. You can add tasks, paste notes, import `.ics`,
edit/reorder, and export `.ics`.

## Enable the AI

The AI ordering/interpretation needs the serverless function, which needs a key.

```bash
cp .env.example .env.local     # then paste your ANTHROPIC_API_KEY
npm i -g vercel                # once
vercel dev                     # runs the app AND /api/plan locally
```

`vite` alone does not run `/api/*`; use `vercel dev` (or `netlify dev`) for the API locally.

## Deploy (Vercel)

1. Push this folder to a Git repo and import it in Vercel (framework preset: **Vite**).
2. Project → Settings → Environment Variables: add `ANTHROPIC_API_KEY` (and optionally
   `ANTHROPIC_MODEL`).
3. Deploy. The static site is served from `dist/`; `api/plan.js` becomes a serverless function
   automatically. Netlify/Cloudflare work similarly (move the function to their format).

## Calendar import (works today, no credentials)

In "Already on your calendar" → **Import .ics file**. Export a day/week from your calendar app
as `.ics` and select it. Timed events on the chosen date are added, converted to your local time,
and pinned. This covers the common need without OAuth.

## Roadmap: live one-click calendar sync (needs your credentials)

Live read/write sync can't be shipped without your own OAuth app, because it needs client
IDs/secrets and registered redirect URIs. The structure is ready for it — add a couple of
serverless routes and store tokens per user. Outline:

**Google Calendar**
1. Google Cloud Console → OAuth consent screen + Credentials → OAuth client (Web).
   Scope: `https://www.googleapis.com/auth/calendar` (or `.readonly`).
2. Add `api/google/auth.js` (redirect to Google) and `api/google/callback.js` (exchange code
   for tokens; store refresh token per user).
3. Add `api/google/events.js` → `GET /calendar/v3/calendars/primary/events?timeMin&timeMax`
   with `Authorization: Bearer <access_token>`. Return events; the client already knows how to
   convert ISO timestamps to local time and pin them.

**Microsoft 365 / Outlook**
1. Azure Portal → App registrations → new app; add a Web redirect URI.
   Delegated Graph scope: `Calendars.Read` (or `Calendars.ReadWrite`).
2. `api/ms/auth.js` + `api/ms/callback.js` (MSAL or raw OAuth2 code flow).
3. `api/ms/events.js` → `GET https://graph.microsoft.com/v1.0/me/calendarView?startDateTime&endDateTime`
   with `Prefer: outlook.timezone="<IANA tz>"` and a bearer token.

For **write-back** ("add my plan to my calendar"), POST events to the same APIs instead of only
offering `.ics` download.

## Security notes

- The `/api/plan` proxy is intentionally minimal. Before real traffic: authenticate callers,
  add per-user rate limiting, and constrain prompts server-side so it can't be used as an open
  Anthropic relay. See the TODO in `api/plan.js`.
- Request the **minimum** calendar scopes, store tokens server-side only, and be explicit about
  data handling.

## Suggested next steps

- Accounts + a database (e.g. Supabase) so settings/templates/plans sync across devices;
  reimplement `src/storage.js` against it.
- Unit tests around the packer (`packSchedule`) and parsers — they're pure and highly testable.
- PWA wrapper + reminders/notifications; recurring "daily template" automation.

## Project structure

```
day-planner-v2/
  index.html
  vite.config.js  tailwind.config.js  postcss.config.js  vercel.json
  .env.example
  api/
    plan.js            # serverless Anthropic proxy
  src/
    app.js             # engine + UI + state
    api.js             # /api/plan client
    storage.js         # localStorage adapter
    style.css          # Tailwind + component styles
```
