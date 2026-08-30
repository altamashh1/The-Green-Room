# The Green Room — AI Interview Practice Platform

A full-stack web app that runs realistic, voice-enabled mock interviews using Google Gemini, scores each session, and tracks a user's practice history over time.

## Features

- **Account system** — signup/login with hashed passwords (bcrypt) and JWT sessions
- **Adaptive, AI-generated interview questions** tailored to role and seniority — the interviewer asks one question at a time and decides live, based on your answer, whether to ask a brief follow-up or move to a new topic, instead of reading from a fixed pre-written list
- **Voice interaction** — questions are read aloud (Web Speech Synthesis) and answers can be spoken (Web Speech Recognition), with text as a fallback
- **AI-scored feedback** — after each round, Gemini scores the session (1–10) and gives per-question strengths and areas to improve
- **Practice history dashboard** — every session is saved to a database, so users can track progress across rounds

## Architecture

```
┌─────────────┐        REST/JSON        ┌──────────────┐        ┌───────────────┐
│  Frontend   │  ───────────────────▶   │   Backend    │  ───▶  │  Gemini API   │
│ HTML/CSS/JS │  ◀───────────────────   │ Express + JWT│        │   (Google)    │
└─────────────┘                         └──────┬───────┘        └───────────────┘
                                                │
                                          ┌─────▼──────┐
                                          │  SQLite DB │
                                          │ users /    │
                                          │ sessions   │
                                          └────────────┘
```

- **Frontend**: vanilla HTML/CSS/JS (no build step needed) — auth screens, dashboard, interview flow, feedback report
- **Backend**: Node.js + Express — handles auth, holds the Gemini API key server-side, and persists sessions
- **Database**: SQLite via `better-sqlite3` — zero-config, file-based, easy to swap for Postgres/MySQL later
- **AI**: Google Gemini (defaults to `gemini-flash-latest`) generates interview questions and structured feedback via the Gemini `generateContent` API

Keeping the Gemini API key on the backend (rather than in the browser) is a deliberate design choice — it's how you'd do this in production, and it's worth mentioning in a project writeup or interview.

## Project structure

```
green-room/
├── backend/
│   ├── server.js         # Express app: auth + interview routes, SQLite setup
│   ├── package.json
│   └── .env.example      # copy to .env and fill in your values
└── frontend/
    └── index.html        # entire frontend (single file, no build tools)
```

## Setup

### Quick launch on Windows

Double-click [`launcher/Start Green Room.bat`](launcher/Start%20Green%20Room.bat). It starts the local server and opens the app at `http://localhost:4000`.

The first run needs Node.js 18+ and installs the backend packages if they are missing. Keep the **Green Room Server** window open while using the app; close it to stop the app. To generate questions and feedback, add your Gemini API key to `backend/.env` (copy `backend/.env.example` if needed).

The local administrator account is created automatically on startup. Sign in with username `admin` and password `admin1234`. Change `ADMIN_PASSWORD` in `backend/.env` before deploying the app publicly.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
```
PORT=4000
GEMINI_API_KEY=your_gemini_api_key_here
# Optional: defaults to gemini-flash-latest
GEMINI_MODEL=gemini-flash-latest
JWT_SECRET=replace_with_a_long_random_string
```

Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

```bash
npm start
```

The backend runs at `http://localhost:4000`. A `greenroom.db` SQLite file is created automatically on first run.

### 2. Frontend

The frontend is a single static HTML file — no build step. Simplest option:

```bash
cd frontend
npx serve .
```

Then open the printed URL (e.g. `http://localhost:3000`). The frontend automatically points at `http://localhost:4000` for local development (see the `API_BASE` constant at the top of the `<script>` in `index.html`).

For voice input/output, use Chrome or Edge — Web Speech API support varies across browsers; the app falls back gracefully to text-only elsewhere.

## API reference

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | – | Create an account, returns a JWT |
| POST | `/api/auth/login` | – | Log in, returns a JWT |
| GET | `/api/me` | ✔ | Get the current user |
| POST | `/api/interview/start` | ✔ | Generate the opening warm-up question for a role/level |
| POST | `/api/interview/next` | ✔ | Given the transcript so far, decide the next turn — a brief follow-up on the last answer, or a new main question |
| POST | `/api/interview/feedback` | ✔ | Score a completed transcript, saves the session |
| GET | `/api/sessions` | ✔ | List the user's past sessions |
| GET | `/api/sessions/:id` | ✔ | Full detail of one session |

## Deploying

- **Backend**: Render, Railway, Fly.io, or a small VPS all work well for an Express + SQLite app. Set the three env vars from `.env.example` in your host's dashboard.
- **Frontend**: any static host (Netlify, Vercel, GitHub Pages). Update `API_BASE` in `index.html` to your deployed backend URL.
- **Database**: SQLite is fine for a portfolio/demo project. For a production-scale version, swap `better-sqlite3` for a hosted Postgres instance (e.g. Supabase, Neon, Railway) — the SQL is simple enough that the migration is mostly mechanical.

## Possible extensions (good "future work" section for a project report)

- Upload a resume (PDF) and have Gemini tailor questions to it
- Follow-up questions generated dynamically based on the candidate's actual answer
- Company-specific interview style presets
- Export a session as a PDF report
- Admin/analytics view of score trends over time (charting library like Chart.js or Recharts)
