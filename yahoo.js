import { dateKeyFromUnixSeconds } from "./dates.js";

// Yahoo Finance's chart endpoint doesn't send CORS headers, so it needs a
// proxy. r.jina.ai (a "reader" proxy) works for this host today and returns
// the JSON wrapped in a short text preamble; the two generic proxies are
// kept as a fallback chain in case r.jina.ai starts blocking this domain
// too (it already anonymous-blocks news.google.com under load).
const YAHOO_PROXIES = [
  (url) => ({ fetchUrl: `https://r.jina.ai/${url}`, parse: parseJinaWrapped }),
  (url) => ({
    fetchUrl: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    parse: JSON.parse,
  }),
  (url) => ({
    fetchUrl: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    parse: JSON.parse,
  }),
];

function parseJinaWrapped(text) {
  const idx = text.indexOf("{");
  if (idx === -1) throw new Error("Unexpected proxy response");
  return JSON.parse(text.slice(idx));
}

// Returns an ascending array of { date: "YYYY-MM-DD" (IST), close: number }.
export async function fetchDailyPriceSeries(nseSymbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    nseSymbol
  )}.NS?range=3mo&interval=1d`;

  let lastError = null;
  // Two full passes over the proxy chain: proxies occasionally return a
  // transient 5xx (observed a one-off 522 from r.jina.ai in testing) that
  // clears up within a couple seconds, so it's worth one retry pass before
  // giving up entirely.
  for (let pass = 0; pass < 2; pass++) {
    for (const build of YAHOO_PROXIES) {
      const { fetchUrl, parse } = build(yahooUrl);
      try {
        const res = await fetchWithTimeout(fetchUrl, 10000);
        if (!res.ok) throw new Error(`Proxy responded with ${res.status}`);
        const text = await res.text();
        const data = parse(text);
        const result = data?.chart?.result?.[0];
        if (!result) {
          throw new Error(data?.chart?.error?.description || "No price data returned");
        }
        const series = buildSeries(result);
        if (series.length > 0) return series;
        lastError = new Error("Empty price series");
      } catch (err) {
        lastError = err;
      }
    }
    if (pass === 0) await sleep(800);
  }
  throw lastError || new Error("Failed to fetch price data");
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSeries(result) {
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    byDate.set(dateKeyFromUnixSeconds(timestamps[i]), close);
  }
  return [...byDate.keys()].sort().map((date) => ({ date, close: byDate.get(date) }));
}
