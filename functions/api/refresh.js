// Dedicated endpoint for triggering background refresh tasks.
// Called by GitHub Actions cron every 15 minutes.

import { jsonResponse, corsHeaders } from './_auth.js';
import { refreshStaleGithubData, scanForMentions, backfillMentions, scanGithubContributors, scanGithubEvents, discoverWebsites } from './_tasks.js';

// Time budget: return before the caller's timeout.
// Curl uses --max-time 60, so we aim to finish within 50s.
const TIME_BUDGET_MS = 50_000;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const secret = url.searchParams.get('key');
  const expectedKey = context.env.REFRESH_KEY;

  // If REFRESH_KEY is set in env, require it for access
  if (expectedKey && secret !== expectedKey) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders());
  }

  const start = Date.now();
  const deadline = start + TIME_BUDGET_MS;
  const reset = url.searchParams.get('reset') === 'true';
  const opts = { deadline };

  // GitHub data refresh is read-only on items, safe to run first
  const ghResult = await refreshStaleGithubData(context.env, opts);

  // Run item-mutating scans sequentially to avoid KV write conflicts
  const mentionResult = Date.now() < deadline
    ? await scanForMentions(context.env, { reset, deadline })
    : { scanned: false, reason: 'time_budget' };

  const contributorResult = Date.now() < deadline
    ? await scanGithubContributors(context.env, opts)
    : { scannedRepos: 0, timedOut: true };

  const eventResult = Date.now() < deadline
    ? await scanGithubEvents(context.env, opts)
    : { scannedRepos: 0, timedOut: true };

  const websiteResult = Date.now() < deadline
    ? await discoverWebsites(context.env, opts)
    : { scannedRepos: 0, timedOut: true };

  // Backfill operates on events KV only (not items), safe to run last
  const backfillResult = Date.now() < deadline
    ? await backfillMentions(context.env)
    : { backfilled: 0, timedOut: true };

  const elapsed = Date.now() - start;

  return jsonResponse({
    ok: true,
    elapsed: `${elapsed}ms`,
    github: ghResult,
    mentions: mentionResult,
    githubContributors: contributorResult,
    githubEvents: eventResult,
    websites: websiteResult,
    backfill: backfillResult,
    timestamp: new Date().toISOString(),
  }, 200, corsHeaders());
}
