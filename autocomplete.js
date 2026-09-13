import { loadStockList, findStock } from "./stocks.js";

const MAX_SUGGESTIONS = 8;

// A typeahead that ADDS a stock via `onSelect` (click, Enter-on-highlighted,
// or Enter with text that exactly matches a listed name/symbol) rather than
// resolving a single value at form-submit time — the caller owns the list of
// selected stocks (for the compare-mode chip UI) and decides what counts as
// "already selected" / "no room left" via `isSelected` / `isFull`.
export function initStockAutocomplete({ input, list, error, onSelect, isSelected, isFull }) {
  let stocks = [];
  let currentMatches = [];
  let activeIndex = -1;
  let debounceTimer = null;

  const stocksReady = loadStockList()
    .then((data) => {
      stocks = data;
    })
    .catch((err) => {
      console.error(err);
    });

  function clearError() {
    error.hidden = true;
    error.textContent = "";
  }

  function showError(message) {
    error.hidden = false;
    error.textContent = message;
  }

  function closeList() {
    list.hidden = true;
    list.innerHTML = "";
    currentMatches = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
  }

  function highlight(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, idx)) +
      "<mark>" +
      escapeHtml(text.slice(idx, idx + query.length)) +
      "</mark>" +
      escapeHtml(text.slice(idx + query.length))
    );
  }

  function renderMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q || stocks.length === 0 || isFull()) {
      closeList();
      return;
    }

    const starts = [];
    const contains = [];
    for (const s of stocks) {
      if (isSelected(s)) continue;
      const nameLower = s.name.toLowerCase();
      const symbolLower = s.symbol.toLowerCase();
      if (nameLower.startsWith(q) || symbolLower.startsWith(q)) {
        starts.push(s);
      } else if (nameLower.includes(q) || symbolLower.includes(q)) {
        contains.push(s);
      }
      if (starts.length >= MAX_SUGGESTIONS) break;
    }

    currentMatches = [...starts, ...contains].slice(0, MAX_SUGGESTIONS);

    if (currentMatches.length === 0) {
      closeList();
      return;
    }

    list.innerHTML = currentMatches
      .map(
        (s, i) => `
          <li class="suggestion-item" role="option" data-index="${i}">
            ${highlight(s.name, q)}
            <span class="suggestion-symbol">${escapeHtml(s.symbol)}</span>
          </li>
        `
      )
      .join("");
    list.hidden = false;
    activeIndex = -1;
    input.setAttribute("aria-expanded", "true");
  }

  function updateActiveHighlight(items) {
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  }

  function pick(stock) {
    clearError();
    closeList();
    input.value = "";
    onSelect(stock);
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderMatches(input.value), 120);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && !list.hidden) {
      e.preventDefault();
      const items = list.querySelectorAll(".suggestion-item");
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActiveHighlight(items);
    } else if (e.key === "ArrowUp" && !list.hidden) {
      e.preventDefault();
      const items = list.querySelectorAll(".suggestion-item");
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveHighlight(items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isFull()) {
        showError("You've already picked the maximum of 3 stocks.");
        return;
      }
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        pick(currentMatches[activeIndex]);
        return;
      }
      const exact = findStock(stocks, input.value);
      if (exact && !isSelected(exact)) {
        pick(exact);
      } else if (input.value.trim()) {
        showError("Please choose a valid NSE-listed stock from the suggestions.");
      }
    } else if (e.key === "Escape") {
      closeList();
    }
  });

  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest(".suggestion-item");
    if (!li) return;
    e.preventDefault();
    const idx = Number(li.dataset.index);
    pick(currentMatches[idx]);
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) closeList();
  });

  return {
    clearError,
    showError,
    ready: stocksReady,
    findExact: (query) => findStock(stocks, query),
  };
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
