// Computes the sentiment/price-movement summary row for one stock over one
// horizon. `headlines` is the list already filtered to the horizon window,
// each with a `date` (IST "YYYY-MM-DD") and `score` (FinVADER compound).
// `priceSeries` is the ascending { date, close }[] from Yahoo Finance.
export function computeCorrelation(headlines, priceSeries, horizonStartKey) {
  const headlineCount = headlines.length;

  const scoresByDate = new Map();
  for (const h of headlines) {
    if (!scoresByDate.has(h.date)) scoresByDate.set(h.date, []);
    scoresByDate.get(h.date).push(h.score);
  }
  const dateSentiments = [...scoresByDate.entries()].map(([date, scores]) => ({
    date,
    avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
  }));

  const netSentiment = dateSentiments.length
    ? dateSentiments.reduce((s, d) => s + d.avgScore, 0) / dateSentiments.length
    : null;

  const dates = priceSeries.map((p) => p.date);

  function pointOnOrAfter(dateKey) {
    const index = dates.findIndex((d) => d >= dateKey);
    if (index === -1) return null;
    return { index, ...priceSeries[index] };
  }

  let movementHorizonPct = null;
  const startPoint = pointOnOrAfter(horizonStartKey);
  if (startPoint && priceSeries.length > 0) {
    const endPoint = priceSeries[priceSeries.length - 1];
    if (startPoint.close && endPoint.close) {
      movementHorizonPct = ((endPoint.close - startPoint.close) / startPoint.close) * 100;
    }
  }

  const nextDayReturns = [];
  for (const { date } of dateSentiments) {
    const base = pointOnOrAfter(date);
    if (!base) continue;
    const next = priceSeries[base.index + 1];
    if (!next || base.close == null || next.close == null) continue;
    nextDayReturns.push(((next.close - base.close) / base.close) * 100);
  }

  const nextDayAvgPct = nextDayReturns.length
    ? nextDayReturns.reduce((a, b) => a + b, 0) / nextDayReturns.length
    : null;

  return {
    headlineCount,
    netSentiment,
    movementHorizonPct,
    nextDayAvgPct,
    nextDaySampleSize: nextDayReturns.length,
    dateSentimentCount: dateSentiments.length,
  };
}
