import { VaderSentiment, loadFinvaderLexicon } from "./vader.js";
import { initStockAutocomplete } from "./autocomplete.js";
import { fetchDailyPriceSeries } from "./yahoo.js";
import { computeCorrelation } from "./correlation.js";
import { dateKeyFromPubDate, todayKey, addDaysToKey } from "./dates.js";
import { renderPriceChart } from "./chart.js";

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
const suggestionList = document.getElementById("suggestion-list");
const inputError = document.getElementById("input-error");
const horizonSelect = document.getElementById("horizon-select");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const articleListEl = document.getElementById("article-list");
const summaryStockEl = document.getElementById("summary-stock");
const summaryCountEl = document.getElementById("summary-count");
const summarySentimentEl = document.getElementById("summary-sentiment");
const summaryHorizonMoveEl = document.getElementById("summary-horizon-move");
const summaryNextDayMoveEl = document.getElementById("summary-nextday-move");
const summaryNoteEl = document.getElementById("summary-note");
const priceChartEl = document.getElementById("price-chart");

const autocomplete = initStockAutocomplete({
  input,
  list: suggestionList,
  error: inputError,
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const stock = autocomplete.resolve();
  if (!stock) {
    autocomplete.showError(
      "Please choose a valid NSE-listed stock from the suggestions before analyzing."
    );
    return;
  }
  autocomplete.clearError();
  const horizonDays = Number(horizonSelect.value);
  await runSearch(stock, horizonDays);
});

async function runSearch(stock, horizonDays) {
  setLoading(true);
  hideResults();
  showStatus(`Searching recent news for "${stock.name}"…`, false);

  try {
    const analyzer = await analyzerReady;
    if (!analyzer) {
      showStatus("Sentiment model failed to load. Please refresh the page and try again.", true);
      return;
    }

    const items = await fetchNews(stock.symbol);

    if (items.length === 0) {
      showStatus(`No recent news articles found for "${stock.name}". Try a different name.`, false);
      return;
    }

    const horizonStartKey = addDaysToKey(todayKey(), -horizonDays);
    const scored = items
      .map((item) => ({
        ...item,
        date: dateKeyFromPubDate(item.pubDate),
        score: analyzer.polarityScores(item.title).compound,
      }))
      .filter((item) => item.date && item.date >= horizonStartKey)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    if (scored.length === 0) {
      showStatus(
        `Found news for "${stock.name}", but none within the last ${horizonDays} days. Try a longer horizon.`,
        false
      );
      return;
    }

    showStatus(`Fetching ${stock.symbol}.NS price history…`, false);

    let priceSeries = null;
    let priceError = null;
    try {
      priceSeries = await fetchDailyPriceSeries(stock.symbol);
    } catch (err) {
      console.error(err);
      priceError = err;
    }

    const correlation = priceSeries
      ? computeCorrelation(scored, priceSeries, horizonStartKey)
      : computeCorrelation(scored, [], horizonStartKey);

    renderResults(stock, horizonDays, scored, correlation, priceError, priceSeries, horizonStartKey);
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

// rss2json's pubDate ("2026-09-09 04:42:36") is UTC but has no timezone
// marker, so it must be normalized before parsing — see dates.js for why
// a bare Date.parse on this format would silently misread it as local time.
function formatPubDate(pubDateStr) {
  let iso = pubDateStr.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
    iso = iso.replace(" ", "T") + "Z";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function toneFor(value) {
  if (value == null) return "neutral";
  if (value >= POSITIVE_THRESHOLD) return "positive";
  if (value <= NEGATIVE_THRESHOLD) return "negative";
  return "neutral";
}

function sentimentLabel(avg) {
  if (avg >= 0.5) return "Strongly Positive";
  if (avg >= POSITIVE_THRESHOLD) return "Positive";
  if (avg <= -0.5) return "Strongly Negative";
  if (avg <= NEGATIVE_THRESHOLD) return "Negative";
  return "Neutral";
}

function formatSigned(value, digits) {
  if (value == null) return "—";
  return (value > 0 ? "+" : "") + value.toFixed(digits);
}

function formatPct(value) {
  if (value == null) return "—";
  return (value > 0 ? "+" : "") + value.toFixed(2) + "%";
}

function renderResults(stock, horizonDays, scored, correlation, priceError, priceSeries, horizonStartKey) {
  // Unhide before measuring/drawing the chart below — an SVG sized off
  // container.clientWidth while the section is still `hidden` would read 0
  // and fall back to a mismatched default width.
  resultsEl.hidden = false;

  summaryStockEl.textContent = stock.name;
  summaryCountEl.textContent = String(correlation.headlineCount);

  const sentimentTone = toneFor(correlation.netSentiment);
  summarySentimentEl.textContent =
    correlation.netSentiment == null
      ? "—"
      : `${formatSigned(correlation.netSentiment, 3)} ${sentimentLabel(correlation.netSentiment)}`;
  summarySentimentEl.className = sentimentTone;

  const horizonMoveTone = toneFor(correlation.movementHorizonPct);
  summaryHorizonMoveEl.textContent = formatPct(correlation.movementHorizonPct);
  summaryHorizonMoveEl.className = horizonMoveTone;

  const nextDayTone = toneFor(correlation.nextDayAvgPct);
  summaryNextDayMoveEl.textContent = formatPct(correlation.nextDayAvgPct);
  summaryNextDayMoveEl.className = nextDayTone;

  const notes = [];
  if (priceError) {
    notes.push("Price data is unavailable right now, so movement columns show — until it can be fetched.");
  } else if (correlation.movementHorizonPct == null) {
    notes.push(`No trading data found within the last ${horizonDays} days.`);
  }
  if (!priceError && correlation.nextDaySampleSize < correlation.dateSentimentCount) {
    notes.push(
      "The next-day figure averages only the headline dates where a following trading day is already available."
    );
  }
  summaryNoteEl.textContent = notes.join(" ");
  summaryNoteEl.hidden = notes.length === 0;

  const chartSeries = (priceSeries || []).filter((p) => p.date >= horizonStartKey);
  renderPriceChart(priceChartEl, chartSeries, `${stock.symbol}.NS closing price — last ${horizonDays} days`);

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
      ? formatPubDate(article.pubDate)
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
