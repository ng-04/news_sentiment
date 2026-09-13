import { VaderSentiment, loadFinvaderLexicon } from "./vader.js";
import { initStockAutocomplete } from "./autocomplete.js";
import { fetchDailyPriceSeries } from "./yahoo.js";
import { computeCorrelation } from "./correlation.js";
import { dateKeyFromPubDate, todayKey, addDaysToKey } from "./dates.js";
import { renderPriceChart, renderComparisonChart } from "./chart.js";

document.getElementById("year").textContent = new Date().getFullYear();

initThemeToggle();

function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

  function currentTheme() {
    const saved = safeGetTheme();
    if (saved === "dark" || saved === "light") return saved;
    return prefersDark.matches ? "dark" : "light";
  }

  function applyToggleLabel() {
    toggle.textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode";
  }

  toggle.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    safeSetTheme(next);
    applyToggleLabel();
  });

  prefersDark.addEventListener("change", () => {
    if (!safeGetTheme()) applyToggleLabel();
  });

  applyToggleLabel();
}

function safeGetTheme() {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
}

function safeSetTheme(value) {
  try {
    localStorage.setItem("theme", value);
  } catch {
    /* private browsing / storage disabled — theme just won't persist */
  }
}

// Positive/negative classification follows VADER's own convention:
// compound >= 0.05 is positive, <= -0.05 is negative, otherwise neutral.
const POSITIVE_THRESHOLD = 0.05;
const NEGATIVE_THRESHOLD = -0.05;
const MAX_STOCKS = 3;
const SERIES_COLORS = ["var(--blue)", "var(--series-2)", "var(--series-3)"];
const VALID_HORIZONS = ["7", "14", "30"];

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
const chipsEl = document.getElementById("stock-chips");
const articleGroupsEl = document.getElementById("article-groups");
const summaryBodyEl = document.getElementById("summary-body");
const summaryNoteEl = document.getElementById("summary-note");
const priceChartEl = document.getElementById("price-chart");
const copyLinkBtn = document.getElementById("copy-link-btn");
const copyLinkConfirm = document.getElementById("copy-link-confirm");

let selectedStocks = [];

function isSelected(stock) {
  return selectedStocks.some((s) => s.symbol === stock.symbol);
}

function isFull() {
  return selectedStocks.length >= MAX_STOCKS;
}

function addStock(stock) {
  if (isSelected(stock) || isFull()) return;
  selectedStocks.push(stock);
  renderChips();
}

function removeStock(symbol) {
  selectedStocks = selectedStocks.filter((s) => s.symbol !== symbol);
  renderChips();
}

function renderChips() {
  chipsEl.innerHTML = "";
  chipsEl.hidden = selectedStocks.length === 0;
  for (const stock of selectedStocks) {
    const li = document.createElement("li");
    li.className = "stock-chip";

    const label = document.createElement("span");
    label.textContent = stock.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "stock-chip-remove";
    removeBtn.setAttribute("aria-label", `Remove ${stock.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => removeStock(stock.symbol));

    li.appendChild(label);
    li.appendChild(removeBtn);
    chipsEl.appendChild(li);
  }
}

const autocomplete = initStockAutocomplete({
  input,
  list: suggestionList,
  error: inputError,
  onSelect: addStock,
  isSelected,
  isFull,
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (selectedStocks.length === 0) {
    autocomplete.showError("Add at least one stock before analyzing.");
    return;
  }
  autocomplete.clearError();
  const horizonDays = Number(horizonSelect.value);
  await runSearch(selectedStocks.slice(), horizonDays);
});

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyLinkConfirm.hidden = false;
    setTimeout(() => {
      copyLinkConfirm.hidden = true;
    }, 2000);
  } catch (err) {
    console.error(err);
  }
});

// Restore a shared/bookmarked search from the URL (?symbols=A,B,C&horizon=N)
// once the stock list has loaded, then run it automatically.
autocomplete.ready.then(() => {
  const params = new URLSearchParams(location.search);
  const symbolsParam = params.get("symbols");
  const horizonParam = params.get("horizon");

  if (horizonParam && VALID_HORIZONS.includes(horizonParam)) {
    horizonSelect.value = horizonParam;
  }

  if (symbolsParam) {
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_STOCKS);
    for (const sym of symbols) {
      const stock = autocomplete.findExact(sym);
      if (stock) addStock(stock);
    }
    if (selectedStocks.length > 0) {
      runSearch(selectedStocks.slice(), Number(horizonSelect.value));
    }
  }
});

function updateUrlState(stocks, horizonDays) {
  const params = new URLSearchParams();
  params.set("symbols", stocks.map((s) => s.symbol).join(","));
  params.set("horizon", String(horizonDays));
  history.replaceState(null, "", `?${params.toString()}`);
}

async function runSearch(stocks, horizonDays) {
  setLoading(true);
  hideResults();
  showStatus(`Analyzing ${stocks.map((s) => s.name).join(", ")}…`, false);

  try {
    const analyzer = await analyzerReady;
    if (!analyzer) {
      showStatus("Sentiment model failed to load. Please refresh the page and try again.", true);
      return;
    }

    const horizonStartKey = addDaysToKey(todayKey(), -horizonDays);
    const results = await Promise.all(
      stocks.map((stock) => analyzeStock(stock, horizonStartKey, analyzer))
    );

    renderResults(results, horizonDays, horizonStartKey);
    updateUrlState(stocks, horizonDays);
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus("Something went wrong analyzing that search. Please try again.", true);
  } finally {
    setLoading(false);
  }
}

// Fetches news + price independently for one stock so a failure in either
// (or in a sibling stock's fetch, when comparing several) never blocks the
// rest — each stock's row degrades gracefully on its own.
async function analyzeStock(stock, horizonStartKey, analyzer) {
  let scored = [];
  let newsError = null;
  try {
    const items = await fetchNews(stock.symbol);
    scored = items
      .map((item) => ({
        ...item,
        date: dateKeyFromPubDate(item.pubDate),
        score: analyzer.polarityScores(item.title).compound,
      }))
      .filter((item) => item.date && item.date >= horizonStartKey)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch (err) {
    console.error(err);
    newsError = err;
  }

  let priceSeries = null;
  let priceError = null;
  try {
    priceSeries = await fetchDailyPriceSeries(stock.symbol);
  } catch (err) {
    console.error(err);
    priceError = err;
  }

  const correlation = computeCorrelation(scored, priceSeries || [], horizonStartKey);
  const chartPoints = (priceSeries || []).filter((p) => p.date >= horizonStartKey);

  return { stock, scored, correlation, chartPoints, newsError, priceError };
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

function renderResults(results, horizonDays, horizonStartKey) {
  // Unhide before measuring/drawing the chart below — an SVG sized off
  // container.clientWidth while the section is still `hidden` would read 0
  // and fall back to a mismatched default width.
  resultsEl.hidden = false;

  summaryBodyEl.innerHTML = "";
  const notes = [];

  for (const result of results) {
    const { stock, correlation, newsError, priceError } = result;
    const tr = document.createElement("tr");

    const stockTd = document.createElement("td");
    stockTd.textContent = stock.name;

    const countTd = document.createElement("td");
    countTd.textContent = String(correlation.headlineCount);

    const sentimentTd = document.createElement("td");
    sentimentTd.className = toneFor(correlation.netSentiment);
    sentimentTd.textContent =
      correlation.netSentiment == null
        ? "—"
        : `${formatSigned(correlation.netSentiment, 3)} ${sentimentLabel(correlation.netSentiment)}`;

    const horizonMoveTd = document.createElement("td");
    horizonMoveTd.className = toneFor(correlation.movementHorizonPct);
    horizonMoveTd.textContent = formatPct(correlation.movementHorizonPct);

    const nextDayTd = document.createElement("td");
    nextDayTd.className = toneFor(correlation.nextDayAvgPct);
    nextDayTd.textContent = formatPct(correlation.nextDayAvgPct);

    tr.append(stockTd, countTd, sentimentTd, horizonMoveTd, nextDayTd);
    summaryBodyEl.appendChild(tr);

    if (newsError) {
      notes.push(`${stock.symbol}: couldn't fetch news right now.`);
    } else if (correlation.headlineCount === 0) {
      notes.push(`${stock.symbol}: no headlines found within the last ${horizonDays} days.`);
    } else if (correlation.nextDaySampleSize < correlation.dateSentimentCount) {
      notes.push(`${stock.symbol}: next-day figure only covers dates with a following trading day so far.`);
    }
    if (priceError) {
      notes.push(`${stock.symbol}: price data is unavailable right now.`);
    } else if (!newsError && correlation.movementHorizonPct == null) {
      notes.push(`${stock.symbol}: no trading data found within the last ${horizonDays} days.`);
    }
  }

  summaryNoteEl.textContent = notes.join(" ");
  summaryNoteEl.hidden = notes.length === 0;

  if (results.length === 1) {
    const r = results[0];
    renderPriceChart(
      priceChartEl,
      r.chartPoints,
      `${r.stock.symbol}.NS closing price — last ${horizonDays} days`
    );
  } else {
    const seriesList = results.map((r, i) => ({
      label: r.stock.symbol,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      points: r.chartPoints,
    }));
    renderComparisonChart(
      priceChartEl,
      seriesList,
      `% change from start of horizon — last ${horizonDays} days`
    );
  }

  articleGroupsEl.innerHTML = "";
  for (const result of results) {
    const { stock, scored, newsError } = result;
    const group = document.createElement("div");
    group.className = "article-group";

    if (results.length > 1) {
      const heading = document.createElement("h3");
      heading.className = "article-group-heading";
      heading.textContent = stock.name;
      group.appendChild(heading);
    }

    if (newsError) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "Couldn't fetch news for this stock right now.";
      group.appendChild(p);
    } else if (scored.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = `No headlines found within the last ${horizonDays} days.`;
      group.appendChild(p);
    } else {
      const ul = document.createElement("ul");
      ul.className = "article-list";
      for (const article of scored) {
        ul.appendChild(renderArticleItem(article));
      }
      group.appendChild(ul);
    }

    articleGroupsEl.appendChild(group);
  }
}

function renderArticleItem(article) {
  const tone =
    article.score >= POSITIVE_THRESHOLD
      ? "positive"
      : article.score <= NEGATIVE_THRESHOLD
      ? "negative"
      : "neutral";
  const li = document.createElement("li");
  li.className = `article-item ${tone}`;

  const dateStr = article.pubDate ? formatPubDate(article.pubDate) : "";

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
  return li;
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
