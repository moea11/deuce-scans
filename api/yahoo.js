// Private data route on Vercel. Retries across Yahoo hosts when it throttles,
// only lets good responses get cached, and handles Yahoo's cookie + crumb
// so fundamentals (quoteSummary) work instead of 401ing.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional lock: set ALLOWED_HOSTS in Vercel (example: "deuce-scans.vercel.app")
const ALLOWED = (process.env.ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
function callerAllowed(req) {
  if (!ALLOWED.length) return true;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false;
  try {
    const host = new URL(src).hostname;
    return ALLOWED.some((a) => host === a || host.endsWith("." + a));
  } catch { return false; }
}

// ---- crumb: kept warm between requests while the function instance lives ----
let CRUMB = null, COOKIE = null, CRUMB_AT = 0;
const CRUMB_TTL = 30 * 60 * 1000;

function readCookies(r) {
  let list = [];
  if (typeof r.headers.getSetCookie === "function") list = r.headers.getSetCookie();
  else if (r.headers.get("set-cookie")) list = r.headers.get("set-cookie").split(/,(?=\s*[A-Za-z0-9_]+=)/);
  return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

async function getCrumb(force) {
  if (!force && CRUMB && Date.now() - CRUMB_AT < CRUMB_TTL) return true;
  try {
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(4000)
    });
    const cookie = readCookies(r1);
    if (!cookie) return false;
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, "Cookie": cookie }, signal: AbortSignal.timeout(4000)
    });
    const crumb = (await r2.text()).trim();
    if (!r2.ok || !crumb || crumb.length > 40 || crumb.includes("<")) return false;
    CRUMB = crumb; COOKIE = cookie; CRUMB_AT = Date.now();
    return true;
  } catch { return false; }
}

const needsCrumb = (u) => /\/v10\/finance\/quoteSummary|\/v7\/finance\/quote/.test(u.pathname);

export default async function handler(req, res) {
  if (req.query.ping) return res.status(200).json({ ok: true });
  if (!callerAllowed(req)) return res.status(403).json({ error: "not allowed" });

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "missing url" });

  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ error: "bad url" }); }
  if (!/(^|\.)finance\.yahoo\.com$/.test(u.hostname)) {
    return res.status(403).json({ error: "host not allowed" });
  }

  const crumbMode = needsCrumb(u);
  if (crumbMode) await getCrumb(false);

  const build = (host) => {
    const x = new URL(target);
    x.hostname = host;
    if (crumbMode && CRUMB) x.searchParams.set("crumb", CRUMB);
    return x.toString();
  };
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com", "query1.finance.yahoo.com"];

  let last = { status: 502, body: JSON.stringify({ error: "no response" }) };
  let refreshed = false;
  for (let i = 0; i < hosts.length; i++) {
    try {
      const headers = {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9"
      };
      if (crumbMode && COOKIE) headers["Cookie"] = COOKIE;

      const r = await fetch(build(hosts[i]), { headers, signal: AbortSignal.timeout(4000) });
      const body = await r.text();
      if (r.ok) {
        res.setHeader("Cache-Control", "s-maxage=45, stale-while-revalidate=300");
        res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
        return res.status(200).send(body);
      }
      last = { status: r.status, body };

      // stale or missing crumb: grab a fresh one once and keep going
      if (crumbMode && (r.status === 401 || r.status === 403) && !refreshed) {
        refreshed = true;
        await getCrumb(true);
        continue;
      }
      // only throttling and server errors are worth another try
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = { status: 502, body: JSON.stringify({ error: String((e && e.message) || e) }) };
    }
    if (i < hosts.length - 1) await sleep(i === 0 ? 150 : 500);
  }

  // errors must never be cached
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  return res.status(last.status).send(last.body);
}
