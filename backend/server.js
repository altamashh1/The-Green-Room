require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// Behind a single reverse proxy on most hosts (Render/Railway/Fly); needed so
// req.ip reflects the real client for rate limiting.
app.set('trust proxy', 1);

// Lock CORS to the known frontend origin in production. In local dev (no
// ALLOWED_ORIGIN set) requests come from the same origin or file/localhost,
// so reflecting the origin is fine.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : {}));

// Minimal security headers without pulling in a dependency (keeps the
// one-click launcher install-free). The CSP allows the inline script/style
// the single-file frontend uses plus Google Fonts.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '2mb' }));

// Tiny fixed-window rate limiter (per IP + bucket). Enough to blunt brute-force
// on auth and to cap spend on the Gemini-backed routes.
function rateLimit({ windowMs, max, bucket }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, bucket: 'auth' });
const interviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, bucket: 'interview' });

// ---------- DATABASE ----------
// Backed by libSQL (Turso in production, a local file in dev). DATABASE_URL is
// the libsql://... URL from Turso; leave it unset locally to use a plain file
// so the one-click launcher still works with no external service.
const dbClient = createClient(
  process.env.DATABASE_URL
    ? { url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN }
    : { url: `file:${path.join(__dirname, 'greenroom.db')}` }
);

// A thin async wrapper exposing just the calls this app makes, so the route
// code reads almost the same as it did with better-sqlite3 (now with `await`).
function bindArgs(args) {
  return args.map((v) => (v === undefined ? null : v));
}
const db = {
  async get(sql, ...args) {
    const r = await dbClient.execute({ sql, args: bindArgs(args) });
    const row = r.rows[0];
    if (!row) return undefined;
    const obj = {};
    for (const col of r.columns) obj[col] = row[col];
    return obj;
  },
  async all(sql, ...args) {
    const r = await dbClient.execute({ sql, args: bindArgs(args) });
    return r.rows.map((row) => {
      const obj = {};
      for (const col of r.columns) obj[col] = row[col];
      return obj;
    });
  },
  async run(sql, ...args) {
    const r = await dbClient.execute({ sql, args: bindArgs(args) });
    return {
      lastInsertRowid: r.lastInsertRowid == null ? undefined : Number(r.lastInsertRowid),
      changes: r.rowsAffected
    };
  },
  async exec(sql) {
    await dbClient.executeMultiple(sql);
  }
};

const SCHEMA_SQL = `
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
`;

// ---------- CONFIG ----------
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? '' : 'dev-secret-change-me');
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set to a long random string in production.');
  process.exit(1);
}
if (JWT_SECRET === 'dev-secret-change-me') {
  console.warn('WARNING: using the insecure default JWT_SECRET. Set JWT_SECRET in backend/.env.');
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set — interview and feedback routes will fail until it is.');
}
// The model chain: the first model is tried first, and when it is rate-limited
// or its quota is exhausted the next one is used, and so on. Set GEMINI_MODEL to
// a single id or a comma-separated list, and/or add GEMINI_FALLBACK_MODELS.
const GEMINI_MODELS = [
  ...String(process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').split(','),
  ...String(process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.0-flash-lite,gemini-2.0-flash').split(',')
]
  .map((m) => m.trim())
  .filter(Boolean)
  .filter((m, i, all) => all.indexOf(m) === i);
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 45_000;
const GEMINI_MAX_ATTEMPTS = Math.max(1, Number(process.env.GEMINI_MAX_ATTEMPTS) || 3);

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@greenroom.local').toLowerCase().trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
if (IS_PRODUCTION && ADMIN_PASSWORD === 'admin1234') {
  console.warn('WARNING: the default admin password is in use. Set ADMIN_PASSWORD in backend/.env.');
}

// Create the schema, run the one-off role-column migration, and seed the local
// administrator. All async now, so it runs in initDatabase() before listen().
async function initDatabase() {
  await db.exec(SCHEMA_SQL);

  // Add the role column for databases created before administrator accounts
  // were introduced. SQLite ignores the column in CREATE TABLE for existing DBs.
  const userColumns = await db.all('PRAGMA table_info(users)');
  if (!userColumns.some((column) => column.name === 'role')) {
    await db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  // Seed the requested local administrator once. The password is hashed like
  // every other account and is never returned by the API.
  const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', ADMIN_EMAIL);
  if (!existingAdmin) {
    const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    await db.run(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      'Admin', ADMIN_EMAIL, adminHash, 'admin'
    );
    console.log('Default administrator account created.');
  }
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

// Runs the retry loop against a single model. Throws on failure; the error
// carries `.status` so askGemini() can decide whether to fall back.
async function askGeminiModel(model, promptText) {
  const url = geminiUrl(model);
  let lastError;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
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

// Walks the model chain. A 429 (rate limit / quota exhausted), 404 (model not
// available on this key) or 403 moves on to the next model; anything else is
// surfaced immediately.
async function askGemini(promptText) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server');

  let lastError;
  for (let i = 0; i < GEMINI_MODELS.length; i += 1) {
    const model = GEMINI_MODELS[i];
    try {
      return await askGeminiModel(model, promptText);
    } catch (error) {
      lastError = error;
      const canFallBack = [429, 404, 403].includes(error.status) && i < GEMINI_MODELS.length - 1;
      if (!canFallBack) throw error;
      console.warn(`Gemini model "${model}" unavailable (${error.status}); falling back to "${GEMINI_MODELS[i + 1]}".`);
    }
  }
  throw lastError || new Error('Gemini request failed');
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be between 6 and 200 characters' });
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
    return res.status(400).json({ error: 'Name must be between 1 and 80 characters' });
  }
  const normalizedEmail = String(email).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const existing = await db.get('SELECT id FROM users WHERE email = ?', normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = await bcrypt.hash(password, 10);
  const info = await db.run(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
    name.trim(), normalizedEmail, hash, 'user'
  );
  const user = { id: info.lastInsertRowid, name: name.trim(), email: normalizedEmail, role: 'user' };
  res.json({ token: signToken(user), user });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const normalizedEmail = String(email).toLowerCase().trim();
  const user = await db.get('SELECT * FROM users WHERE email = ?', normalizedEmail);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await db.get('SELECT id, name, email, role FROM users WHERE id = ?', req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: publicUser(user) });
});

// ---------- INTERVIEW ROUTES ----------

// Validates the shared setup fields (role/level/numQuestions) used by both
// /start and /next. Returns an error string, or null if everything is valid.
function validateSetup({ role, level, numQuestions }) {
  const questionCount = Number(numQuestions);
  if (!role || !level || !numQuestions) return 'role, level and numQuestions are required';
  if (!SUPPORTED_ROLES.has(role)) return 'Choose one of the available roles';
  if (!Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) return 'Choose a valid experience level';
  if (!ALLOWED_QUESTION_COUNTS.has(questionCount)) return 'Choose a 3- or 5-question round';
  return null;
}

const MAX_TRANSCRIPT_ITEMS = 30;
const MAX_FIELD_LEN = 5000;

// Coerces the client-supplied transcript into a known-safe shape and bounds its
// size before it is interpolated into a prompt or stored.
function sanitizeTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return null;
  if (transcript.length > MAX_TRANSCRIPT_ITEMS) return null;
  const cleaned = [];
  for (const entry of transcript) {
    if (!entry || typeof entry !== 'object') return null;
    const question = typeof entry.question === 'string' ? entry.question.slice(0, MAX_FIELD_LEN) : '';
    const answer = typeof entry.answer === 'string' ? entry.answer.slice(0, MAX_FIELD_LEN) : '';
    if (!question || !answer) return null;
    cleaned.push({ question, answer, isFollowUp: Boolean(entry.isFollowUp) });
  }
  return cleaned;
}

// Generates only the opening question. The rest of the interview is decided
// turn-by-turn by /api/interview/next, based on how the candidate answers.
app.post('/api/interview/start', authMiddleware, interviewLimiter, async (req, res) => {
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
app.post('/api/interview/next', authMiddleware, interviewLimiter, async (req, res) => {
  const { role, level, numQuestions, mainQuestionNumber, followUpsUsed } = req.body || {};
  const validationError = validateSetup({ role, level, numQuestions });
  if (validationError) return res.status(400).json({ error: validationError });
  const transcript = sanitizeTranscript((req.body || {}).transcript);
  if (!transcript) {
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

app.post('/api/interview/feedback', authMiddleware, interviewLimiter, async (req, res) => {
  const { role, level } = req.body || {};
  const transcript = sanitizeTranscript((req.body || {}).transcript);
  if (!role || !level || !transcript) {
    return res.status(400).json({ error: 'role, level and a non-empty transcript are required' });
  }
  if (!SUPPORTED_ROLES.has(role)) {
    return res.status(400).json({ error: 'Choose one of the available roles' });
  }
  if (!Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) {
    return res.status(400).json({ error: 'Choose a valid experience level' });
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
    const raw = parseJsonLoose(text);

    // The model output is untrusted — coerce it into the exact shape the
    // frontend and database expect.
    const scoreNum = Math.round(Number(raw && raw.overallScore));
    const overallScore = Number.isFinite(scoreNum) ? Math.min(10, Math.max(1, scoreNum)) : null;
    const questions = Array.isArray(raw && raw.questions) ? raw.questions : [];
    const feedback = {
      overallScore,
      overallSummary: typeof raw?.overallSummary === 'string' ? raw.overallSummary.slice(0, MAX_FIELD_LEN) : '',
      questions: transcript.map((_, i) => ({
        strength: typeof questions[i]?.strength === 'string' ? questions[i].strength.slice(0, MAX_FIELD_LEN) : '',
        improvement: typeof questions[i]?.improvement === 'string' ? questions[i].improvement.slice(0, MAX_FIELD_LEN) : ''
      }))
    };

    const info = await db.run(
      `INSERT INTO sessions (user_id, role, level, type, num_questions, overall_score, overall_summary, transcript_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id,
      role,
      level,
      'standard',
      transcript.length,
      feedback.overallScore,
      feedback.overallSummary,
      JSON.stringify({ transcript, feedback })
    );

    res.json({ feedback, sessionId: info.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not generate feedback right now. Please try again.' });
  }
});

app.get('/api/sessions', authMiddleware, async (req, res) => {
  const rows = await db.all(
    `SELECT id, role, level, type, num_questions, overall_score, overall_summary, created_at
     FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
    req.user.id
  );
  res.json({ sessions: rows });
});

app.get('/api/sessions/:id', authMiddleware, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid session id' });
  const row = await db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  row.transcript_json = JSON.parse(row.transcript_json);
  res.json({ session: row });
});

// ---------- ADMIN ROUTES ----------
// Re-checks the role against the database (not just the token) so a demotion
// takes effect immediately.
async function adminMiddleware(req, res, next) {
  try {
    const row = await db.get('SELECT role FROM users WHERE id = ?', req.user.id);
    if (!row || row.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch (e) {
    next(e);
  }
}

app.get('/api/admin/overview', authMiddleware, adminMiddleware, async (req, res) => {
  const userCount = (await db.get('SELECT COUNT(*) AS c FROM users')).c;
  const sessionCount = (await db.get('SELECT COUNT(*) AS c FROM sessions')).c;
  const avg = (await db.get('SELECT AVG(overall_score) AS a FROM sessions WHERE overall_score IS NOT NULL')).a;
  const byRole = await db.all(
    'SELECT role, COUNT(*) AS count, ROUND(AVG(overall_score), 1) AS avgScore FROM sessions GROUP BY role ORDER BY count DESC'
  );
  const byDay = await db.all(
    "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM sessions GROUP BY day ORDER BY day DESC LIMIT 14"
  );
  const recentSessions = await db.all(
    `SELECT s.id, s.role, s.level, s.num_questions, s.overall_score, s.created_at, u.email AS user_email
     FROM sessions s JOIN users u ON u.id = s.user_id
     ORDER BY s.created_at DESC LIMIT 20`
  );
  const recentUsers = await db.all(
    `SELECT id, name, email, role, created_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = users.id) AS sessions
     FROM users ORDER BY created_at DESC LIMIT 20`
  );

  res.json({
    userCount,
    sessionCount,
    avgScore: avg != null ? Number(avg.toFixed(1)) : null,
    byRole,
    byDay,
    recentSessions,
    recentUsers
  });
});

const APP_VERSION = '2026.09.02.5';
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'green-room', version: APP_VERSION }));

// Serve the browser app from the same local server as the API. This keeps the
// one-click launcher self-contained: opening http://localhost:4000 runs both
// the frontend and backend without a second development server.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Central error handler: turn malformed JSON and unexpected throws into clean
// JSON responses instead of leaking a stack trace to the client.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 4000;
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Green Room is ready at http://localhost:${PORT}`);
      console.log(`Database: ${process.env.DATABASE_URL ? 'libSQL (' + process.env.DATABASE_URL + ')' : 'local file'}`);
      console.log(`Gemini model chain: ${GEMINI_MODELS.join(' -> ')}`);
    });
  })
  .catch((e) => {
    console.error('FATAL: could not initialise the database.', e);
    process.exit(1);
  });
