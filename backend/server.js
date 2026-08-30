require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- DATABASE ----------
const db = new Database(path.join(__dirname, 'greenroom.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    num_questions INTEGER NOT NULL,
    overall_score INTEGER,
    overall_summary TEXT,
    transcript_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Add the role column for databases created before administrator accounts
// were introduced. SQLite ignores the column in CREATE TABLE for existing DBs.
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((column) => column.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

// ---------- CONFIG ----------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45_000;
const GEMINI_MAX_ATTEMPTS = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS) || 3);
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// Seed the requested local administrator once. The password is hashed like
// every other account and is never returned by the API.
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_USERNAME);
if (!existingAdmin) {
  const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Administrator', ADMIN_USERNAME, adminHash, 'admin');
  console.log('Default administrator account created.');
}

const LEVEL_LABELS = {
  entry: 'entry-level',
  mid: 'mid-level',
  senior: 'senior-level',
  executive: 'executive/leadership-level'
};
const SUPPORTED_ROLES = new Set(['Software Engineer','Embedded Software Engineer','Data Analyst', 'Product Manager']);
const ALLOWED_QUESTION_COUNTS = new Set([3, 5]);
const MAX_FOLLOWUPS_PER_QUESTION = 1;

// ---------- HELPERS ----------
function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role || 'user' };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session, please log in again' });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response && response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  // Exponential backoff with jitter prevents simultaneous client retries from
  // continually hitting the same Gemini quota window.
  return Math.min(8_000, 700 * (2 ** attempt)) + Math.floor(Math.random() * 350);
}

function geminiError(status, body) {
  let message = '';
  try { message = JSON.parse(body).error?.message || ''; } catch { /* use status below */ }
  const details = message ? `: ${message}` : '';
  const error = new Error(`Gemini API error ${status}${details}`);
  error.status = status;
  return error;
}

async function askGemini(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server');

  let lastError;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
        signal: controller.signal
      });
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS / 1000} seconds`)
        : error;
      if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
        await wait(retryDelay(null, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const body = await resp.text();
      lastError = geminiError(resp.status, body);
      // These responses are temporary: capacity errors, a rate limit, or a
      // short network/proxy failure. Invalid keys and malformed requests are not retried.
      const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
      if (retryable && attempt < GEMINI_MAX_ATTEMPTS - 1) {
        await wait(retryDelay(resp, attempt));
        continue;
      }
      throw lastError;
    }

    const data = await resp.json();
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || '').join('\n').trim()
      : '';
    if (text) return text;

    // A response can be valid JSON but contain no candidate when it is blocked.
    lastError = new Error(`Gemini returned no usable content${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}`);
    if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
      await wait(retryDelay(null, attempt));
      continue;
    }
    throw lastError;
  }

  throw lastError || new Error('Gemini request failed');
}
function parseJsonLoose(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name.trim(), normalizedEmail, hash, 'user');
  const user = { id: info.lastInsertRowid, name: name.trim(), email: normalizedEmail, role: 'user' };
  res.json({ token: signToken(user), user });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const normalizedEmail = email.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ---------- INTERVIEW ROUTES ----------

// Validates the shared setup fields (role/level/numQuestions) used by both
// /start and /next. Returns an error string, or null if everything is valid.
function validateSetup({ role, level, numQuestions }) {
  const questionCount = Number(numQuestions);
  if (!role || !level || !numQuestions) return 'role, level and numQuestions are required';
  if (!SUPPORTED_ROLES.has(role)) return 'Choose one of the available roles';
  if (!ALLOWED_QUESTION_COUNTS.has(questionCount)) return 'Choose a 3- or 5-question round';
  return null;
}

// Generates only the opening question. The rest of the interview is decided
// turn-by-turn by /api/interview/next, based on how the candidate answers.
app.post('/api/interview/start', authMiddleware, async (req, res) => {
  const { role, level } = req.body || {};
  const validationError = validateSetup(req.body || {});
  if (validationError) return res.status(400).json({ error: validationError });

  const levelLabel = LEVEL_LABELS[level] || level;
  const prompt = `You are an experienced, friendly hiring manager about to start a live interview for a ${levelLabel} "${role}" position. Write ONE natural, welcoming warm-up question to open the interview (e.g. inviting the candidate to introduce themselves or their background). Return ONLY the question text as a raw JSON string, nothing else, no markdown fences, no preamble. Example: "Tell me a little about yourself and what drew you to this role."`;

  try {
    const text = await askGemini(prompt);
    let question;
    try { question = parseJsonLoose(text); } catch { question = text.replace(/^"|"$/g, '').trim(); }
    if (!question || typeof question !== 'string') throw new Error('Unexpected response format');
    res.json({ question });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not start the interview right now. Please try again.' });
  }
});

// Decides the next turn of the interview: either a brief follow-up on the
// candidate's last answer, or a fresh main question. This is what makes the
// interview feel live/adaptive instead of a fixed pre-generated list.
app.post('/api/interview/next', authMiddleware, async (req, res) => {
  const { role, level, numQuestions, mainQuestionNumber, followUpsUsed, transcript } = req.body || {};
  const validationError = validateSetup({ role, level, numQuestions });
  if (validationError) return res.status(400).json({ error: validationError });
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: 'transcript with at least one answer is required' });
  }
  const total = Number(numQuestions);
  const currentMain = Number(mainQuestionNumber) || 1;
  const usedFollowUps = Number(followUpsUsed) || 0;
  const followUpsAllowed = usedFollowUps < MAX_FOLLOWUPS_PER_QUESTION;

  const levelLabel = LEVEL_LABELS[level] || level;
  const qaBlock = transcript
    .map((a, i) => `Q${i + 1}${a.isFollowUp ? ' (follow-up)' : ''}: ${a.question}\nA${i + 1}: ${a.answer}`)
    .join('\n\n');

  const instruction = followUpsAllowed
    ? `You may either (a) ask ONE brief, natural follow-up question if the candidate's last answer was vague, missing specifics, or has an interesting detail worth digging into, or (b) move on to a new main question on a different topic. Prefer moving on unless a follow-up would clearly add value.`
    : `Do not ask a follow-up this time — move on to a new main question on a different topic.`;

  const prompt = `You are an experienced, encouraging hiring manager conducting a live interview for a ${levelLabel} "${role}" position. Here is the interview transcript so far:

${qaBlock}

This is main question ${currentMain} of ${total} in the round. ${instruction} If asking a new main question, keep the overall progression from warm-up to more probing questions, and don't repeat topics already covered.

Return ONLY raw JSON (no markdown fences, no preamble) in exactly this shape:
{
  "type": "followup" or "next",
  "acknowledgement": "<one short, natural, spoken-style reaction to their last answer, under 15 words, e.g. 'Got it, thanks for walking me through that.'>",
  "question": "<the follow-up question, or the new main question text>"
}`;

  try {
    const text = await askGemini(prompt);
    const decision = parseJsonLoose(text);
    if (!decision || !decision.question || (decision.type !== 'followup' && decision.type !== 'next')) {
      throw new Error('Unexpected response format');
    }
    // Server-side safety net: never allow more follow-ups than the cap,
    // regardless of what the model decided.
    const type = followUpsAllowed ? decision.type : 'next';

    if (type === 'followup') {
      return res.json({
        type: 'followup',
        acknowledgement: decision.acknowledgement || '',
        question: decision.question,
        mainQuestionNumber: currentMain,
        followUpsUsed: usedFollowUps + 1,
        done: false
      });
    }

    const nextMain = currentMain + 1;
    const done = nextMain > total;
    return res.json({
      type: 'next',
      acknowledgement: decision.acknowledgement || '',
      question: done ? null : decision.question,
      mainQuestionNumber: nextMain,
      followUpsUsed: 0,
      done
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not get the next question right now. Please try again.' });
  }
});

app.post('/api/interview/feedback', authMiddleware, async (req, res) => {
  const { role, level, transcript } = req.body || {};
  if (!role || !level || !Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: 'role, level and a non-empty transcript are required' });
  }
  if (!SUPPORTED_ROLES.has(role)) {
    return res.status(400).json({ error: 'Choose one of the available roles' });
  }
  const levelLabel = LEVEL_LABELS[level] || level;
  const qaBlock = transcript
    .map((a, i) => `Q${i + 1}${a.isFollowUp ? ' (follow-up)' : ''}: ${a.question}\nA${i + 1}: ${a.answer}`)
    .join('\n\n');
  const prompt = `You are an experienced, encouraging but honest hiring manager. A candidate just completed a mock interview for a ${levelLabel} "${role}" position. Here is the full transcript, including any follow-up questions asked in reaction to their answers:

${qaBlock}

Evaluate their performance. Return ONLY raw JSON (no markdown fences, no preamble) in exactly this shape:
{
  "overallScore": <integer 1-10>,
  "overallSummary": "<2-3 sentence honest overall assessment, encouraging but candid>",
  "questions": [
    { "strength": "<one specific concrete thing done well, 1 sentence>", "improvement": "<one specific concrete thing to improve, 1 sentence>" }
  ]
}
The "questions" array must have exactly ${transcript.length} items, in the same order as the transcript.`;

  try {
    const text = await askGemini(prompt);
    const feedback = parseJsonLoose(text);

    const info = db
      .prepare(
        `INSERT INTO sessions (user_id, role, level, type, num_questions, overall_score, overall_summary, transcript_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        role,
        level,
        'standard',
        transcript.length,
        feedback.overallScore || null,
        feedback.overallSummary || '',
        JSON.stringify({ transcript, feedback })
      );

    res.json({ feedback, sessionId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not generate feedback right now. Please try again.' });
  }
});

app.get('/api/sessions', authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, role, level, type, num_questions, overall_score, overall_summary, created_at
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({ sessions: rows });
});

app.get('/api/sessions/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  row.transcript_json = JSON.parse(row.transcript_json);
  res.json({ session: row });
});

const APP_VERSION = '2026.08.01.3';
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'green-room', version: APP_VERSION }));

// Serve the browser app from the same local server as the API. This keeps the
// one-click launcher self-contained: opening http://localhost:4000 runs both
// the frontend and backend without a second development server.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Green Room is ready at http://localhost:${PORT}`));
