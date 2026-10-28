const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for collected evidence (simple start)
let evidenceHistory = [];

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Fetch merged PRs from a GitHub repo
app.post('/api/fetch', async (req, res) => {
  const { owner, repo, token } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner and repo are required' });
  }

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-evidence-tool'
  };
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const pulls = await response.json();

    const collectedAt = new Date().toISOString();
    const evidence = [];

    for (const pr of pulls) {
      if (!pr.merged_at) continue; // only merged ones

      // Check reviews
      const reviewsUrl = pr.url + '/reviews';
      const reviewsRes = await fetch(reviewsUrl, { headers });
      let reviews = [];
      if (reviewsRes.ok) {
        reviews = await reviewsRes.json();
      }

      const hasReview = reviews.length > 0;
      const reviewers = [...new Set(reviews.map(r => r.user?.login).filter(Boolean))];

      evidence.push({
        id: pr.number,
        title: pr.title,
        url: pr.html_url,
        merged_at: pr.merged_at,
        has_review: hasReview,
        reviewers: reviewers,
        collected_at: collectedAt
      });
    }

    // Store in history
    evidenceHistory.push({
      collected_at: collectedAt,
      owner,
      repo,
      count: evidence.length,
      items: evidence
    });

    // Keep only last 10 collections
    if (evidenceHistory.length > 10) evidenceHistory.shift();

    res.json({ collected_at: collectedAt, evidence });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get history
app.get('/api/history', (req, res) => {
  res.json(evidenceHistory);
});

// API: Export latest as JSON
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
