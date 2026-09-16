// Private server-side data route. Runs on Vercel, not in the browser,
// so there is no CORS relay and no shared rate limit.
export default async function handler(req, res) {
  // health probe the app uses to detect hosted mode
  if (req.query.ping) return res.status(200).json({ ok: true });

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "missing url" });

  // only allow Yahoo finance hosts
  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ error: "bad url" }); }
  if (!/(^|\.)finance\.yahoo\.com$/.test(u.hostname) &&
      !/(^|\.)query[12]\.finance\.yahoo\.com$/.test(u.hostname)) {
    return res.status(403).json({ error: "host not allowed" });
  }

  try {
    const r = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    const body = await r.text();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.setHeader("Content-Type", "application/json");
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e) });
  }
}
