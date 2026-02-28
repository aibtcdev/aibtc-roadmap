import { getAgent, jsonResponse, corsHeaders, recordEvent } from './_auth.js';
import { getData, saveData, ConcurrencyError, addContributor, parseGithubUrl, fetchGithubData, deriveStatus, refreshStaleGithubData, scanForMentions } from './_tasks.js';

function generateId() {
  return 'r_' + crypto.randomUUID().slice(0, 8);
}

function handleConcurrencyError(err) {
  if (err.name === 'ConcurrencyError') {
    return jsonResponse({ error: 'Another update was in progress. Please retry.' }, 409, corsHeaders());
  }
  throw err;
}

function computeReputation(ratings) {
  if (!ratings || ratings.length === 0) return { average: 0, count: 0 };
  const sum = ratings.reduce((s, r) => s + r.score, 0);
  return { average: Math.round((sum / ratings.length) * 10) / 10, count: ratings.length };
}

// addContributor is imported from _tasks.js (shared module)

// Bump leader.lastActiveAt if the acting agent is the leader
function bumpLeaderActivity(item, agent) {
  if (item.leader && item.leader.btcAddress === agent.btcAddress) {
    item.leader.lastActiveAt = new Date().toISOString();
  }
}

// OPTIONS - CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// GET - list all items (public, no auth)
// Optional query params: ?limit=N&offset=N for pagination
export async function onRequestGet(context) {
  const data = await getData(context.env);
  const url = new URL(context.request.url);

  // Derive status from GitHub state for every item
  for (const item of data.items) {
    item.status = deriveStatus(item);
  }

  // Kick off background tasks
  context.waitUntil(refreshStaleGithubData(context.env));
  context.waitUntil(scanForMentions(context.env));

  // Optional pagination — backwards compatible (no params = full list)
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  if (limitParam) {
    const limit = Math.min(Math.max(parseInt(limitParam) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam) || 0, 0);
    const total = data.items.length;
    const paged = data.items.slice(offset, offset + limit);
    return jsonResponse({ ...data, items: paged, pagination: { total, limit, offset } }, 200, corsHeaders());
  }

  return jsonResponse(data, 200, corsHeaders());
}

// POST - add a new item (AIBTC agent auth required)
export async function onRequestPost(context) {
  try { return await _handlePost(context); } catch (err) { return handleConcurrencyError(err); }
}
async function _handlePost(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  let body;
  try { body = await context.request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON in request body' }, 400, corsHeaders());
  }
  if (!body.title || !body.title.trim()) {
    return jsonResponse({ error: 'Title is required' }, 400, corsHeaders());
  }
  if (!body.githubUrl || !body.githubUrl.trim()) {
    return jsonResponse({ error: 'githubUrl is required. Provide a link to an open source GitHub repo.' }, 400, corsHeaders());
  }
  const ghUrl = body.githubUrl.trim();
  if (!ghUrl.match(/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/)) {
    return jsonResponse({ error: 'githubUrl must be a valid GitHub URL.' }, 400, corsHeaders());
  }

  // Must be a repo URL (not an issue or PR)
  const parsed = parseGithubUrl(ghUrl);
  if (!parsed || parsed.type !== 'repo') {
    return jsonResponse({ error: 'githubUrl must point to a GitHub repo (e.g. github.com/org/repo), not an issue or PR.' }, 400, corsHeaders());
  }

  // Fetch GitHub metadata (non-blocking — rate limits shouldn't prevent submission)
  const ghData = await fetchGithubData(ghUrl, context.env) || {
    type: 'repo', number: null, title: body.title.trim(),
    state: 'active', merged: false, assignees: [], labels: [], stars: 0,
    fetchedAt: null, // null signals "needs refresh" to the GET stale-check
  };

  const now = new Date().toISOString();
  const item = {
    id: generateId(),
    title: body.title.trim(),
    description: (body.description || '').trim(),
    githubUrl: ghUrl,
    githubData: ghData,
    founder: {
      displayName: agent.displayName,
      btcAddress: agent.btcAddress,
      agentId: agent.agentId,
      profileUrl: `https://aibtc.com/agents/${agent.btcAddress}`,
    },
    contributors: [{
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
    }],
    leader: {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
      profileUrl: `https://aibtc.com/agents/${agent.btcAddress}`,
      assignedAt: now,
      lastActiveAt: now,
    },
    status: deriveStatus({ githubData: ghData }),
    claimedBy: null,
    deliverables: [],
    ratings: [],
    reputation: { average: 0, count: 0 },
    goals: [],
    mentions: { count: 0 },
    createdAt: now,
    updatedAt: now,
  };

  const data = await getData(context.env);
  data.items.push(item);
  await saveData(context.env, data);

  context.waitUntil(recordEvent(context.env, {
    type: 'item.created',
    agent,
    itemId: item.id,
    itemTitle: item.title,
    data: { status: item.status },
  }));

  return jsonResponse({ item, position: data.items.length - 1 }, 201, corsHeaders());
}

// PUT - update an item (AIBTC agent auth required)
export async function onRequestPut(context) {
  try { return await _handlePut(context); } catch (err) { return handleConcurrencyError(err); }
}
async function _handlePut(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  let body;
  try { body = await context.request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON in request body' }, 400, corsHeaders());
  }
  if (!body.id) return jsonResponse({ error: 'Item id is required' }, 400, corsHeaders());

  const data = await getData(context.env);
  const idx = data.items.findIndex(i => i.id === body.id);
  if (idx === -1) return jsonResponse({ error: 'Item not found' }, 404, corsHeaders());

  const item = data.items[idx];

  // ── Claim action ──
  if (body.action === 'claim') {
    if (item.claimedBy) {
      return jsonResponse({ error: 'Item is already claimed', claimedBy: item.claimedBy }, 409, corsHeaders());
    }
    item.claimedBy = {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
      claimedAt: new Date().toISOString(),
    };
    addContributor(item, agent);
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.claimed',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: {},
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Unclaim action ──
  if (body.action === 'unclaim') {
    if (!item.claimedBy) {
      return jsonResponse({ error: 'Item is not claimed' }, 400, corsHeaders());
    }
    if (item.claimedBy.btcAddress !== agent.btcAddress) {
      return jsonResponse({ error: 'Only the claimant can unclaim' }, 403, corsHeaders());
    }
    item.claimedBy = null;
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.unclaimed',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: {},
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Add deliverable ──
  if (body.deliverable) {
    const d = body.deliverable;
    if (!d.url || !d.url.trim()) {
      return jsonResponse({ error: 'deliverable.url is required' }, 400, corsHeaders());
    }
    try { new URL(d.url.trim()); } catch {
      return jsonResponse({ error: 'deliverable.url must be a valid URL' }, 400, corsHeaders());
    }
    if (!Array.isArray(item.deliverables)) item.deliverables = [];
    item.deliverables.push({
      id: 'd_' + crypto.randomUUID().slice(0, 8),
      url: d.url.trim(),
      title: (d.title || d.url.trim()).trim(),
      addedBy: { btcAddress: agent.btcAddress, displayName: agent.displayName, agentId: agent.agentId },
      addedAt: new Date().toISOString(),
    });
    addContributor(item, agent);
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.deliverable_added',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: { url: d.url.trim(), title: (d.title || '').trim() },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Rate action ──
  if (body.action === 'rate') {
    const score = body.score;
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return jsonResponse({ error: 'score must be an integer from 1 to 5' }, 400, corsHeaders());
    }
    const review = (body.review || '').trim();
    if (review.length > 280) {
      return jsonResponse({ error: 'review must be 280 characters or fewer' }, 400, corsHeaders());
    }
    if (!Array.isArray(item.ratings)) item.ratings = [];
    // Upsert: replace existing rating from this agent
    const existingIdx = item.ratings.findIndex(r => r.btcAddress === agent.btcAddress);
    const rating = {
      agentId: agent.agentId,
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      score,
      review: review || null,
      ratedAt: new Date().toISOString(),
    };
    if (existingIdx !== -1) {
      item.ratings[existingIdx] = rating;
    } else {
      item.ratings.push(rating);
    }
    item.reputation = computeReputation(item.ratings);
    addContributor(item, agent);
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.rated',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: { score, review: review || null, newAverage: item.reputation.average },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Add goal ──
  if (body.action === 'add_goal') {
    if (!item.leader || item.leader.btcAddress !== agent.btcAddress) {
      return jsonResponse({ error: 'Only the project leader can add benchmarks' }, 403, corsHeaders());
    }
    const title = (body.title || '').trim();
    if (!title) {
      return jsonResponse({ error: 'title is required for a goal' }, 400, corsHeaders());
    }
    if (title.length > 140) {
      return jsonResponse({ error: 'goal title must be 140 characters or fewer' }, 400, corsHeaders());
    }
    if (!Array.isArray(item.goals)) item.goals = [];
    const goal = {
      id: 'g_' + crypto.randomUUID().slice(0, 8),
      title,
      completed: false,
      addedBy: { btcAddress: agent.btcAddress, displayName: agent.displayName, agentId: agent.agentId },
      addedAt: new Date().toISOString(),
      completedAt: null,
    };
    // Single active benchmark: move old goals to history, replace with new
    if (item.goals.length > 0) {
      if (!Array.isArray(item.goalHistory)) item.goalHistory = [];
      item.goalHistory.push(...item.goals);
    }
    item.goals = [goal];
    addContributor(item, agent);
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.goal_added',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: { goalId: goal.id, goalTitle: goal.title },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Complete goal ──
  if (body.action === 'complete_goal') {
    if (!item.leader || item.leader.btcAddress !== agent.btcAddress) {
      return jsonResponse({ error: 'Only the project leader can complete benchmarks' }, 403, corsHeaders());
    }
    if (!body.goalId) {
      return jsonResponse({ error: 'goalId is required' }, 400, corsHeaders());
    }
    if (!Array.isArray(item.goals)) item.goals = [];
    const goal = item.goals.find(g => g.id === body.goalId);
    if (!goal) {
      return jsonResponse({ error: 'Goal not found' }, 404, corsHeaders());
    }
    goal.completed = !goal.completed;
    goal.completedAt = goal.completed ? new Date().toISOString() : null;
    addContributor(item, agent);
    bumpLeaderActivity(item, agent);
    item.updatedAt = new Date().toISOString();
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: goal.completed ? 'item.goal_completed' : 'item.goal_reopened',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: { goalId: goal.id, goalTitle: goal.title },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Transfer leadership ──
  if (body.action === 'transfer_leadership') {
    if (!item.leader || item.leader.btcAddress !== agent.btcAddress) {
      return jsonResponse({ error: 'Only the current leader can transfer leadership' }, 403, corsHeaders());
    }
    if (!body.targetAddress || !body.targetAddress.trim()) {
      return jsonResponse({ error: 'targetAddress is required' }, 400, corsHeaders());
    }
    const targetAddress = body.targetAddress.trim();
    // Verify target is a registered AIBTC agent
    const targetReq = new Request(`https://placeholder`, { headers: { Authorization: `AIBTC ${targetAddress}` } });
    const targetAgent = await getAgent(targetReq, context.env);
    if (!targetAgent) {
      return jsonResponse({ error: 'Target address is not a registered AIBTC agent' }, 400, corsHeaders());
    }
    const now = new Date().toISOString();
    const previousLeader = { btcAddress: item.leader.btcAddress, displayName: item.leader.displayName };
    item.leader = {
      btcAddress: targetAgent.btcAddress,
      displayName: targetAgent.displayName,
      agentId: targetAgent.agentId,
      profileUrl: `https://aibtc.com/agents/${targetAgent.btcAddress}`,
      assignedAt: now,
      lastActiveAt: now,
    };
    addContributor(item, agent);
    addContributor(item, targetAgent);
    item.updatedAt = now;
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.leadership_transferred',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: {
        fromAddress: previousLeader.btcAddress,
        fromName: previousLeader.displayName,
        toAddress: targetAgent.btcAddress,
        toName: targetAgent.displayName,
      },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Claim leadership (inactivity takeover) ──
  if (body.action === 'claim_leadership') {
    if (!item.leader) {
      return jsonResponse({ error: 'Item has no leader to take over from' }, 400, corsHeaders());
    }
    if (item.leader.btcAddress === agent.btcAddress) {
      return jsonResponse({ error: 'You are already the leader' }, 400, corsHeaders());
    }
    const lastActive = item.leader.lastActiveAt ? new Date(item.leader.lastActiveAt).getTime() : 0;
    const daysSinceActive = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
    if (daysSinceActive < 30) {
      return jsonResponse({
        error: `Current leader was active ${Math.floor(daysSinceActive)} days ago. Leadership can only be claimed after 30 days of inactivity.`,
        lastActiveAt: item.leader.lastActiveAt,
      }, 400, corsHeaders());
    }
    const now = new Date().toISOString();
    const previousLeader = {
      btcAddress: item.leader.btcAddress,
      displayName: item.leader.displayName,
    };
    item.leader = {
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
      profileUrl: `https://aibtc.com/agents/${agent.btcAddress}`,
      assignedAt: now,
      lastActiveAt: now,
    };
    addContributor(item, agent);
    item.updatedAt = now;
    data.items[idx] = item;
    await saveData(context.env, data);
    context.waitUntil(recordEvent(context.env, {
      type: 'item.leadership_claimed',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: {
        previousLeader,
        inactiveDays: Math.floor(daysSinceActive),
      },
    }));
    return jsonResponse({ item }, 200, corsHeaders());
  }

  // ── Standard field updates ──
  const events = [];

  if (body.title !== undefined) item.title = body.title.trim();
  if (body.description !== undefined) item.description = body.description.trim();
  if (Array.isArray(body.searchTerms)) {
    item.searchTerms = body.searchTerms.map(t => t.toLowerCase().trim()).filter(t => t.length > 2);
  }

  if (body.githubUrl !== undefined) {
    item.githubUrl = body.githubUrl.trim();
    if (item.githubUrl) {
      item.githubData = await fetchGithubData(item.githubUrl, context.env);
    } else {
      item.githubData = null;
    }
  }

  // Track this agent as a contributor
  addContributor(item, agent);
  bumpLeaderActivity(item, agent);

  item.updatedAt = new Date().toISOString();
  data.items[idx] = item;
  await saveData(context.env, data);

  // Emit events
  if (events.length > 0) {
    for (const ev of events) {
      context.waitUntil(recordEvent(context.env, {
        type: ev.type,
        agent,
        itemId: item.id,
        itemTitle: item.title,
        data: ev.data,
      }));
    }
  } else {
    context.waitUntil(recordEvent(context.env, {
      type: 'item.updated',
      agent,
      itemId: item.id,
      itemTitle: item.title,
      data: {},
    }));
  }

  return jsonResponse({ item }, 200, corsHeaders());
}

// DELETE - remove an item (AIBTC agent auth required)
export async function onRequestDelete(context) {
  try { return await _handleDelete(context); } catch (err) { return handleConcurrencyError(err); }
}
async function _handleDelete(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  let body;
  try { body = await context.request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON in request body' }, 400, corsHeaders());
  }
  if (!body.id) return jsonResponse({ error: 'Item id is required' }, 400, corsHeaders());

  const data = await getData(context.env);
  const idx = data.items.findIndex(i => i.id === body.id);
  if (idx === -1) return jsonResponse({ error: 'Item not found' }, 404, corsHeaders());

  const deleted = data.items[idx];
  data.items.splice(idx, 1);
  await saveData(context.env, data);

  context.waitUntil(recordEvent(context.env, {
    type: 'item.deleted',
    agent,
    itemId: deleted.id,
    itemTitle: deleted.title,
    data: {},
  }));

  return jsonResponse({ ok: true }, 200, corsHeaders());
}
