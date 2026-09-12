document.getElementById("year").textContent = new Date().getFullYear();

const POSITIVE_WORDS = [
  "surge", "surges", "surged", "rally", "rallies", "rallied", "jump", "jumps", "jumped",
  "soar", "soars", "soared", "gain", "gains", "gained", "gainer", "rise", "rises", "risen",
  "rising", "climb", "climbs", "climbed", "growth", "grows", "grew", "profit", "profits",
  "profitable", "beat", "beats", "beating", "outperform", "outperforms", "bullish", "upgrade",
  "upgrades", "upgraded", "record", "high", "highs", "strong", "stronger", "strength",
  "expansion", "expands", "expanded", "dividend", "dividends", "buyback", "buy", "positive",
  "optimism", "optimistic", "boost", "boosts", "boosted", "recovery", "recovers", "recovered",
  "milestone", "success", "successful", "win", "wins", "won", "upbeat", "top", "tops", "topped",
  "raise", "raises", "raised", "improve", "improves", "improved", "improvement", "robust",
  "breakthrough", "leading", "leader", "innovation", "innovative", "acquire", "acquisition",
  "partnership", "deal", "contract", "order", "orders", "stake", "invest", "investment",
  "invests", "invested", "funding", "funded", "listing", "ipo", "surplus", "exceed", "exceeds",
  "exceeded"
];

const NEGATIVE_WORDS = [
  "fall", "falls", "fell", "falling", "drop", "drops", "dropped", "decline", "declines",
  "declined", "plunge", "plunges", "plunged", "slump", "slumps", "slumped", "crash", "crashes",
  "crashed", "loss", "losses", "loser", "bearish", "downgrade", "downgrades", "downgraded",
  "weak", "weaker", "weakness", "miss", "misses", "missed", "cut", "cuts", "layoff", "layoffs",
  "fraud", "probe", "scam", "lawsuit", "penalty", "penalties", "fine", "fined", "debt", "default",
  "recession", "slowdown", "slows", "slowed", "warning", "warns", "warned", "risk", "risks",
  "risky", "concern", "concerns", "concerned", "negative", "pessimism", "pessimistic", "slide",
  "slides", "slid", "tumble", "tumbles", "tumbled", "sell-off", "selloff", "resign", "resigns",
  "resigned", "resignation", "scandal", "controversy", "sued", "sues", "suing", "ban", "banned",
  "shutdown", "closure", "bankrupt", "bankruptcy", "shortfall", "underperform", "underperforms",
  "delay", "delays", "delayed", "strike", "protest", "dispute", "volatile", "volatility",
  "uncertainty", "uncertain", "trouble", "troubled", "crisis", "cautious", "caution"
];

const POS_SET = new Set(POSITIVE_WORDS);
const NEG_SET = new Set(NEGATIVE_WORDS);

const RSS2JSON_ENDPOINT = "https://api.rss2json.com/v1/api.json?rss_url=";
const XML_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const form = document.getElementById("sentiment-form");
const input = document.getElementById("stock-input");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const articleListEl = document.getElementById("article-list");
const scoreValueEl = document.getElementById("score-value");
const scoreLabelEl = document.getElementById("score-label");
const scoreMetaEl = document.getElementById("score-meta");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  await runSearch(query);
});

async function runSearch(query) {
  setLoading(true);
  hideResults();
  showStatus(`Searching recent news for "${query}"…`, false);

  try {
    const items = await fetchNews(query);

    if (items.length === 0) {
      showStatus(`No recent news articles found for "${query}". Try a different name.`, false);
      return;
    }

    const scored = items.map((item) => ({
      ...item,
      score: scoreSentiment(`${item.title} ${item.source || ""}`),
    }));

    renderResults(query, scored);
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus(
      "Couldn't fetch news right now (the free proxy or Google News may be temporarily unavailable). Please try again in a moment.",
      true
    );
  } finally {
    setLoading(false);
  }
}

async function fetchNews(query) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query + " stock India"
  )}&hl=en-IN&gl=IN&ceid=IN:en`;

  let lastError = null;

  // Primary: rss2json.com is a CORS-enabled RSS-to-JSON service built for
  // browser use (sends Access-Control-Allow-Origin: *), so no proxy needed.
  try {
    const res = await fetch(RSS2JSON_ENDPOINT + encodeURIComponent(rssUrl));
    if (!res.ok) throw new Error(`rss2json responded with ${res.status}`);
    const data = await res.json();
    if (data.status !== "ok") throw new Error(data.message || "rss2json error");
    const items = (data.items || []).slice(0, 12).map((item) => {
      const decodedTitle = decodeEntities(item.title);
      const { title, source: parsedSource } = stripSource(decodedTitle);
      return {
        title,
        source: item.author || parsedSource || guessSource(item.link),
        link: item.link,
        pubDate: item.pubDate,
      };
    });
    if (items.length > 0) return items;
    lastError = new Error("No items returned");
  } catch (err) {
    lastError = err;
  }

  // Fallback: fetch the raw RSS XML through a generic CORS proxy.
  for (const buildProxyUrl of XML_PROXIES) {
    try {
      const proxyUrl = buildProxyUrl(rssUrl);
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Proxy responded with ${res.status}`);
      const text = await res.text();
      const items = parseRss(text);
      if (items.length > 0) return items;
      lastError = new Error("No items parsed");
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return [];
}

function stripSource(rawTitle) {
  const dashIndex = rawTitle.lastIndexOf(" - ");
  if (dashIndex === -1) return { title: rawTitle.trim(), source: "" };
  return {
    title: rawTitle.slice(0, dashIndex).trim(),
    source: rawTitle.slice(dashIndex + 3).trim(),
  };
}

function decodeEntities(str) {
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}

function guessSource(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseRss(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Failed to parse RSS feed");

  const items = Array.from(doc.querySelectorAll("item")).slice(0, 12);

  return items.map((item) => {
    const rawTitle = item.querySelector("title")?.textContent || "";
    const link = item.querySelector("link")?.textContent || "#";
    const pubDate = item.querySelector("pubDate")?.textContent || "";
    const sourceTag = item.querySelector("source")?.textContent || "";

    let title = rawTitle;
    let source = sourceTag;
    const dashIndex = rawTitle.lastIndexOf(" - ");
    if (!source && dashIndex !== -1) {
      title = rawTitle.slice(0, dashIndex);
      source = rawTitle.slice(dashIndex + 3);
    }

    return { title: title.trim(), link, pubDate, source: source.trim() };
  });
}

function scoreSentiment(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let score = 0;
  for (const word of words) {
    if (POS_SET.has(word)) score += 1;
    if (NEG_SET.has(word)) score -= 1;
  }
  return score;
}

function renderResults(query, scored) {
  const netScore = scored.reduce((sum, a) => sum + a.score, 0);
  const avg = netScore / scored.length;

  let label = "Neutral";
  if (avg >= 0.6) label = "Strongly Positive";
  else if (avg > 0.15) label = "Positive";
  else if (avg <= -0.6) label = "Strongly Negative";
  else if (avg < -0.15) label = "Negative";

  scoreValueEl.textContent = (netScore > 0 ? "+" : "") + netScore;
  scoreLabelEl.textContent = `Net Sentiment for "${query}" — ${label}`;

  const posCount = scored.filter((a) => a.score > 0).length;
  const negCount = scored.filter((a) => a.score < 0).length;
  const neuCount = scored.length - posCount - negCount;
  scoreMetaEl.textContent = `Based on ${scored.length} recent headlines — ${posCount} positive, ${negCount} negative, ${neuCount} neutral.`;

  articleListEl.innerHTML = "";
  for (const article of scored) {
    const tone = article.score > 0 ? "positive" : article.score < 0 ? "negative" : "neutral";
    const li = document.createElement("li");
    li.className = `article-item ${tone}`;

    const dateStr = article.pubDate
      ? new Date(article.pubDate).toLocaleString("en-IN", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

    li.innerHTML = `
      <div class="article-top">
        <a class="article-title" href="${escapeAttr(article.link)}" target="_blank" rel="noopener">
          ${escapeHtml(article.title)}
        </a>
        <span class="tag ${tone}">${tone}</span>
      </div>
      <div class="article-meta">${escapeHtml(article.source || "")}${
      article.source && dateStr ? " · " : ""
    }${dateStr}</div>
    `;
    articleListEl.appendChild(li);
  }

  resultsEl.hidden = false;
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading;
  searchBtn.textContent = isLoading ? "Analyzing…" : "Analyze";
}

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  statusEl.classList.toggle("error", Boolean(isError));
}

function hideStatus() {
  statusEl.hidden = true;
  statusEl.classList.remove("error");
}

function hideResults() {
  resultsEl.hidden = true;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function escapeAttr(str) {
  return escapeHtml(str);
}
