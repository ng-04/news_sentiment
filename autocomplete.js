let stocksPromise = null;

function loadStocks() {
  if (!stocksPromise) {
    stocksPromise = fetch("nse-stocks.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load stock list (${res.status})`);
      return res.json();
    });
  }
  return stocksPromise;
}

const MAX_SUGGESTIONS = 8;

export function initStockAutocomplete({ input, list, error }) {
  let stocks = [];
  let selected = null;
  let currentMatches = [];
  let activeIndex = -1;
  let debounceTimer = null;

  loadStocks()
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
    if (!q || stocks.length === 0) {
      closeList();
      return;
    }

    const starts = [];
    const contains = [];
    for (const s of stocks) {
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

  function selectStock(stock) {
    selected = stock;
    input.value = stock.name;
    clearError();
    closeList();
  }

  input.addEventListener("input", () => {
    selected = null;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderMatches(input.value), 120);
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    const items = list.querySelectorAll(".suggestion-item");

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActiveHighlight(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveHighlight(items);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        e.preventDefault();
        selectStock(currentMatches[activeIndex]);
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
    selectStock(currentMatches[idx]);
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) closeList();
  });

  function resolve() {
    const typed = input.value.trim();
    if (!typed) return null;
    if (selected && selected.name.toLowerCase() === typed.toLowerCase()) {
      return selected;
    }
    return (
      stocks.find(
        (s) =>
          s.name.toLowerCase() === typed.toLowerCase() ||
          s.symbol.toLowerCase() === typed.toLowerCase()
      ) || null
    );
  }

  return { resolve, showError, clearError };
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
