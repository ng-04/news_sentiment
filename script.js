import { VaderSentiment, loadFinvaderLexicon } from "./vader.js";

document.getElementById("year").textContent = new Date().getFullYear();

// Positive/negative classification follows VADER's own convention:
// compound >= 0.05 is positive, <= -0.05 is negative, otherwise neutral.
const POSITIVE_THRESHOLD = 0.05;
const NEGATIVE_THRESHOLD = -0.05;

const analyzerReady = loadFinvaderLexicon()
  .then((lexicon) => new VaderSentiment(lexicon))
  .catch((err) => {
    console.error("Failed to load sentiment lexicon", err);
    return null;
  });

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
    const analyzer = await analyzerReady;
    if (!analyzer) {
      showStatus("Sentiment model failed to load. Please refresh the page and try again.", true);
      return;
    }

    const items = await fetchNews(query);

    if (items.length === 0) {
      showStatus(`No recent news articles found for "${query}". Try a different name.`, false);
      return;
    }

    const scored = items.map((item) => ({
      ...item,
      score: analyzer.polarityScores(item.title).compound,
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
  // rss2json's free tier occasionally throws a transient 500 under load, so
  // retry a couple of times with a short backoff before falling through.
  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (attempt < 2) await sleep(600 * (attempt + 1));
    }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function renderResults(query, scored) {
  const avg = scored.reduce((sum, a) => sum + a.score, 0) / scored.length;

  let label = "Neutral";
  if (avg >= 0.5) label = "Strongly Positive";
  else if (avg >= POSITIVE_THRESHOLD) label = "Positive";
  else if (avg <= -0.5) label = "Strongly Negative";
  else if (avg <= NEGATIVE_THRESHOLD) label = "Negative";

  scoreValueEl.textContent = (avg > 0 ? "+" : "") + avg.toFixed(3);
  scoreLabelEl.textContent = `Net Sentiment for "${query}" — ${label}`;

  const posCount = scored.filter((a) => a.score >= POSITIVE_THRESHOLD).length;
  const negCount = scored.filter((a) => a.score <= NEGATIVE_THRESHOLD).length;
  const neuCount = scored.length - posCount - negCount;
  scoreMetaEl.textContent = `Based on ${scored.length} recent headlines (FinVADER compound score, avg -1 to +1) — ${posCount} positive, ${negCount} negative, ${neuCount} neutral.`;

  articleListEl.innerHTML = "";
  for (const article of scored) {
    const tone =
      article.score >= POSITIVE_THRESHOLD
        ? "positive"
        : article.score <= NEGATIVE_THRESHOLD
        ? "negative"
        : "neutral";
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
        <span class="tag ${tone}">${tone} ${article.score >= 0 ? "+" : ""}${article.score.toFixed(2)}</span>
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
