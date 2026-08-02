// api/usage-openai.js
//
// Fetches REAL usage + cost data from OpenAI's organization APIs.
// The customer's Admin API key is sent per-request from the browser and
// used only for these two calls — it is never stored or logged here.
//
// Requires an OpenAI ADMIN key (starts with "sk-admin-...") created at
// platform.openai.com -> Settings -> Organization -> Admin keys.
// A normal "sk-..." project key will get a 401 from these endpoints.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { apiKey, days = 30 } = body || {};
  if (!apiKey) { res.status(400).json({ error: "Missing apiKey" }); return; }

  const startTime = Math.floor(Date.now() / 1000) - days * 86400;
  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    // 1. Daily costs
    const costResp = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${startTime}&limit=180`,
      { headers }
    );
    if (costResp.status === 401 || costResp.status === 403) {
      res.status(401).json({ error: "OpenAI rejected the key. Use an Admin key (sk-admin-...) — project keys can't read org usage." });
      return;
    }
    const costData = await costResp.json();

    const daily = [];
    let totalCost = 0;
    (costData.data || []).forEach(bucket => {
      let dayCost = 0;
      (bucket.results || []).forEach(r => {
        const v = r.amount && typeof r.amount.value === "number" ? r.amount.value : 0;
        dayCost += v;
      });
      totalCost += dayCost;
      daily.push({ ts: bucket.start_time || bucket.starting_at || null, cost: +dayCost.toFixed(4) });
    });

    // 2. Token usage grouped by model
    const usageResp = await fetch(
      `https://api.openai.com/v1/organization/usage/completions?start_time=${startTime}&bucket_width=1d&group_by=model&limit=31`,
      { headers }
    );
    const usageData = usageResp.ok ? await usageResp.json() : { data: [] };

    const modelMap = {};
    (usageData.data || []).forEach(bucket => {
      (bucket.results || []).forEach(r => {
        const m = r.model || "unknown";
        if (!modelMap[m]) modelMap[m] = { model: m, inputTokens: 0, outputTokens: 0, requests: 0 };
        modelMap[m].inputTokens += r.input_tokens || 0;
        modelMap[m].outputTokens += r.output_tokens || 0;
        modelMap[m].requests += r.num_model_requests || 0;
      });
    });

    res.status(200).json({
      provider: "openai",
      days,
      totalCost: +totalCost.toFixed(2),
      daily,
      models: Object.values(modelMap).sort((a, b) => b.outputTokens - a.outputTokens),
    });
  } catch (err) {
    console.error("openai usage error:", err.message);
    res.status(500).json({ error: "Couldn't reach OpenAI's usage API. Try again shortly." });
  }
};
