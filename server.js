const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PERIOD_DAYS = { '30': 30, '90': 90, '365': 365 };

let evidenceHistory = [];

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function githubMessage(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.message) return parsed.message;
  } catch (err) {}
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
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = text;
    }
  }
  return { status: response.status, ok: response.ok, body };
}

async function readReviewRule(owner, repo, headers) {
  const repoRes = await githubJson(`https://api.github.com/repos/${owner}/${repo}`, headers);
  if (!repoRes.ok) {
    return {
      status: 'unknown',
      branch: null,
      required_reviews: null,
      detail: 'Could not read the repository, so the review rule was not checked.'
    };
  }

  const branch = repoRes.body.default_branch || 'main';
  let required = 0;
  let saw = false;
  let blocked = false;
  let codeOwners = false;

  const rulesHeaders = Object.assign({}, headers, { Accept: 'application/vnd.github+json' });
  const rulesRes = await githubJson(
    `https://api.github.com/repos/${owner}/${repo}/rules/branches/${encodeURIComponent(branch)}`,
    rulesHeaders
  );
  if (rulesRes.ok && Array.isArray(rulesRes.body)) {
    saw = true;
    rulesRes.body.forEach(rule => {
      if (rule.type !== 'pull_request' || !rule.parameters) return;
      const count = Number(rule.parameters.required_approving_review_count || 0);
      if (count > required) required = count;
      if (rule.parameters.require_code_owner_review) codeOwners = true;
    });
  } else if (rulesRes.status === 401 || rulesRes.status === 403) {
    blocked = true;
  }

  const classicRes = await githubJson(
    `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`,
    headers
  );
  if (classicRes.ok && classicRes.body && typeof classicRes.body === 'object') {
    saw = true;
    const count = Number(classicRes.body.required_approving_review_count || 0);
    if (count > required) required = count;
    if (classicRes.body.require_code_owner_reviews) codeOwners = true;
  } else if (classicRes.status === 404) {
    saw = true;
  } else if (classicRes.status === 401 || classicRes.status === 403) {
    blocked = true;
  }

  const ownerNote = codeOwners ? ' Code owners must still approve changes to files they own.' : '';
  if (required >= 1) {
    const word = required === 1 ? 'review' : 'reviews';
    return {
      status: 'required',
      branch,
      required_reviews: required,
      code_owner_review: codeOwners,
      detail: `The ${branch} branch requires at least ${required} approving ${word} before a change can be merged.${ownerNote}`
    };
  }
  if (saw && !blocked) {
    return {
      status: 'not_required',
      branch,
      required_reviews: 0,
      code_owner_review: codeOwners,
      detail: `The ${branch} branch does not require an approving review before a change can be merged.${ownerNote}`
    };
  }
  return {
    status: 'unknown',
    branch,
    required_reviews: null,
    code_owner_review: null,
    detail: `Could not fully read the rules for ${branch}. This token cannot see every setting, so a missing review requirement is not proven.`
  };
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  if (!workers) return out;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

app.post('/api/fetch', async (req, res) => {
  const { owner, repo, token } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner and repo are required' });
  }

  const days = PERIOD_DAYS[String(req.body.days)] || null;
  const since = days ? sinceIso(days) : null;
  const maxPages = since ? 5 : 1;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-evidence-tool'
  };
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const rulePromise = readReviewRule(owner, repo, headers);
    const pulls = [];
    let truncated = false;

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return res.status(response.status).json({ error: githubMessage(await response.text()) });
      }
      const batch = await response.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      pulls.push(...batch);

      const oldestUpdate = batch.reduce((oldest, pr) => {
        const updated = pr.updated_at || '';
        return !oldest || updated < oldest ? updated : oldest;
      }, '');
      const passedWindow = since && oldestUpdate && oldestUpdate < since;
      if (batch.length < 100 || passedWindow) break;
      if (page === maxPages) truncated = true;
    }

    const merged = pulls.filter(pr => pr.merged_at && (!since || pr.merged_at >= since));
    const collectedAt = new Date().toISOString();

    const evidence = await mapPool(merged, 6, async (pr) => {
      const reviewsRes = await fetch(pr.url + '/reviews', { headers });
      if (reviewsRes.status === 403 || reviewsRes.status === 429) {
        const message = githubMessage(await reviewsRes.text());
        const error = new Error(message);
        error.status = reviewsRes.status;
        throw error;
      }

      let reviews = [];
      let reviewUnknown = false;
      if (reviewsRes.ok) {
        const body = await reviewsRes.json();
        reviews = Array.isArray(body) ? body : [];
      } else {
        reviewUnknown = true;
      }

      const reviewers = [...new Set(reviews.map(review => review.user && review.user.login).filter(Boolean))];
      return {
        id: pr.number,
        title: pr.title,
        url: pr.html_url,
        merged_at: pr.merged_at,
        has_review: reviewers.length > 0,
        review_unknown: reviewUnknown,
        reviewers,
        collected_at: collectedAt
      };
    });

    const rule = await rulePromise;

    evidenceHistory.push({
      collected_at: collectedAt,
      owner,
      repo,
      count: evidence.length,
      days,
      since,
      truncated,
      rule,
      items: evidence
    });
    if (evidenceHistory.length > 10) evidenceHistory.shift();

    res.json({ collected_at: collectedAt, evidence, truncated, since, days, rule });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/history/:index', (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0 || index >= evidenceHistory.length) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(evidenceHistory[index]);
});

app.get('/api/history', (req, res) => {
  res.json(evidenceHistory);
});

app.get('/api/export', (req, res) => {
  if (evidenceHistory.length === 0) {
    return res.status(404).json({ error: 'No evidence collected yet' });
  }
  const latest = evidenceHistory[evidenceHistory.length - 1];
  res.setHeader('Content-Disposition', 'attachment; filename="github-evidence.json"');
  res.json(latest);
});

app.listen(PORT, () => {
  console.log(`GitHub Evidence tool running at http://localhost:${PORT}`);
});
