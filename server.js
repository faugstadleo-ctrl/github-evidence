const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PERIOD_DAYS = { '30': 30, '90': 90, '365': 365 };
const STORE_TOKEN = process.env.GITHUB_TOKEN || '';
const STORE_REPO = process.env.STORE_REPO || 'faugstadleo-ctrl/github-evidence';
const INQUIRY_FILE = path.join(__dirname, 'inquiries.json');
const USERS_FILE = path.join(__dirname, 'users.json');

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch {}
}

let evidenceHistory = [];
let inquiries = readJsonFile(INQUIRY_FILE, []);
if (!Array.isArray(inquiries)) inquiries = [];
const sessions = new Map();
const users = Object.assign({
  admin: { password: process.env.ADMIN_PASSWORD || 'admin-access-2026', role: 'admin' }
}, readJsonFile(USERS_FILE, {}));

function saveInquiries() { writeJsonFile(INQUIRY_FILE, inquiries); }
function saveUsers() {
  const extra = Object.assign({}, users);
  delete extra.admin;
  writeJsonFile(USERS_FILE, extra);
}
function storeHeaders() {
  return { Authorization: `token ${STORE_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'github-evidence-tool' };
}
async function rememberInquiry(item) {
  if (!STORE_TOKEN) return null;
  const res = await fetch(`https://api.github.com/repos/${STORE_REPO}/issues`, {
    method: 'POST', headers: storeHeaders(),
    body: JSON.stringify({ title: `Access request: ${item.name}`, body: [`Name: ${item.name}`, `Email: ${item.email}`, `Company: ${item.company || 'none'}`, `Note: ${item.note || 'none'}`, `Asked at: ${item.at}`].join('\n') })
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.number || null;
}
async function loadStoredInquiries() {
  if (!STORE_TOKEN) return;
  const res = await fetch(`https://api.github.com/repos/${STORE_REPO}/issues?state=open&per_page=100`, { headers: storeHeaders() });
  if (!res.ok) return;
  const issues = await res.json();
  if (!Array.isArray(issues)) return;
  const requests = issues.filter(issue => (issue.title || '').startsWith('Access request:'));
  const stored = requests.map(issue => {
    const body = issue.body || '';
    const value = (label) => { const line = body.split('\n').find(row => row.startsWith(label + ':')); return line ? line.slice(label.length + 1).trim() : ''; };
    return { name: value('Name') || issue.title.replace('Access request: ', ''), email: value('Email'), company: value('Company') === 'none' ? '' : value('Company'), note: value('Note') === 'none' ? '' : value('Note'), at: value('Asked at') || issue.created_at, issue: issue.number };
  }).filter(item => item.email);
  const known = new Set(inquiries.map(item => item.email + '|' + item.at));
  stored.forEach(item => { if (!known.has(item.email + '|' + item.at)) inquiries.push(item); });
  saveInquiries();
}
loadStoredInquiries().catch(() => {});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = decodeURIComponent(rest.join('='));
  });
  return out;
}
function currentUser(req) { return sessions.get(parseCookies(req).sid) || null; }
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Log in first' });
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

app.get('/', (req, res) => { if (currentUser(req)) return res.redirect('/app'); res.sendFile(path.join(__dirname, 'public', 'landing.html')); });
app.get('/login', (req, res) => { if (currentUser(req)) return res.redirect('/app'); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/app', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', (req, res) => res.redirect('/'));

app.post('/api/inquire', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const company = String(req.body.company || '').trim();
  const email = String(req.body.email || '').trim();
  const note = String(req.body.note || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  const item = { name, company, email, note, at: new Date().toISOString() };
  inquiries.push(item);
  if (inquiries.length > 200) inquiries.shift();
  saveInquiries();
  const issue = await rememberInquiry(item);
  if (issue) { item.issue = issue; saveInquiries(); }
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = users[username];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Wrong username or password' });
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { username, role: user.role });
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
  res.json({ ok: true, role: user.role });
});
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.sid) sessions.delete(cookies.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: user.username, role: user.role, requests_kept: !!STORE_TOKEN });
});
app.get('/api/inquiries', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(inquiries);
});
app.post('/api/inquiries/done', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const at = String(req.body.at || '');
  const index = inquiries.findIndex(item => item.at === at);
  if (index < 0) return res.status(404).json({ error: 'Not found' });
  const item = inquiries[index];
  if (item.issue && STORE_TOKEN) {
    await fetch(`https://api.github.com/repos/${STORE_REPO}/issues/${item.issue}`, {
      method: 'PATCH', headers: storeHeaders(), body: JSON.stringify({ state: 'closed' })
    }).catch(() => {});
  }
  inquiries.splice(index, 1);
  saveInquiries();
  res.json({ ok: true });
});
app.get('/api/users', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(Object.keys(users).filter(name => name !== 'admin').map(username => ({ username })));
});
app.post('/api/users', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username === 'admin') return res.status(400).json({ error: 'That username is reserved' });
  users[username] = { password, role: 'user' };
  saveUsers();
  res.json({ ok: true });
});
app.post('/api/users/remove', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const username = String(req.body.username || '').trim();
  if (!username || username === 'admin') return res.status(400).json({ error: 'Cannot remove that login' });
  if (!users[username]) return res.status(404).json({ error: 'Not found' });
  delete users[username];
  saveUsers();
  for (const [sid, user] of sessions) {
    if (user.username === username) sessions.delete(sid);
  }
  res.json({ ok: true });
});

function githubMessage(text) {
  try { const parsed = JSON.parse(text); if (parsed && parsed.message) return parsed.message; } catch (err) {}
  return String(text || 'GitHub request failed').slice(0, 300);
}
function sinceIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}
async function githubJson(url, headers) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (err) { body = text; } }
  return { status: response.status, ok: response.ok, body };
}

async function readReviewRule(owner, repo, headers) {
  const repoRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (!repoRes.ok) return { status: 'unknown', branch: null, required_reviews: null, detail: 'Could not read the repository, so the review rule was not checked.' };
  const branch = repoRes.body.default_branch || 'main';
  let required = 0, saw = false, blocked = false, codeOwners = false;
  const rulesHeaders = Object.assign({}, headers, { Accept: 'application/vnd.github+json' });
  const rulesRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}`, rulesHeaders);
  if (rulesRes.ok && Array.isArray(rulesRes.body)) {
    saw = true;
    rulesRes.body.forEach(rule => {
      if (rule.type !== 'pull_request' || !rule.parameters) return;
      const count = Number(rule.parameters.required_approving_review_count || 0);
      if (count > required) required = count;
      if (rule.parameters.require_code_owner_review) codeOwners = true;
    });
  } else if (rulesRes.status === 401 || rulesRes.status === 403) blocked = true;
  const classicRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`, headers);
  if (classicRes.ok && classicRes.body && typeof classicRes.body === 'object') {
    saw = true;
    const count = Number(classicRes.body.required_approving_review_count || 0);
    if (count > required) required = count;
    if (classicRes.body.require_code_owner_reviews) codeOwners = true;
  } else if (classicRes.status === 404) saw = true;
  else if (classicRes.status === 401 || classicRes.status === 403) blocked = true;
  const ownerNote = codeOwners ? ' Code owners must still approve changes to files they own.' : '';
  if (required >= 1) {
    const word = required === 1 ? 'review' : 'reviews';
    return { status: 'required', branch, required_reviews: required, code_owner_review: codeOwners, detail: `The ${branch} branch requires at least ${required} approving ${word} before a change can be merged.${ownerNote}` };
  }
  if (saw && !blocked) return { status: 'not_required', branch, required_reviews: 0, code_owner_review: codeOwners, detail: `The ${branch} branch does not require an approving review before a change can be merged.${ownerNote}` };
  return { status: 'unknown', branch, required_reviews: null, code_owner_review: null, detail: `Could not fully read the rules for ${branch}. This token cannot see every setting, so a missing review requirement is not proven.` };
}

async function readAccess(owner, repo, headers) {
  const repoRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (!repoRes.ok) return { status: 'unknown', detail: 'Could not check who can change the code.' };
  const branch = repoRes.body.default_branch || 'main';
  let bypass = 'unknown';
  const protection = await githubJson(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, headers);
  if (protection.ok && protection.body) bypass = protection.body.enforce_admins && protection.body.enforce_admins.enabled ? 'no' : 'yes';
  else if (protection.status === 404) bypass = 'yes';
  const collab = await githubJson(`https://api.github.com/repos/${owner}/${repo}/collaborators?per_page=100`, headers);
  let people = [], listed = false;
  if (collab.ok && Array.isArray(collab.body)) {
    listed = true;
    people = collab.body.map(user => {
      const role = user.role_name || (user.permissions && user.permissions.admin ? 'admin' : user.permissions && user.permissions.maintain ? 'maintain' : user.permissions && user.permissions.push ? 'write' : 'read');
      return { login: user.login, role };
    }).filter(person => person.role === 'admin' || person.role === 'maintain' || person.role === 'write');
  }
  const writers = people.map(person => person.login + ' (' + person.role + ')');
  let detail = bypass === 'yes' ? `An admin can change ${branch} without going through the review rule.` : bypass === 'no' ? `The review rule on ${branch} also applies to admins.` : `Could not see whether an admin can skip the rule on ${branch}.`;
  detail += listed ? (writers.length ? ' People who can change the code: ' + writers.join(', ') + '.' : ' No one with write access was listed.') : ' This token cannot see the full list of people who can change the code.';
  return { status: bypass === 'yes' ? 'missing' : (bypass === 'no' ? 'ok' : 'unknown'), branch, bypass, people, detail };
}

async function readChecks(owner, repo, headers) {
  const repoRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (!repoRes.ok) return { status: 'unknown', detail: 'Could not check the other branch rules.' };
  const branch = repoRes.body.default_branch || 'main';
  const protection = await githubJson(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, headers);
  let tests = 'unknown', force = 'unknown';
  if (protection.ok && protection.body) {
    const checks = protection.body.required_status_checks;
    tests = checks && Array.isArray(checks.contexts) && checks.contexts.length > 0 ? 'required' : 'not_required';
    force = protection.body.allow_force_pushes && protection.body.allow_force_pushes.enabled ? 'allowed' : 'blocked';
  } else if (protection.status === 404) {
    tests = 'not_required';
    force = 'allowed';
  }
  const parts = [];
  parts.push(tests === 'required' ? `Tests must pass on ${branch} before a change can be merged.` : tests === 'not_required' ? `Tests do not have to pass on ${branch} before a change can be merged.` : `Could not see whether tests must pass on ${branch}.`);
  parts.push(force === 'blocked' ? 'Rewriting history with a force push is blocked.' : force === 'allowed' ? 'Someone can rewrite history with a force push.' : 'Could not see whether a force push is allowed.');
  const bad = tests === 'not_required' || force === 'allowed';
  const unknown = tests === 'unknown' && force === 'unknown';
  return { status: unknown ? 'unknown' : (bad ? 'missing' : 'ok'), branch, tests, force, detail: parts.join(' ') };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() { while (cursor < items.length) { const index = cursor++; out[index] = await fn(items[index]); } }
  const workers = Math.min(limit, items.length);
  if (!workers) return out;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

const PERIOD_DAYS_MAP = PERIOD_DAYS;
app.post('/api/fetch', requireAuth, async (req, res) => {
  const { owner, repo, token } = req.body;
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });
  const days = PERIOD_DAYS_MAP[String(req.body.days)] || null;
  const since = days ? sinceIso(days) : null;
  const maxPages = since ? 5 : 1;
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'github-evidence-tool' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const rulePromise = readReviewRule(owner, repo, headers);
    const accessPromise = readAccess(owner, repo, headers);
    const checksPromise = readChecks(owner, repo, headers);
    const pulls = [];
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
      const response = await fetch(url, { headers });
      if (!response.ok) return res.status(response.status).json({ error: githubMessage(await response.text()) });
      const batch = await response.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      pulls.push(...batch);
      const oldestUpdate = batch.reduce((oldest, pr) => { const updated = pr.updated_at || ''; return !oldest || updated < oldest ? updated : oldest; }, '');
      if (batch.length < 100 || (since && oldestUpdate && oldestUpdate < since)) break;
      if (page === maxPages) truncated = true;
    }
    const merged = pulls.filter(pr => pr.merged_at && (!since || pr.merged_at >= since));
    const collectedAt = new Date().toISOString();
    const evidence = await mapPool(merged, 6, async (pr) => {
      const reviewsRes = await fetch(pr.url + '/reviews', { headers });
      if (reviewsRes.status === 403 || reviewsRes.status === 429) {
        const error = new Error(githubMessage(await reviewsRes.text()));
        error.status = reviewsRes.status;
        throw error;
      }
      let reviews = [], reviewUnknown = false;
      if (reviewsRes.ok) { const body = await reviewsRes.json(); reviews = Array.isArray(body) ? body : []; }
      else reviewUnknown = true;
      const reviewers = [...new Set(reviews.map(review => review.user && review.user.login).filter(Boolean))];
      return { id: pr.number, title: pr.title, url: pr.html_url, merged_at: pr.merged_at, has_review: reviewers.length > 0, review_unknown: reviewUnknown, reviewers, collected_at: collectedAt };
    });
    const rule = await rulePromise;
    const access = await accessPromise;
    const checks = await checksPromise;
    evidenceHistory.push({ collected_at: collectedAt, owner, repo, count: evidence.length, days, since, truncated, rule, access, checks, items: evidence });
    if (evidenceHistory.length > 10) evidenceHistory.shift();
    res.json({ collected_at: collectedAt, evidence, truncated, since, days, rule, access, checks });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/history/:index', requireAuth, (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0 || index >= evidenceHistory.length) return res.status(404).json({ error: 'Not found' });
  res.json(evidenceHistory[index]);
});
app.get('/api/history', requireAuth, (req, res) => res.json(evidenceHistory));
app.get('/api/export', requireAuth, (req, res) => {
  if (evidenceHistory.length === 0) return res.status(404).json({ error: 'No evidence collected yet' });
  res.setHeader('Content-Disposition', 'attachment; filename="github-evidence.json"');
  res.json(evidenceHistory[evidenceHistory.length - 1]);
});
app.listen(PORT, () => console.log(`GitHub Evidence tool running at http://localhost:${PORT}`));
