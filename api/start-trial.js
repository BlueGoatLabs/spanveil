// api/start-trial.js
//
// This runs on Vercel's servers, not in the browser — it's the only
// place your Paystack SECRET key is allowed to live. Set it as a
// Vercel environment variable (Project Settings -> Environment
// Variables), never in this file or in index.html.
//
// Required Vercel environment variables:
//   PAYSTACK_SECRET_KEY         - starts with sk_live_ or sk_test_
//   PAYSTACK_PLAN_CODE_MONTHLY  - from Paystack Dashboard > Products > Plans
//   PAYSTACK_PLAN_CODE_YEARLY   - from Paystack Dashboard > Products > Plans
//
// One-time setup before this works:
//   1. In Paystack Dashboard -> Products -> Plans -> Create Plan:
//        - "Spanveil Team Monthly", amount KES 8,200, interval Monthly
//        - "Spanveil Team Yearly", amount KES 78,720 (or your real
//          yearly price), interval Annually
//      Copy each plan's "Plan Code" (starts with PLN_) into the two
//      env vars above.
//   2. Make sure the price shown in index.html's PLANS array matches
//      what these Paystack Plans actually charge — nothing here reads
//      that display value, so keep them in sync by hand.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  const PLAN_CODE_MONTHLY = process.env.PAYSTACK_PLAN_CODE_MONTHLY;
  const PLAN_CODE_YEARLY = process.env.PAYSTACK_PLAN_CODE_YEARLY;

  if (!SECRET_KEY) {
    res.status(500).json({ error: "Server isn't configured with a Paystack secret key yet." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { reference, interval } = body || {};

  if (!reference || !interval) {
    res.status(400).json({ error: "Missing reference or interval." });
    return;
  }

  const planCode = interval === "yearly" ? PLAN_CODE_YEARLY : PLAN_CODE_MONTHLY;
  if (!planCode) {
    res.status(500).json({ error: `No Paystack plan code configured for interval "${interval}".` });
    return;
  }

  try {
    // 1. Verify the small card-verification transaction actually succeeded
    const verifyResp = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${SECRET_KEY}` } }
    );
    const verifyData = await verifyResp.json();

    if (!verifyData.status || verifyData.data?.status !== "success") {
      res.status(400).json({ error: "Card verification failed. No trial was started." });
      return;
    }

    const authCode = verifyData.data.authorization?.authorization_code;
    const customerCode = verifyData.data.customer?.customer_code;
    const chargedAmount = verifyData.data.amount;

    if (!authCode || !customerCode) {
      res.status(400).json({ error: "Card couldn't be saved for future billing. No trial was started." });
      return;
    }

    // 2. Refund the small verification charge — best-effort, doesn't
    //    block the trial if the refund call itself fails.
    try {
      await fetch("https://api.paystack.co/refund", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transaction: reference, amount: chargedAmount }),
      });
    } catch (refundErr) {
      console.error("Refund failed (non-fatal):", refundErr);
    }

    // 3. Create the subscription with billing deferred 7 days —
    //    Paystack itself charges the saved card automatically on that
    //    date and every renewal after, with no cron job needed here.
    const startDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const subResp = await fetch("https://api.paystack.co/subscription", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer: customerCode,
        plan: planCode,
        authorization: authCode,
        start_date: startDate,
      }),
    });
    const subData = await subResp.json();

    if (!subData.status) {
      res.status(400).json({ error: subData.message || "Couldn't start the subscription." });
      return;
    }

    res.status(200).json({ success: true, trialEndsAt: startDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong starting the trial. Please try again." });
  }
};
