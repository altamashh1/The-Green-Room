# The Green Room — AI Interview Practice Platform

A full-stack web app that runs realistic, voice-enabled mock interviews using
Google Gemini, scores each round, and tracks a user's practice history over time.

## Features

- **Account system** — signup / login with bcrypt-hashed passwords and JWT sessions (7-day expiry). Expired or invalid tokens drop you back to the login screen automatically.
- **Adaptive, AI-generated questions** — the interviewer asks one question at a time and decides live, based on your last answer, whether to ask a brief follow-up or move to a new topic. Nothing is pre-scripted.
- **Voice interaction** — questions are read aloud (Web Speech Synthesis) and answers are transcribed as you speak (Web Speech Recognition). Full keyboard fallback when speech APIs aren't available.
- **Timed answers with a review step** — 80 seconds to answer each question, then a 30-second window to read back and **edit the transcription** before it's submitted. A long pause ends the answer early.
- **End interview anytime** — stop the round early and still get feedback on everything answered so far.
- **AI-scored feedback** — Gemini scores the round 1–10 with a per-question strength and a specific thing to sharpen. The score is clamped and the response shape is validated server-side.
- **Download as PDF** — export the feedback report through the browser's print / "Save as PDF" dialog.
- **Practice history dashboard** — every round is saved; scores are visible at a glance.
- **Admin panel** — accounts with the `admin` role get a `/api/admin/overview`-backed view: user and interview counts, average score, per-role breakdown, and recent users / sessions.
- **Model fallback chain** — if the primary Gemini model is rate-limited or out of quota (HTTP 429/404/403), the server automatically retries the next model in `GEMINI_MODEL` + `GEMINI_FALLBACK_MODELS`.
- **Responsive** — works down to phone widths.

## Architecture

```
┌─────────────┐        REST/JSON        ┌──────────────┐        ┌───────────────┐
│  Frontend   │  ───────────────────▶   │   Backend    │  ───▶  │  Gemini API   │
│ HTML/CSS/JS │  ◀───────────────────   │ Express + JWT│        │   (Google)    │
└─────────────┘                         └──────┬───────┘        └───────────────┘
                                                │
                                          ┌─────▼──────┐
                                          │  libSQL DB │
                                          │ file / Turso│
                                          │ users/sessions│
                                          └────────────┘
```

- **Frontend**: one vanilla HTML/CSS/JS file, no build step. Landing, auth, dashboard, setup, interview, feedback and admin screens are all stages in `index.html`. Served directly by the backend at `http://localhost:4000`.
- **Backend**: Node.js + Express — auth, the adaptive interview loop, feedback scoring, session persistence, and the admin overview. Holds the Gemini API key server-side. Sets basic security headers (CSP, `X-Frame-Options`, etc.) and rate-limits the auth and interview routes per IP.
- **Database**: libSQL via `@libsql/client`. Local dev uses a zero-config file (`backend/greenroom.db`); production points `DATABASE_URL`/`DATABASE_AUTH_TOKEN` at a hosted [Turso](https://turso.tech) database so data survives redeploys on ephemeral hosts like Render.
- **AI**: Google Gemini via the `generateContent` API. Defaults to `gemini-3.5-flash-lite` with a fallback chain.

Keeping the Gemini API key on the backend rather than in the browser is deliberate — it's how you'd do it in production.

## Project structure

```
green-room/
├── backend/
│   ├── server.js         # Express app: auth, interview, feedback, admin routes + libSQL setup
│   ├── package.json
│   └── .env.example      # copy to .env and fill in your values
├── frontend/
│   └── index.html        # entire frontend (single file, no build tools)
└── launcher/
    └── Start Green Room.bat   # one-click local launcher for Windows
```

## Setup

### Quick launch on Windows

Double-click [`launcher/Start Green Room.bat`](launcher/Start%20Green%20Room.bat). It
starts the local server and opens the app at `http://localhost:4000`. The first run
needs Node.js 18+ and installs the backend packages if they're missing. Keep the
**Green Room Server** window open while using the app.

Add your Gemini API key to `backend/.env` (copy `backend/.env.example` if needed) for
questions and feedback to work.

The local administrator account is created on first startup — sign in with
`admin@greenroom.local` / `admin1234`. Change `ADMIN_EMAIL` / `ADMIN_PASSWORD` in
`backend/.env` before deploying publicly.

### Manual setup

```bash
cd backend
npm install
cp .env.example .env      # then edit .env
npm start
```

`.env`:

```
PORT=4000
GEMINI_API_KEY=your_gemini_api_key_here
# Optional: primary model, defaults to gemini-3.5-flash-lite
GEMINI_MODEL=gemini-3.5-flash-lite
# Optional: tried in order when the primary is rate-limited / out of quota
GEMINI_FALLBACK_MODELS=gemini-2.0-flash-lite,gemini-2.0-flash
# Required in production; a random dev value is used otherwise
JWT_SECRET=replace_with_a_long_random_string
ADMIN_EMAIL=admin@greenroom.local
ADMIN_PASSWORD=change_this_before_deploying
# Optional, production only:
# NODE_ENV=production
# ALLOWED_ORIGIN=https://your-frontend.example.com
```

Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey). The
backend serves the frontend too, so open `http://localhost:4000` — no second server
needed. A `greenroom.db` file is created automatically on first run.

In production (`NODE_ENV=production`) the server refuses to start without a
`JWT_SECRET`, warns on the default admin password, and restricts CORS to
`ALLOWED_ORIGIN` when it's set.

For the full voice experience use Chrome or Edge. Other browsers fall back to typing.

## API reference

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | – | Create an account, returns a JWT |
| POST | `/api/auth/login` | – | Log in, returns a JWT |
| GET | `/api/me` | ✔ | Current user (read fresh from the DB) |
| POST | `/api/interview/start` | ✔ | Generate the opening warm-up question for a role/level |
| POST | `/api/interview/next` | ✔ | Given the transcript so far, decide the next turn — a follow-up or a new main question |
| POST | `/api/interview/feedback` | ✔ | Score a transcript and save the session |
| GET | `/api/sessions` | ✔ | List the current user's past sessions |
| GET | `/api/sessions/:id` | ✔ | Full detail of one of the user's sessions |
| GET | `/api/admin/overview` | ✔ admin | Platform stats + recent users and sessions |
| GET | `/api/health` | – | Liveness check |

## Deploying

- **Backend**: Render, Railway, Fly.io, or a small VPS. Set `GEMINI_API_KEY`, a strong `JWT_SECRET`, `NODE_ENV=production`, and `ALLOWED_ORIGIN`. Because the backend also serves the frontend, deploying the backend alone is enough.
- **Separate frontend host** (optional): any static host works. Set `API_BASE` near the top of the `<script>` in `index.html` to the deployed backend URL.
- **Database**: hosts like Render wipe the local filesystem on every deploy, so the SQLite file would reset. Create a free [Turso](https://turso.tech) database and set `DATABASE_URL` and `DATABASE_AUTH_TOKEN` in the backend environment — the schema is created automatically on first boot. Leave them unset for local development.

## Possible extensions

- Upload a resume (PDF) and have Gemini tailor questions to it
- Interview-type presets (behavioural / technical / system design) using the unused `sessions.type` column
- Score-trend chart on the dashboard and in the admin panel
- Review past sessions in the UI (`/api/sessions/:id` already exists)
- Automated tests around auth validation, the model-fallback logic, and transcript sanitisation
