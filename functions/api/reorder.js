import { getAgent, jsonResponse, corsHeaders } from './_auth.js';

const KV_KEY = 'roadmap:items';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  const body = await context.request.json();
  if (!Array.isArray(body.orderedIds)) {
    return jsonResponse({ error: 'orderedIds array is required' }, 400, corsHeaders());
  }

  const raw = await context.env.ROADMAP_KV.get(KV_KEY, 'json');
  const data = raw || { version: 1, items: [] };

  const map = new Map(data.items.map(i => [i.id, i]));
  const reordered = [];
  for (const id of body.orderedIds) {
    if (map.has(id)) {
      reordered.push(map.get(id));
      map.delete(id);
    }
  }
  for (const item of map.values()) {
    reordered.push(item);
  }

  data.items = reordered;
  data.updatedAt = new Date().toISOString();
  await context.env.ROADMAP_KV.put(KV_KEY, JSON.stringify(data));

  return jsonResponse({ ok: true, count: reordered.length }, 200, corsHeaders());
}
