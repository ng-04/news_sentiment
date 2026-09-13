let stocksPromise = null;

export function loadStockList() {
  if (!stocksPromise) {
    stocksPromise = fetch("nse-stocks.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load stock list (${res.status})`);
      return res.json();
    });
  }
  return stocksPromise;
}

// Exact match only (by full name or ticker symbol, case-insensitive) — used
// both by the autocomplete's Enter-key handling and by URL-based prefill.
export function findStock(stocks, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    stocks.find((s) => s.name.toLowerCase() === q || s.symbol.toLowerCase() === q) || null
  );
}
