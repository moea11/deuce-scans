// Private data route on Vercel. Retries across Yahoo hosts when it throttles,
// and only lets good responses get cached so a 429 never gets stuck at the edge.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.query.ping) return res.status(200).json({ ok: true });

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "missing url" });

  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ error: "bad url" }); }
  if (!/(^|\.)finance\.yahoo\.com$/.test(u.hostname)) {
    return res.status(403).json({ error: "host not allowed" });
  }

  // try query1, then query2, then query1 again after a short pause
  const q2 = new URL(target); q2.hostname = "query2.finance.yahoo.com";
  const attempts = [target, q2.toString(), target];

  let last = { status: 502, body: JSON.stringify({ error: "no response" }) };
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await fetch(attempts[i], {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      const body = await r.text();
      if (r.ok) {
        res.setHeader("Cache-Control", "s-maxage=45, stale-while-revalidate=300");
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(body);
      }
      last = { status: r.status, body };
      // only throttling and server errors are worth another try
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = { status: 502, body: JSON.stringify({ error: String((e && e.message) || e) }) };
    }
    if (i < attempts.length - 1) await sleep(i === 0 ? 150 : 500);
  }

  // errors must never be cached
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  return res.status(last.status).send(last.body);
}
