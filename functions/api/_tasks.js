// Shared background task functions used by both items.js and refresh.js

import { recordEvent } from './_auth.js';

const KV_KEY = 'roadmap:items';
const STALE_AFTER_MS = 15 * 60 * 1000; // 15 minutes
const MENTION_SCAN_KEY = 'roadmap:mention-scan';
const MENTION_SCAN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const MESSAGE_ARCHIVE_KEY = 'roadmap:message-archive';
const MAX_ARCHIVED_MESSAGES = 2000;
const GITHUB_MAP_KEY = 'roadmap:github-map';
const GITHUB_SCAN_KEY = 'roadmap:github-scan';
const GITHUB_SCAN_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// Seed mappings: GitHub username → AIBTC agent BTC address
const SEED_GITHUB_MAPPINGS = {
  'cedarxyz': 'bc1q7zpy3kpxjzrfctz4en9k2h5sp8nwhctgz54sn5',       // Ionic Anvil
  'secret-mars': 'bc1qqaxq5vxszt0lzmr9gskv4lcx7jzrg772s4vxpp',    // Secret Mars
  'cocoa007': 'bc1qv8dt3v9kx3l7r9mnz2gj9r9n9k63frn6w6zmrt',       // Fluid Briar
  'sonic-mast': 'bc1qd0z0a8z8am9j84fk3lk5g2hutpxcreypnf2p47',     // Sonic Mast
  'arc0btc': 'bc1qlezz2cgktx0t680ymrytef92wxksywx0jaw933',         // Trustless Indra
};

export class ConcurrencyError extends Error {
  constructor() { super('Concurrent write detected'); this.name = 'ConcurrencyError'; }
}

export async function getData(env) {
  const raw = await env.ROADMAP_KV.get(KV_KEY, 'json');
  const data = raw || { version: 1, items: [] };

  // Initialize writeVersion if missing
  if (typeof data.writeVersion !== 'number') data.writeVersion = 0;

  // Lazy migration: normalize items missing new fields
  if (data.version < 5) {
    for (const item of data.items) {
      if (item.claimedBy === undefined) item.claimedBy = null;
      if (!Array.isArray(item.deliverables)) item.deliverables = [];
      if (!Array.isArray(item.ratings)) item.ratings = [];
      if (!item.reputation) item.reputation = { average: 0, count: 0 };
      if (!Array.isArray(item.goals)) item.goals = [];
      if (!item.mentions) item.mentions = { count: 0 };
    }
    data.version = 5;
  }

  // v5→v6: add explicit leader field
  if (data.version < 6) {
    for (const item of data.items) {
      if (!item.leader) {
        const source = item.claimedBy || item.founder;
        if (source) {
          item.leader = {
            btcAddress: source.btcAddress,
            displayName: source.displayName,
            agentId: source.agentId,
            profileUrl: source.profileUrl || `https://aibtc.com/agents/${source.btcAddress}`,
            assignedAt: source.claimedAt || item.createdAt || new Date().toISOString(),
            lastActiveAt: item.updatedAt || item.createdAt || new Date().toISOString(),
          };
        } else {
          item.leader = null;
        }
      }
    }
    data.version = 6;
  }

  // v6→v7: add searchTerms field
  if (data.version < 7) {
    for (const item of data.items) {
      if (!Array.isArray(item.searchTerms)) item.searchTerms = [];
    }
    data.version = 7;
  }

  // v7→v8: add website field
  if (data.version < 8) {
    for (const item of data.items) {
      if (item.website === undefined) {
        if (item.githubData?.homepage) {
          item.website = { url: item.githubData.homepage, source: 'homepage', discoveredAt: new Date().toISOString() };
        } else {
          item.website = null;
        }
      }
    }
    data.version = 8;
  }

  // v8→v9: re-discover websites with improved filtering (bump to v10 for second pass)
  if (data.version < 10) {
    for (const item of data.items) {
      if (item.website && item.website.source !== 'homepage') {
        item.website = null; // will be re-discovered by discoverWebsites()
      }
    }
    data.version = 10;
  }

  return data;
}

// Add agent to contributors list if not already present
export function addContributor(item, agent) {
  if (!agent?.btcAddress) return;
  if (!item.contributors) item.contributors = [];
  const exists = item.contributors.some(c => c.btcAddress === agent.btcAddress);
  if (!exists) {
    item.contributors.push({
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId || null,
    });
  }
}

export async function saveData(env, data) {
  // Optimistic concurrency: check version hasn't changed since read
  const expectedVersion = data.writeVersion || 0;
  const current = await env.ROADMAP_KV.get(KV_KEY, 'json');
  const currentVersion = current?.writeVersion || 0;
  if (currentVersion !== expectedVersion) {
    throw new ConcurrencyError();
  }
  data.writeVersion = expectedVersion + 1;
  data.updatedAt = new Date().toISOString();
  await env.ROADMAP_KV.put(KV_KEY, JSON.stringify(data));
}

// Best-effort save for background tasks: on conflict, re-read version and retry with backoff
async function saveRetry(env, data, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await saveData(env, data);
      return;
    } catch (err) {
      if (err.name !== 'ConcurrencyError') throw err;
      console.error(`[saveRetry] conflict attempt ${attempt}/${maxRetries}`);
      if (attempt === maxRetries) throw err;
      const backoff = Math.min(100 * Math.pow(2, attempt - 1), 5000);
      await new Promise(r => setTimeout(r, backoff));
      const fresh = await env.ROADMAP_KV.get(KV_KEY, 'json');
      data.writeVersion = fresh?.writeVersion || 0;
    }
  }
}

export function parseGithubUrl(url) {
  if (!url) return null;
  // Match issue or PR
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], type: m[3] === 'pull' ? 'pr' : 'issue', number: parseInt(m[4]) };
  // Match repo URL (e.g. github.com/org/repo)
  const r = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (r) return { owner: r[1], repo: r[2], type: 'repo', number: null };
  return null;
}

export async function fetchGithubData(url, env) {
  try {
    const parsed = parseGithubUrl(url);
    if (!parsed) return null;

    let endpoint;
    if (parsed.type === 'repo') {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
    } else if (parsed.type === 'pr') {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    } else {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
    }

    const headers = {
      'User-Agent': 'aibtc-projects/1.0',
      Accept: 'application/vnd.github+json',
    };
    // Use GitHub token if available (avoids 403 from shared Cloudflare IPs)
    const token = env?.GITHUB_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(endpoint, { headers });
    if (!res.ok) {
      if (res.status === 404) return { _notFound: true };
      return null;
    }

    const d = await res.json();

    if (parsed.type === 'repo') {
      return {
        type: 'repo',
        number: null,
        title: d.description || d.full_name,
        state: d.archived ? 'archived' : 'active',
        merged: false,
        assignees: [],
        labels: d.topics || [],
        stars: d.stargazers_count,
        homepage: d.homepage || null,
        ownerLogin: d.owner?.login || null,
        fetchedAt: new Date().toISOString(),
      };
    }

    return {
      type: parsed.type,
      number: parsed.number,
      title: d.title,
      state: d.state,
      merged: d.merged || false,
      assignees: (d.assignees || []).map(a => a.login),
      labels: (d.labels || []).map(l => l.name),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[fetchGithubData]', url, err);
    return null;
  }
}

// Derive status from GitHub state — single source of truth
export function deriveStatus(item) {
  const gd = item.githubData;
  if (!gd || !gd.type) return 'todo';
  if (gd.type === 'repo') return gd.state === 'archived' ? 'done' : 'in-progress';
  if (gd.type === 'pr') {
    if (gd.merged) return 'done';
    if (gd.state === 'closed') return 'blocked';
    return 'in-progress';
  }
  // issue
  return gd.state === 'closed' ? 'done' : 'in-progress';
}

// Refresh stale GitHub data in the background
export async function refreshStaleGithubData(env) {
  const data = await getData(env);
  const now = Date.now();
  let changed = false;
  let refreshedCount = 0;
  const autoCompleteEvents = [];

  for (const item of data.items) {
    if (!item.githubUrl) continue;
    const fetchedAt = item.githubData?.fetchedAt ? new Date(item.githubData.fetchedAt).getTime() : 0;
    if (now - fetchedAt < STALE_AFTER_MS) continue;

    const fresh = await fetchGithubData(item.githubUrl, env);
    if (!fresh) continue;

    // Auto-archive repos that return 404
    if (fresh._notFound) {
      const fails = (item.githubData?._notFoundCount || 0) + 1;
      if (fails >= 3 && item.githubData?.state !== 'archived') {
        item.githubData = { ...item.githubData, state: 'archived', _notFoundCount: fails, fetchedAt: new Date().toISOString() };
        item.updatedAt = new Date().toISOString();
        changed = true;
        autoCompleteEvents.push({ itemId: item.id, itemTitle: item.title, oldStatus: deriveStatus(item), newStatus: 'done' });
        console.error('[refreshStaleGithubData] auto-archived', item.githubUrl, 'after', fails, '404s');
      } else {
        item.githubData = { ...item.githubData, _notFoundCount: fails, fetchedAt: new Date().toISOString() };
        changed = true;
      }
      continue;
    }

    // Track status transitions from GitHub state changes
    const oldStatus = deriveStatus(item);
    item.githubData = fresh;
    const newStatus = deriveStatus(item);
    if (oldStatus !== newStatus) {
      autoCompleteEvents.push({ itemId: item.id, itemTitle: item.title, oldStatus, newStatus });
    }
    item.updatedAt = new Date().toISOString();
    changed = true;
    refreshedCount++;
  }

  if (changed) {
    await saveRetry(env, data);
    for (const ev of autoCompleteEvents) {
      await recordEvent(env, {
        type: 'item.status_synced',
        agent: null,
        itemId: ev.itemId,
        itemTitle: ev.itemTitle,
        data: { oldStatus: ev.oldStatus, newStatus: ev.newStatus, reason: 'github_state' },
      });
    }
  }

  return { refreshedCount, statusChanges: autoCompleteEvents.length };
}

// ── Mention Matching ──
// Build an array of match terms for an item, ordered by specificity.
// Each term: { text: string, type: 'title'|'slug'|'url'|'site', minLen: number }
export function getMatchTerms(item) {
  const terms = [];
  const titleLower = (item.title || '').toLowerCase();

  // 1. Full title (high specificity, always valid)
  if (titleLower) terms.push({ text: titleLower, type: 'title' });

  // 2. Title parts split on em-dash/en-dash/pipe — match short name independently
  //    e.g. "Signal — AI Agent Intelligence Network" → ["signal", "ai agent intelligence network"]
  const titleParts = titleLower.split(/\s*[—–|]\s*/).map(p => p.trim()).filter(p => p.length > 3);
  for (const part of titleParts) {
    if (part !== titleLower) terms.push({ text: part, type: 'title' });
  }

  // 3. Slugified versions of each title part (hyphenated)
  //    e.g. "aibtc projects" → "aibtc-projects"
  for (const part of [titleLower, ...titleParts]) {
    const slug = part.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug.length > 3 && slug !== part) terms.push({ text: slug, type: 'slug' });
  }

  // 4. GitHub URL, path, and repo name (multiple variants)
  const ghPath = item.githubUrl
    ? item.githubUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '').toLowerCase()
    : null;
  if (ghPath) {
    // Full URL
    terms.push({ text: item.githubUrl.toLowerCase(), type: 'url' });
    // Path like "aibtcdev/skills"
    terms.push({ text: ghPath, type: 'url' });
    // Repo name like "arc-starter"
    const repoName = ghPath.split('/').pop();
    // Min 8 chars for standalone repo name to avoid false positives (e.g. "skills")
    if (repoName && repoName.length >= 8) {
      terms.push({ text: repoName, type: 'url' });
      // Repo name with spaces: "arc-starter" → "arc starter"
      const repoSpaced = repoName.replace(/-/g, ' ');
      if (repoSpaced !== repoName) terms.push({ text: repoSpaced, type: 'url' });
    }
  }

  // 5. Homepage hostname (skip overly generic domains)
  const homepage = item.githubData?.homepage;
  if (homepage) {
    try {
      const host = new URL(homepage).hostname.toLowerCase();
      const GENERIC_HOSTS = ['aibtc.com', 'github.com', 'stacks.co', 'bitcoin.org'];
      if (!GENERIC_HOSTS.includes(host) && host.length > 5) {
        terms.push({ text: host, type: 'site' });
      }
    } catch (err) {
      console.error('[getMatchTerms] bad homepage URL', homepage, err);
    }
  }

  // 6. Custom search terms (manually curated per item)
  if (Array.isArray(item.searchTerms)) {
    for (const t of item.searchTerms) {
      if (t.length > 2) terms.push({ text: t, type: 'alias' });
    }
  }

  // Deduplicate terms by text
  const seen = new Set();
  return terms.filter(t => {
    if (seen.has(t.text)) return false;
    seen.add(t.text);
    return true;
  });
}

// Check if a lowercased message preview mentions a specific item.
// Returns the match type string or null.
export function matchMention(preview, item) {
  const terms = getMatchTerms(item);
  for (const term of terms) {
    if (preview.includes(term.text)) return term.type;
  }
  return null;
}

// ── Website URL Discovery Utilities ──

const NOISE_HOSTS = new Set([
  'github.com', 'www.github.com', 'docs.github.com',
  'raw.githubusercontent.com', 'user-images.githubusercontent.com',
  'avatars.githubusercontent.com', 'camo.githubusercontent.com',
  'npmjs.com', 'www.npmjs.com',
  'shields.io', 'img.shields.io', 'badge.fury.io',
  'coveralls.io', 'codecov.io',
  'travis-ci.org', 'travis-ci.com', 'circleci.com',
  'david-dm.org', 'gitter.im',
  'localhost', 'example.com',
  'crates.io', 'pypi.org', 'rubygems.org',
  'bun.sh', 'bun.com', 'deno.land', 'deno.com', 'nodejs.org',
]);

// URL path patterns that indicate non-deployment pages (profiles, docs, etc.)
const NOISE_PATHS = [
  /^\/agents\//,   // aibtc.com agent profile links
  /^\/api\//,      // API endpoints
  /^\/install\b/,  // install scripts (e.g. curl ... | sh)
  /^\/raw\//,      // raw file endpoints
];

// URLs that belong to this application itself (project board) — excluded from
// deliverable/message sources but allowed in README/description/homepage sources
const SELF_HOSTS = new Set(['aibtc-projects.pages.dev']);

function isDeploymentUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (NOISE_HOSTS.has(host)) return 0;
    // Filter out known non-deployment URL patterns
    if (NOISE_PATHS.some(p => p.test(parsed.pathname))) return 0;
    if (host.endsWith('.pages.dev')) return 10;
    if (host.endsWith('.vercel.app')) return 10;
    if (host.endsWith('.netlify.app')) return 10;
    if (host.endsWith('.workers.dev')) return 9;
    if (host.endsWith('.herokuapp.com')) return 8;
    if (host.endsWith('.fly.dev')) return 8;
    if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) return 8;
    if (host.endsWith('.onrender.com')) return 8;
    if (host.endsWith('.surge.sh')) return 7;
    if (host.endsWith('.github.io')) return 7;
    // Custom domains (not a known noise host)
    if (!host.includes('github') && !host.includes('npm')) return 6;
    return 0;
  } catch { return 0; }
}

function extractUrlsFromText(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>\[\]()'"`,;]+/gi) || [];
  return matches.map(u => u.replace(/[.)]+$/, ''));
}

const URL_CONTEXT_KEYWORDS = /\b(live|demo|website|deployed|homepage|visit|hosted|app|try it|production|dashboard)\b/i;
const URL_NEGATIVE_KEYWORDS = /\b(built by|created by|credits|author|maintained by|made by|powered by)\b/i;

function extractUrlFromReadme(content, skipUrls = new Set()) {
  if (!content) return null;
  const urls = extractUrlsFromText(content);
  if (urls.length === 0) return null;

  const scored = urls
    .map(url => ({ url, score: isDeploymentUrl(url) }))
    .filter(u => u.score > 0 && !skipUrls.has(u.url));
  if (scored.length === 0) return null;

  // Bonus for URLs near contextual keywords, penalty near credits/author sections
  for (const s of scored) {
    const idx = content.indexOf(s.url);
    if (idx !== -1) {
      const ctx = content.slice(Math.max(0, idx - 200), idx);
      if (URL_CONTEXT_KEYWORDS.test(ctx)) s.score += 5;
      if (URL_NEGATIVE_KEYWORDS.test(ctx)) s.score -= 4;
    }
  }

  // Require minimum score of 5 (custom domain=6 minus any penalty must still qualify)
  const best = scored.filter(s => s.score >= 5).sort((a, b) => b.score - a.score);
  return best.length > 0 ? best[0].url : null;
}

function extractUrlFromDescription(description, skipUrls = new Set()) {
  if (!description) return null;
  const urls = extractUrlsFromText(description);
  const scored = urls
    .map(url => ({ url, score: isDeploymentUrl(url) }))
    .filter(u => u.score > 0 && !skipUrls.has(u.url));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

function extractUrlFromMessages(messages, item) {
  if (!messages || messages.length === 0) return null;
  const urlCounts = new Map();

  for (const msg of messages) {
    const preview = (msg.messagePreview || '').toLowerCase();
    if (!matchMention(preview, item)) continue;
    const urls = extractUrlsFromText(msg.messagePreview || '');
    for (const url of urls) {
      if (isDeploymentUrl(url) === 0) continue;
      try { if (SELF_HOSTS.has(new URL(url).hostname.toLowerCase())) continue; } catch {}
      urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
    }
  }

  if (urlCounts.size === 0) return null;
  let best = null, bestCount = 0;
  for (const [url, count] of urlCounts) {
    if (count > bestCount || (count === bestCount && isDeploymentUrl(url) > isDeploymentUrl(best))) {
      best = url;
      bestCount = count;
    }
  }
  return best;
}

// ── Mention Scanning ──
export async function scanForMentions(env, { reset = false } = {}) {
  // Check cooldown to avoid scanning on every request (skip on reset)
  const scanMeta = await env.ROADMAP_KV.get(MENTION_SCAN_KEY, 'json');
  if (!reset) {
    const lastScan = scanMeta?.lastScanAt ? new Date(scanMeta.lastScanAt).getTime() : 0;
    if (Date.now() - lastScan < MENTION_SCAN_COOLDOWN_MS) {
      return { scanned: false, reason: 'cooldown' };
    }
  }

  const processedIds = reset ? new Set() : new Set(scanMeta?.processedIds || []);

  // Fetch AIBTC network activity
  let activityEvents;
  try {
    const res = await fetch('https://aibtc.com/api/activity', {
      headers: { 'User-Agent': 'aibtc-projects/1.0' },
    });
    if (!res.ok) return { scanned: false, reason: 'api_error' };
    const body = await res.json();
    activityEvents = body.events || [];
  } catch (err) {
    console.error('[scanForMentions] activity fetch failed', err);
    return { scanned: false, reason: 'fetch_error' };
  }

  // Archive all message events for future reset scans
  const messageEvents = activityEvents.filter(e => e.type === 'message' && e.messagePreview);
  await archiveMessages(env, messageEvents);

  // On reset, merge archive with live events so old messages aren't lost
  if (reset && messageEvents.length > 0) {
    const archived = await getArchivedMessages(env);
    const liveTimestamps = new Set(messageEvents.map(e => e.timestamp));
    for (const msg of archived) {
      if (!liveTimestamps.has(msg.timestamp) && msg.messagePreview) {
        messageEvents.push(msg);
      }
    }
  }

  const sourceEvents = reset ? messageEvents : activityEvents;
  if (sourceEvents.length === 0) return { scanned: true, newMentions: 0 };

  // Filter to unprocessed message events that have preview text
  const newEvents = sourceEvents.filter(e =>
    (e.type === 'message' || reset) && e.messagePreview && !processedIds.has(e.timestamp)
  );

  if (newEvents.length === 0) {
    // Update scan time even if no new events
    await env.ROADMAP_KV.put(MENTION_SCAN_KEY, JSON.stringify({
      lastScanAt: new Date().toISOString(),
      processedIds: [...processedIds].slice(-500),
    }));
    return { scanned: true, newMentions: 0 };
  }

  const data = await getData(env);
  let changed = false;
  const mentionEvents = [];

  // On reset, zero out all mention counts before re-scanning
  if (reset) {
    for (const item of data.items) {
      if (item.mentions) item.mentions.count = 0;
    }
    changed = true;
  }

  for (const ev of newEvents) {
    const preview = (ev.messagePreview || '').toLowerCase();
    processedIds.add(ev.timestamp);

    for (const item of data.items) {
      const matchResult = matchMention(preview, item);
      if (matchResult) {
        if (!item.mentions) item.mentions = { count: 0 };
        item.mentions.count += 1;
        // Auto-add mentioning agent as contributor
        if (ev.agent?.btcAddress) {
          addContributor(item, {
            btcAddress: ev.agent.btcAddress,
            displayName: ev.agent.displayName,
            agentId: null,
          });
        }
        changed = true;
        mentionEvents.push({
          itemId: item.id,
          itemTitle: item.title,
          agent: ev.agent || null,
          recipient: ev.recipient || null,
          messagePreview: ev.messagePreview || null,
          matchType: matchResult,
        });
      }
    }
  }

  // Save updated mention counts
  if (changed) {
    await saveRetry(env, data);
  }

  // Record mention events in the activity feed (skip on reset to avoid duplicates
  // and timeouts — the /api/mentions endpoint reads directly from the archive)
  if (!reset) {
    for (const me of mentionEvents) {
      await recordEvent(env, {
        type: 'item.mentioned',
        agent: me.agent ? { btcAddress: me.agent.btcAddress, displayName: me.agent.displayName, agentId: null } : null,
        itemId: me.itemId,
        itemTitle: me.itemTitle,
        data: {
          matchType: me.matchType,
          messagePreview: me.messagePreview || null,
          recipient: me.recipient ? { btcAddress: me.recipient.btcAddress, displayName: me.recipient.displayName } : null,
        },
      });
    }
  }

  // Save scan metadata
  await env.ROADMAP_KV.put(MENTION_SCAN_KEY, JSON.stringify({
    lastScanAt: new Date().toISOString(),
    processedIds: [...processedIds].slice(-500),
  }));

  return { scanned: true, newMentions: mentionEvents.length };
}

// ── Backfill existing mention events with message preview + recipient ──
const EVENTS_KEY = 'roadmap:events';

export async function backfillMentions(env) {
  // 1. Read current events from KV
  const raw = await env.ROADMAP_KV.get(EVENTS_KEY, 'json');
  if (!raw || !raw.events) return { backfilled: 0, total: 0 };

  // Find mention events missing messagePreview
  const mentionEvents = raw.events.filter(e =>
    e.type === 'item.mentioned' && !e.data?.messagePreview
  );
  if (mentionEvents.length === 0) return { backfilled: 0, total: 0 };

  // 2. Fetch AIBTC activity to get the original messages
  let activityEvents;
  try {
    const res = await fetch('https://aibtc.com/api/activity', {
      headers: { 'User-Agent': 'aibtc-projects/1.0' },
    });
    if (!res.ok) return { backfilled: 0, error: 'activity_api_error' };
    const body = await res.json();
    activityEvents = (body.events || []).filter(e => e.type === 'message' && e.messagePreview);
  } catch (err) {
    console.error('[backfillMentions] activity fetch failed', err);
    return { backfilled: 0, error: 'fetch_error' };
  }

  if (activityEvents.length === 0) return { backfilled: 0, total: mentionEvents.length };

  // 3. Load items for matching
  const data = await getData(env);
  let backfilled = 0;

  for (const mentionEv of mentionEvents) {
    const item = data.items.find(i => i.id === mentionEv.itemId);
    if (!item) continue;

    // Find a matching activity event from the same agent using shared match logic
    const senderAddr = mentionEv.agent?.btcAddress;
    const match = activityEvents.find(ae => {
      if (senderAddr && ae.agent?.btcAddress !== senderAddr) return false;
      const preview = ae.messagePreview.toLowerCase();
      return matchMention(preview, item) !== null;
    });

    if (match) {
      mentionEv.data.messagePreview = match.messagePreview;
      if (match.recipient) {
        mentionEv.data.recipient = {
          btcAddress: match.recipient.btcAddress,
          displayName: match.recipient.displayName,
        };
      }
      backfilled++;
      // Remove matched event so it doesn't match again for duplicate mentions
      const matchIdx = activityEvents.indexOf(match);
      if (matchIdx !== -1) activityEvents.splice(matchIdx, 1);
    }
  }

  // 4. Save updated events back
  if (backfilled > 0) {
    await env.ROADMAP_KV.put(EVENTS_KEY, JSON.stringify(raw));
  }

  return { backfilled, total: mentionEvents.length };
}

// ── Message Archival ──
// Persist all processed messages so reset scans don't lose history.

async function getArchivedMessages(env) {
  const raw = await env.ROADMAP_KV.get(MESSAGE_ARCHIVE_KEY, 'json');
  return raw?.messages || [];
}

async function archiveMessages(env, messageEvents) {
  if (!messageEvents || messageEvents.length === 0) return;
  const existing = await getArchivedMessages(env);
  const timestamps = new Set(existing.map(m => m.timestamp));

  let added = 0;
  for (const ev of messageEvents) {
    if (!ev.timestamp || timestamps.has(ev.timestamp)) continue;
    existing.push({
      timestamp: ev.timestamp,
      agent: ev.agent ? { btcAddress: ev.agent.btcAddress, displayName: ev.agent.displayName } : null,
      recipient: ev.recipient ? { btcAddress: ev.recipient.btcAddress, displayName: ev.recipient.displayName } : null,
      messagePreview: ev.messagePreview || null,
    });
    timestamps.add(ev.timestamp);
    added++;
  }

  if (added > 0) {
    // Sort newest first, cap at limit
    existing.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const trimmed = existing.slice(0, MAX_ARCHIVED_MESSAGES);
    await env.ROADMAP_KV.put(MESSAGE_ARCHIVE_KEY, JSON.stringify({ version: 1, messages: trimmed }));
  }
  return added;
}

// ── GitHub Username → AIBTC Agent Mapping ──

async function getGithubMapping(env) {
  const raw = await env.ROADMAP_KV.get(GITHUB_MAP_KEY, 'json');
  if (raw?.mappings) return raw;
  // First run: initialize with seed mappings
  const initial = { version: 1, mappings: { ...SEED_GITHUB_MAPPINGS } };
  await env.ROADMAP_KV.put(GITHUB_MAP_KEY, JSON.stringify(initial));
  return initial;
}

async function resolveGithubUser(env, username, mapping) {
  const btcAddress = mapping.mappings[username.toLowerCase()];
  if (!btcAddress) return null;

  // Try agent cache first
  const cacheKey = `roadmap:agent-cache:${btcAddress}`;
  const cached = await env.ROADMAP_KV.get(cacheKey, 'json');
  if (cached) return { btcAddress: cached.btcAddress, displayName: cached.displayName, agentId: cached.agentId || null };

  // Fetch from AIBTC API
  try {
    const res = await fetch(`https://aibtc.com/api/agents/${encodeURIComponent(btcAddress)}`, {
      headers: { 'User-Agent': 'aibtc-projects/1.0' },
    });
    if (!res.ok) return { btcAddress, displayName: username, agentId: null };
    const data = await res.json();
    if (!data.found) return { btcAddress, displayName: username, agentId: null };
    const agent = {
      btcAddress: data.agent.btcAddress,
      displayName: data.agent.displayName || username,
      agentId: data.agent.erc8004AgentId || null,
    };
    // Cache for 1 hour
    await env.ROADMAP_KV.put(cacheKey, JSON.stringify(agent), { expirationTtl: 3600 });
    return agent;
  } catch (err) {
    console.error('[resolveGithubUser]', username, err);
    return { btcAddress, displayName: username, agentId: null };
  }
}

// ── GitHub Contributor Scanning ──

function githubHeaders(env) {
  const headers = { 'User-Agent': 'aibtc-projects/1.0', Accept: 'application/vnd.github+json' };
  const token = env?.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export async function scanGithubContributors(env) {
  const scanState = await env.ROADMAP_KV.get(GITHUB_SCAN_KEY, 'json') || { version: 1, repos: {} };
  const mapping = await getGithubMapping(env);
  const data = await getData(env);
  const now = Date.now();
  let changed = false;
  let newContributors = 0;
  const scannedRepos = [];
  const unmappedUsers = [];
  const errors = [];

  for (const item of data.items) {
    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== 'repo') continue;
    if (item.githubData?.state === 'archived') continue; // skip dead repos

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState = scanState.repos[repoPath] || {};
    const lastScan = repoState.contributors ? new Date(repoState.contributors).getTime() : 0;
    // Back off: after 3+ consecutive failures, wait 1 hour instead of 15 minutes
    const cooldown = (repoState.contributorFails || 0) >= 3
      ? 60 * 60 * 1000
      : GITHUB_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    try {
      const res = await fetch(`https://api.github.com/repos/${repoPath}/contributors?per_page=30`, {
        headers: githubHeaders(env),
      });
      if (!res.ok) {
        errors.push(`${repoPath}: HTTP ${res.status}`);
        scanState.repos[repoPath] = { ...repoState, contributors: new Date().toISOString(), contributorFails: (repoState.contributorFails || 0) + 1 };
        continue;
      }
      const contributors = await res.json();
      if (!Array.isArray(contributors)) {
        errors.push(`${repoPath}: non-array response`);
        scanState.repos[repoPath] = { ...repoState, contributors: new Date().toISOString(), contributorFails: (repoState.contributorFails || 0) + 1 };
        continue;
      }

      for (const c of contributors) {
        if (!c.login || c.type === 'Bot') continue;
        const agent = await resolveGithubUser(env, c.login, mapping);
        if (agent) {
          const before = (item.contributors || []).length;
          addContributor(item, agent);
          if ((item.contributors || []).length > before) {
            changed = true;
            newContributors++;
          }
        } else if (!unmappedUsers.includes(c.login)) {
          unmappedUsers.push(c.login);
        }
      }

      scanState.repos[repoPath] = { ...repoState, contributors: new Date().toISOString(), contributorFails: 0 };
      scannedRepos.push(repoPath);
    } catch (err) {
      errors.push(`${repoPath}: ${err.message}`);
      scanState.repos[repoPath] = { ...repoState, contributors: new Date().toISOString(), contributorFails: (repoState.contributorFails || 0) + 1 };
    }
  }

  if (changed) await saveRetry(env, data);
  await env.ROADMAP_KV.put(GITHUB_SCAN_KEY, JSON.stringify(scanState));

  return { scannedRepos: scannedRepos.length, newContributors, unmappedUsers, errors };
}

// ── GitHub Event Detection (Merged PRs → Deliverables) ──

export async function scanGithubEvents(env) {
  const scanState = await env.ROADMAP_KV.get(GITHUB_SCAN_KEY, 'json') || { version: 1, repos: {} };
  const mapping = await getGithubMapping(env);
  const data = await getData(env);
  const now = Date.now();
  let changed = false;
  let newDeliverables = 0;
  let newContributors = 0;
  const scannedRepos = [];
  const errors = [];

  for (const item of data.items) {
    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== 'repo') continue;
    if (item.githubData?.state === 'archived') continue; // skip dead repos

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState = scanState.repos[repoPath] || {};
    const lastScan = repoState.events ? new Date(repoState.events).getTime() : 0;
    // Back off: after 3+ consecutive failures, wait 1 hour instead of 15 minutes
    const cooldown = (repoState.eventFails || 0) >= 3
      ? 60 * 60 * 1000
      : GITHUB_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoPath}/pulls?state=closed&sort=updated&direction=desc&per_page=10`,
        { headers: githubHeaders(env) }
      );
      if (!res.ok) {
        errors.push(`${repoPath}: HTTP ${res.status}`);
        scanState.repos[repoPath] = { ...repoState, events: new Date().toISOString(), eventFails: (repoState.eventFails || 0) + 1 };
        continue;
      }
      const pulls = await res.json();

      for (const pr of pulls) {
        if (!pr.merged_at) continue;
        // Skip bot PRs (release-please, dependabot, etc.)
        if (pr.user?.type === 'Bot' || pr.user?.login?.endsWith('[bot]')) continue;
        // Only process PRs merged since last scan (or all if first scan)
        if (lastScan > 0 && new Date(pr.merged_at).getTime() <= lastScan) continue;

        // Check for duplicate deliverable (match on PR URL)
        if (!Array.isArray(item.deliverables)) item.deliverables = [];
        const alreadyExists = item.deliverables.some(d => d.url === pr.html_url);
        if (alreadyExists) continue;

        // Resolve PR author
        const agent = pr.user?.login ? await resolveGithubUser(env, pr.user.login, mapping) : null;

        item.deliverables.push({
          title: pr.title,
          url: pr.html_url,
          addedAt: new Date().toISOString(),
          addedBy: agent || { displayName: pr.user?.login || 'unknown' },
        });
        changed = true;
        newDeliverables++;

        // Add PR author as contributor
        if (agent) {
          const before = (item.contributors || []).length;
          addContributor(item, agent);
          if ((item.contributors || []).length > before) newContributors++;
        }

        // Record event
        await recordEvent(env, {
          type: 'item.deliverable_added',
          agent: agent || null,
          itemId: item.id,
          itemTitle: item.title,
          data: { title: pr.title, url: pr.html_url, source: 'github_pr' },
        });
      }

      scanState.repos[repoPath] = { ...repoState, events: new Date().toISOString(), eventFails: 0 };
      scannedRepos.push(repoPath);
    } catch (err) {
      errors.push(`${repoPath}: ${err.message}`);
      scanState.repos[repoPath] = { ...repoState, events: new Date().toISOString(), eventFails: (repoState.eventFails || 0) + 1 };
    }
  }

  if (changed) await saveRetry(env, data);
  await env.ROADMAP_KV.put(GITHUB_SCAN_KEY, JSON.stringify(scanState));

  return { scannedRepos: scannedRepos.length, newDeliverables, newContributors, errors };
}

// ── Website URL Discovery ──

const WEBSITE_SCAN_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export async function discoverWebsites(env) {
  const scanState = await env.ROADMAP_KV.get(GITHUB_SCAN_KEY, 'json') || { version: 1, repos: {} };

  // One-time: reset website scan cooldowns when filter rules change
  if (!scanState.websiteFilterVersion || scanState.websiteFilterVersion < 5) {
    for (const rp of Object.keys(scanState.repos)) {
      delete scanState.repos[rp].website;
      delete scanState.repos[rp].websiteFails;
    }
    scanState.websiteFilterVersion = 5;
  }

  const data = await getData(env);
  const now = Date.now();
  let changed = false;
  let discovered = 0;
  const scannedRepos = [];
  const errors = [];
  let archivedMessages = null; // lazy-load

  // Build set of already-claimed website URLs to prevent cross-project conflicts
  const claimedUrls = new Set();
  for (const it of data.items) {
    if (it.website?.url) claimedUrls.add(it.website.url);
  }

  for (const item of data.items) {
    // If homepage source, keep in sync with githubData.homepage
    if (item.website?.source === 'homepage' && item.githubData?.homepage && item.website.url !== item.githubData.homepage) {
      item.website.url = item.githubData.homepage;
      item.website.discoveredAt = new Date().toISOString();
      changed = true;
    }
    // Re-evaluate existing websites that now fail the noise filter or are claimed by another project
    const shouldClear = item.website && (
      isDeploymentUrl(item.website.url) === 0 ||
      // Clear non-homepage sources if another item already has a homepage claim on this URL
      (item.website.source !== 'homepage' && [...data.items].some(
        other => other !== item && other.website?.url === item.website.url && other.website?.source === 'homepage'
      ))
    );
    if (shouldClear) {
      claimedUrls.delete(item.website.url);
      item.website = null;
      changed = true;
      // Reset scan cooldown so this repo gets re-scanned immediately
      const p = parseGithubUrl(item.githubUrl);
      if (p) {
        const rp = `${p.owner}/${p.repo}`;
        if (scanState.repos[rp]) delete scanState.repos[rp].website;
      }
      // fall through to re-discover below
    }
    // Skip if already discovered
    if (item.website) continue;

    const parsed = parseGithubUrl(item.githubUrl);
    if (!parsed || parsed.type !== 'repo') continue;
    if (item.githubData?.state === 'archived') continue;

    const repoPath = `${parsed.owner}/${parsed.repo}`;
    const repoState = scanState.repos[repoPath] || {};
    const lastScan = repoState.website ? new Date(repoState.website).getTime() : 0;
    const cooldown = (repoState.websiteFails || 0) >= 3 ? 6 * 60 * 60 * 1000 : WEBSITE_SCAN_COOLDOWN_MS;
    if (now - lastScan < cooldown) continue;

    let url = null;
    let source = null;

    // Priority 1: GitHub homepage
    if (item.githubData?.homepage && isDeploymentUrl(item.githubData.homepage) > 0) {
      url = item.githubData.homepage;
      source = 'homepage';
    }

    // Priority 2: GitHub description
    if (!url) {
      const descUrl = extractUrlFromDescription(item.githubData?.title, claimedUrls);
      if (descUrl) { url = descUrl; source = 'description'; }
    }

    // Priority 3: README (API call)
    if (!url) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repoPath}/readme`, {
          headers: { ...githubHeaders(env), Accept: 'application/vnd.github.raw+json' },
        });
        if (res.ok) {
          const readmeText = await res.text();
          const readmeUrl = extractUrlFromReadme(readmeText, claimedUrls);
          if (readmeUrl) { url = readmeUrl; source = 'readme'; }
        }
      } catch (err) {
        console.error('[discoverWebsites] README fetch failed', repoPath, err);
        errors.push(`${repoPath}: README fetch failed`);
        scanState.repos[repoPath] = { ...repoState, website: new Date().toISOString(), websiteFails: (repoState.websiteFails || 0) + 1 };
        continue;
      }
    }

    // Priority 4: Deliverable URLs (skip self-referencing board URLs)
    if (!url) {
      for (const d of (item.deliverables || [])) {
        if (!d.url || isDeploymentUrl(d.url) === 0) continue;
        try { if (SELF_HOSTS.has(new URL(d.url).hostname.toLowerCase())) continue; } catch {}
        url = d.url; source = 'deliverable'; break;
      }
    }

    // Priority 5: Message archive
    if (!url) {
      if (archivedMessages === null) {
        archivedMessages = await getArchivedMessages(env);
      }
      const msgUrl = extractUrlFromMessages(archivedMessages, item);
      if (msgUrl) { url = msgUrl; source = 'message'; }
    }

    // Skip if URL is already claimed by another project (avoid cross-project conflicts)
    if (url && claimedUrls.has(url)) url = null;

    if (url) {
      item.website = { url, source, discoveredAt: new Date().toISOString() };
      item.updatedAt = new Date().toISOString();
      claimedUrls.add(url);
      changed = true;
      discovered++;
    }

    scanState.repos[repoPath] = { ...repoState, website: new Date().toISOString(), websiteFails: 0 };
    scannedRepos.push(repoPath);
  }

  if (changed) await saveRetry(env, data);
  await env.ROADMAP_KV.put(GITHUB_SCAN_KEY, JSON.stringify(scanState));

  return { scannedRepos: scannedRepos.length, discovered, errors };
}
