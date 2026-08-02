// api/usage-anthropic.js
//
// Fetches REAL usage + cost data from Anthropic's Admin API.
// The customer's Admin key is sent per-request from the browser and used
// only for these two calls — never stored or logged here.
//
// Requires an Anthropic ADMIN key (starts with "sk-ant-admin...") from
// console.anthropic.com -> Settings -> Admin keys. Regular API keys
// can't read org-level usage.
//
// NOTE: response shapes on these endpoints have evolved — parsing below
// is deliberately tolerant (sums any numeric cost/token fields it finds
// per bucket). If Anthropic changes field names, adjust here.

function sumNumeric(obj, keys) {
  let total = 0;
  for (const k of keys) {
    const v = obj && obj[k];
    if (typeof v === "number") total += v;
    else if (typeof v === "string" && !isNaN(parseFloat(v))) total += parseFloat(v);
  }
  return total;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { apiKey, days = 30 } = body || {};
  if (!apiKey) { res.status(400).json({ error: "Missing apiKey" }); return; }

  const startingAt = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  try {
    // 1. Daily cost report
    const costResp = await fetch(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d&limit=31`,
      { headers }
    );
    if (costResp.status === 401 || costResp.status === 403) {
      res.status(401).json({ error: "Anthropic rejected the key. Use an Admin key (sk-ant-admin...) — regular API keys can't read org usage." });
      return;
    }
    const costData = await costResp.json();

    const daily = [];
    let totalCost = 0;
    const costBuckets = costData.data || costData.buckets || [];
    costBuckets.forEach(bucket => {
      let dayCost = 0;
      const results = bucket.results || bucket.items || [];
      results.forEach(r => { dayCost += sumNumeric(r, ["amount", "cost", "value", "cost_usd"]); });
      // some shapes put amount directly on the bucket
      if (results.length === 0) dayCost += sumNumeric(bucket, ["amount", "cost", "value"]);
      totalCost += dayCost;
      daily.push({ ts: bucket.starting_at || bucket.start_time || null, cost: +dayCost.toFixed(4) });
    });

    // 2. Usage report grouped by model
    const usageResp = await fetch(
      `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startingAt)}&bucket_width=1d&group_by[]=model&limit=31`,
      { headers }
    );
    const usageData = usageResp.ok ? await usageResp.json() : { data: [] };

    const modelMap = {};
    const usageBuckets = usageData.data || usageData.buckets || [];
    usageBuckets.forEach(bucket => {
      (bucket.results || bucket.items || []).forEach(r => {
        const m = r.model || "unknown";
        if (!modelMap[m]) modelMap[m] = { model: m, inputTokens: 0, outputTokens: 0, requests: 0 };
        modelMap[m].inputTokens += sumNumeric(r, ["input_tokens", "uncached_input_tokens", "cache_read_input_tokens"]);
        modelMap[m].outputTokens += sumNumeric(r, ["output_tokens"]);
        modelMap[m].requests += sumNumeric(r, ["num_requests", "request_count"]);
      });
    });

    res.status(200).json({
      provider: "anthropic",
      days,
      totalCost: +totalCost.toFixed(2),
      daily,
      models: Object.values(modelMap).sort((a, b) => b.outputTokens - a.outputTokens),
    });
  } catch (err) {
    console.error("anthropic usage error:", err.message);
    res.status(500).json({ error: "Couldn't reach Anthropic's usage API. Try again shortly." });
  }
};
