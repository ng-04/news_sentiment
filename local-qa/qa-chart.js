// Charts for Local Q&A. Claude only proposes what to plot (propose_chart); this module turns the
// proposal into exact data (computed from the full spreadsheet, or checked against the quoted
// excerpts), shows it as a table for the user to confirm, and then draws the chart as SVG.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_CATEGORIES = 50;
const MAX_STAT_CATEGORIES = 500; // pages of a long PDF; a line chart reads best past ~60
const MAX_SERIES = 6;
const W = 640;
const H = 300;
const PAD = { top: 16, right: 24, bottom: 44, left: 56 };

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const s = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
};

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const cleaned = v.replace(/[,\s₹$€£%]/g, '');
  return /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned) ? parseFloat(cleaned) : NaN;
};
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmtCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const formatValue = (v) => (v == null || Number.isNaN(v) ? '—' : fmt.format(v));

const AGG_LABEL = { sum: 'Sum', average: 'Average', count: 'Count', min: 'Minimum', max: 'Maximum', none: 'Each row (no totals)' };
const TYPE_LABEL = { bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart' };

// ------------------------------------------------------------------ proposal → exact data

/**
 * Turns Claude's propose_chart input into chart data. `files` are the indexed file records
 * ({name, folder, parsed}); `hits` are the excerpts Claude saw (for excerpt-sourced charts).
 * Returns {ok: true, chart} or {ok: false, error}.
 */
export function prepareChart(spec, files, hits, labelFor) {
  try {
    if (!spec || typeof spec !== 'object') throw new Error('the chart proposal was empty');
    const type = spec.chart_type;
    if (!['bar', 'line', 'pie'].includes(type)) throw new Error('unknown chart type');
    const base = {
      title: String(spec.title || 'Chart').slice(0, 120),
      type,
      xLabel: spec.x_label ? String(spec.x_label).slice(0, 60) : '',
      yLabel: spec.y_label ? String(spec.y_label).slice(0, 60) : '',
    };
    const data = spec.source === 'excerpts' ? fromExcerpts(spec.excerpts, hits, labelFor)
      : spec.source === 'document_stats' ? fromStats(spec.document_stats, files)
        : fromSheet(spec.spreadsheet, files);
    const chart = { ...base, ...data };
    if (!chart.categories.length) throw new Error('there is nothing to plot after the filters');
    const cap = spec.source === 'document_stats' ? MAX_STAT_CATEGORIES : MAX_CATEGORIES;
    if (type === 'bar' && chart.categories.length > 60) {
      throw new Error(`${chart.categories.length} bars would be too thin to read; ask for a line chart instead`);
    }
    if (chart.categories.length > cap) {
      throw new Error(`that would plot ${chart.categories.length} categories (at most ${MAX_CATEGORIES}); ask for a filter or a grouping`);
    }
    if (chart.series.length > MAX_SERIES) throw new Error(`at most ${MAX_SERIES} series can be plotted at once`);
    if (type === 'pie') {
      if (chart.series.length !== 1) throw new Error('a pie chart can show only one series; a bar chart would work');
      if (chart.categories.length > 6) throw new Error('a pie chart is only readable with up to 6 parts; a bar chart would work');
      if (chart.series[0].values.some((v) => v == null || v < 0)) throw new Error('a pie chart needs positive values for every part; a bar chart would work');
    }
    return { ok: true, chart };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function fromSheet(sp, files, maxRows = MAX_CATEGORIES) {
  if (!sp) throw new Error('the proposal didn’t say which spreadsheet to use');
  const candidates = files.filter((f) => same(f.name, sp.file) && (f.parsed.tables || []).length);
  const file = candidates.find((f) => sp.folder == null || same(f.folder, sp.folder)) || candidates[0];
  if (!file) throw new Error(`the spreadsheet “${sp.file}” isn’t among your documents`);
  const table = file.parsed.tables.find((t) => same(t.sheet, sp.sheet));
  if (!table) throw new Error(`“${file.name}” has no sheet called “${sp.sheet}”`);
  const col = (name) => {
    const found = table.headers.find((hd) => same(hd, name));
    if (!found) throw new Error(`sheet “${table.sheet}” has no column “${name}” (columns: ${table.headers.join(', ')})`);
    return found;
  };
  const catCol = sp.category_column ? col(sp.category_column) : null; // none = one grand total
  const valueCols = (sp.value_columns || []).map(col);
  if (!valueCols.length) throw new Error('the proposal didn’t name a column to plot');
  const agg = ['sum', 'average', 'count', 'min', 'max', 'none'].includes(sp.aggregation) ? sp.aggregation : 'sum';
  const filters = (sp.filters || []).map((f) => ({ ...f, column: col(f.column) }));

  const rows = table.rows.filter((r) => filters.every((f) => {
    const v = r.values[f.column];
    const a = toNumber(v);
    const b = toNumber(f.value);
    switch (f.op) {
      case 'equals': return Number.isFinite(a) && Number.isFinite(b) ? a === b : same(v, f.value);
      case 'not_equals': return Number.isFinite(a) && Number.isFinite(b) ? a !== b : !same(v, f.value);
      case 'contains': return String(v ?? '').toLowerCase().includes(String(f.value).toLowerCase());
      case 'greater_than': return Number.isFinite(a) && Number.isFinite(b) && a > b;
      case 'less_than': return Number.isFinite(a) && Number.isFinite(b) && a < b;
      default: return true;
    }
  }));

  let categories;
  let series;
  if (agg === 'none' && !catCol) throw new Error('“each row” needs a category column');
  if (agg === 'none') {
    if (rows.length > maxRows) {
      throw new Error(`that would list ${rows.length} rows one by one (at most ${maxRows}); ask for totals by a category, or a filter`);
    }
    categories = rows.map((r) => String(r.values[catCol] ?? `Row ${r.row}`));
    series = valueCols.map((c) => ({ name: c, values: rows.map((r) => { const n = toNumber(r.values[c]); return Number.isFinite(n) ? n : null; }) }));
  } else {
    const groups = new Map();
    for (const r of rows) {
      const key = catCol ? String(r.values[catCol] ?? '(blank)') : 'All selected rows';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    categories = [...groups.keys()];
    series = valueCols.map((c) => ({
      name: agg === 'count' ? `Count of ${c}` : c,
      values: categories.map((k) => {
        const nums = groups.get(k).map((r) => toNumber(r.values[c])).filter(Number.isFinite);
        if (agg === 'count') return groups.get(k).filter((r) => r.values[c] != null && r.values[c] !== '').length;
        if (!nums.length) return null;
        if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
        if (agg === 'average') return nums.reduce((a, b) => a + b, 0) / nums.length;
        if (agg === 'min') return Math.min(...nums);
        return Math.max(...nums);
      }),
    }));
  }
  for (const sr of series) {
    if (sr.values.every((v) => v == null)) throw new Error(`column “${sr.name}” has no numbers in the selected rows`);
  }

  const order = categories.map((_, i) => i);
  const first = series[0].values;
  if (sp.sort === 'category') order.sort((a, b) => categories[a].localeCompare(categories[b], undefined, { numeric: true }));
  else if (sp.sort === 'value_desc') order.sort((a, b) => (first[b] ?? -Infinity) - (first[a] ?? -Infinity));
  else if (sp.sort === 'value_asc') order.sort((a, b) => (first[a] ?? Infinity) - (first[b] ?? Infinity));
  categories = order.map((i) => categories[i]);
  series = series.map((sr) => ({ ...sr, values: order.map((i) => sr.values[i]) }));

  const used = rows.map((r) => r.row);
  const path = file.folder ? `${file.folder}/${file.name}` : file.name;
  const rowText = used.length ? ` · rows ${Math.min(...used)}–${Math.max(...used)} (${used.length} used)` : '';
  return {
    categories, series, quoted: false,
    settings: [
      ['Chart type', null],
      ['X axis (categories)', catCol || 'None (grand total)'],
      ['Y values', valueCols.join(', ')],
      ['Totals', AGG_LABEL[agg]],
      ['Filters', filters.length ? filters.map((f) => `${f.column} ${f.op.replace('_', ' ')} “${f.value}”`).join('; ') : 'None (all rows)'],
    ],
    sourceLine: `${path} · sheet “${table.sheet}”${rowText}`,
  };
}

const countWords = (t) => (t.match(/\S+/g) || []).length;

function fromStats(st, files) {
  if (!st) throw new Error('the proposal didn’t say what to count');
  const measure = st.measure === 'characters' ? 'characters' : 'words';
  const count = (t) => (measure === 'words' ? countWords(t) : t.replace(/\s+/g, ' ').trim().length);
  const unitName = measure === 'words' ? 'Words' : 'Characters';
  const pick = () => {
    const candidates = st.file ? files.filter((f) => same(f.name, st.file)) : files;
    const f = candidates.find((x) => st.folder == null || same(x.folder, st.folder)) || candidates[0];
    if (!f) throw new Error(st.file ? `“${st.file}” isn’t among your documents` : 'there are no documents');
    if (!st.file && files.length > 1) throw new Error('name the file to count page by page (you have several documents)');
    return f;
  };
  const pathOf = (f) => (f.folder ? `${f.folder}/${f.name}` : f.name);
  let categories;
  let values;
  let sourceLine;
  let groupLabel;
  if (st.group_by === 'file') {
    const list = st.file ? [pick()] : files;
    categories = list.map((f) => f.name);
    values = list.map((f) => f.parsed.units.reduce((n, u) => n + count(u.text), 0));
    sourceLine = `Counted from the extracted text of ${list.length === 1 ? pathOf(list[0]) : `${list.length} documents`}`;
    groupLabel = 'File';
  } else if (st.group_by === 'page') {
    const f = pick();
    if (!f.pages) throw new Error(`“${f.name}” has no pages (it isn’t a PDF); count by section or by file instead`);
    const byPage = new Map(f.parsed.units.map((u) => [u.page, count(u.text)]));
    categories = Array.from({ length: f.pages }, (_, i) => `Page ${i + 1}`);
    values = categories.map((_, i) => byPage.get(i + 1) || 0); // pages without text count as 0
    sourceLine = `Counted from the text layer of ${pathOf(f)} · ${f.pages} pages`;
    groupLabel = 'Page';
  } else {
    const f = pick();
    if (f.pages || (f.parsed.tables && f.parsed.tables.length)) throw new Error(`“${f.name}” isn’t a Word document; count by page or by file instead`);
    categories = f.parsed.units.map((u, i) => u.section || `Section ${i + 1}`);
    values = f.parsed.units.map((u) => count(u.text));
    sourceLine = `Counted from the text of ${pathOf(f)} · ${f.parsed.units.length} sections`;
    groupLabel = 'Section';
  }
  return {
    categories, series: [{ name: unitName, values }], quoted: false,
    settings: [
      ['Chart type', null],
      ['X axis (categories)', groupLabel],
      ['Y values', `${unitName} (counted by this page)`],
      ['How counted', measure === 'words' ? 'Words = runs of text separated by spaces, from the extracted text; scanned pages without text count as 0'
        : 'Characters, with runs of spaces collapsed, from the extracted text'],
    ],
    sourceLine,
  };
}

function fromExcerpts(ex, hits, labelFor) {
  if (!ex || !Array.isArray(ex.categories) || !Array.isArray(ex.series)) throw new Error('the proposal had no figures');
  const categories = ex.categories.map((c) => String(c).slice(0, 80));
  const refs = new Set();
  const series = ex.series.map((sr) => {
    const values = (sr.values || []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    const nums = sr.excerpt_numbers || [];
    if (values.length !== categories.length || nums.length !== categories.length) {
      throw new Error('the quoted figures didn’t line up with the categories');
    }
    nums.forEach((n) => {
      if (!Number.isInteger(n) || n < 1 || n > hits.length) throw new Error('a figure pointed at an excerpt that doesn’t exist');
      refs.add(n);
    });
    return { name: String(sr.name || 'Value').slice(0, 60), values, refs: nums };
  });
  const sources = [...refs].sort((a, b) => a - b).map((n) => `[${n}] ${labelFor(hits[n - 1].chunk)}`);
  return {
    categories, series, quoted: true,
    settings: [
      ['Chart type', null],
      ['Categories', categories.length > 6 ? `${categories.slice(0, 6).join(', ')}, …` : categories.join(', ')],
      ['Y values', series.map((sr) => sr.name).join(', ')],
      ['Numbers from', 'Figures quoted from the documents (checked against the passages below)'],
    ],
    sourceLine: `Figures quoted from the documents: ${sources.join('; ')}`,
  };
}

// ------------------------------------------------------------------ exact calculations for answers

/** Runs a `calculate` request: the same exact maths as charts, returned as text for Claude and as a
 *  table to show the user. Returns {ok, text, table?, error?}. */
export function computeTable(spec, files) {
  try {
    if (!spec || !['spreadsheet', 'document_stats'].includes(spec.source)) throw new Error('source must be spreadsheet or document_stats');
    const data = spec.source === 'document_stats' ? fromStats(spec.document_stats, files) : fromSheet(spec.spreadsheet, files, 200);
    const table = { ...data, settings: data.settings.filter(([k]) => k !== 'Chart type'), title: 'Calculated by the page' };
    const head = ['Category', ...table.series.map((s) => s.name)].join(' | ');
    const body = table.categories.map((c, i) => [c, ...table.series.map((s) => (s.values[i] == null ? '' : +s.values[i].toFixed(4)))].join(' | '));
    const text = `${head}\n${body.join('\n')}\n\nSource: ${table.sourceLine}. ${table.settings.map(([k, v]) => `${k}: ${v}`).join('; ')}.`;
    return { ok: true, text, table };
  } catch (e) {
    return { ok: false, text: `Could not calculate: ${e.message}.`, error: e.message };
  }
}

// ------------------------------------------------------------------ confirmation tables

export function renderTables(chart, { limit = 50 } = {}) {
  const settings = h('table', { class: 'qa-table qa-table-settings' }, h('tbody', {},
    chart.settings.map(([k, v]) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { text: v ?? TYPE_LABEL[chart.type] ?? '' }))),
    h('tr', {}, h('th', { scope: 'row', text: 'Source' }), h('td', { text: chart.sourceLine }))));
  const head = h('tr', {}, h('th', { scope: 'col', text: chart.xLabel || 'Category' }),
    chart.series.map((sr) => h('th', { scope: 'col', class: 'qa-num', text: sr.name })));
  const more = chart.categories.length > limit
    ? h('p', { class: 'qa-help', text: `Showing the first ${limit} of ${chart.categories.length} rows; the chart and CSV use all of them.` }) : null;
  const body = chart.categories.slice(0, limit).map((c, i) => h('tr', {}, h('th', { scope: 'row', text: c }),
    chart.series.map((sr) => h('td', { class: 'qa-num' }, formatValue(sr.values[i]),
      sr.refs ? h('span', { class: 'qa-ref', text: ` [${sr.refs[i]}]` }) : null))));
  const data = h('div', { class: 'qa-table-wrap' }, h('table', { class: 'qa-table' },
    h('caption', { class: 'qa-sr-only', text: `Data for ${chart.title}` }), h('thead', {}, head), h('tbody', {}, body)), more);
  return { settings, data };
}

// ------------------------------------------------------------------ drawing

function palette() {
  const css = getComputedStyle(document.documentElement);
  const read = (v, fallback) => (css.getPropertyValue(v).trim() || fallback);
  return {
    series: [1, 2, 3, 4, 5, 6].map((i) => read(`--qa-series-${i}`, '#1a56db')),
    surface: read('--bg', '#ffffff'),
    ink: read('--ink', '#111827'),
    muted: read('--gray-600', '#4b5563'),
    grid: read('--gray-100', '#f3f4f6'),
    axis: read('--gray-300', '#d1d5db'),
  };
}

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

const truncate = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Bar with a 4px rounded data end and a square baseline end. */
function barPath(x, w, yBase, yEnd) {
  const r = Math.min(4, w / 2, Math.abs(yBase - yEnd));
  if (yEnd <= yBase) { // positive: rounded top
    return `M${x},${yBase} V${yEnd + r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd + r} V${yBase} Z`;
  }
  return `M${x},${yBase} V${yEnd - r} Q${x},${yEnd} ${x + r},${yEnd} H${x + w - r} Q${x + w},${yEnd} ${x + w},${yEnd - r} V${yBase} Z`;
}

export function renderChart(chart) {
  const pal = palette();
  const figure = h('figure', { class: 'qa-chart' });
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${TYPE_LABEL[chart.type]}: ${chart.title}. Data table below.`, 'font-family': 'Inter, system-ui, sans-serif' });
  svg.append(s('rect', { x: 0, y: 0, width: W, height: H, fill: pal.surface }));
  const tooltip = h('div', { class: 'qa-chart-tip', hidden: true });

  figure.append(h('figcaption', { class: 'qa-chart-title', text: chart.title }));
  if (chart.series.length >= 2 || chart.type === 'pie') {
    const items = chart.type === 'pie'
      ? chart.categories.map((c, i) => [c, pal.series[i]])
      : chart.series.map((sr, i) => [sr.name, pal.series[i]]);
    figure.append(h('ul', { class: 'qa-legend' }, items.map(([name, color]) =>
      h('li', {}, h('span', { class: 'qa-swatch', style: `background:${color}` }), name))));
  }

  const showTip = (evt, lines) => {
    tooltip.replaceChildren(...lines.map(([label, value, color], i) => h('div', { class: i ? 'qa-tip-row' : 'qa-tip-head' },
      color ? h('span', { class: 'qa-swatch', style: `background:${color}` }) : null, label, value != null ? h('b', { text: ` ${value}` }) : null)));
    tooltip.hidden = false;
    const box = figure.getBoundingClientRect();
    const x = Math.min(Math.max(evt.clientX - box.left + 12, 4), box.width - 180);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${evt.clientY - box.top + 12}px`;
  };
  const hideTip = () => { tooltip.hidden = true; };

  if (chart.type === 'pie') drawPie(svg, chart, pal, showTip, hideTip);
  else drawCartesian(svg, chart, pal, showTip, hideTip);

  figure.append(h('div', { class: 'qa-chart-plot' }, svg, tooltip));
  figure.append(h('p', { class: 'qa-help qa-chart-source', text: `${chart.quoted ? '' : 'Source: '}${chart.sourceLine}` }));
  figure.append(h('div', { class: 'qa-row qa-row-center qa-chart-actions' },
    h('button', { type: 'button', class: 'btn-link', onclick: () => downloadPng(svg, chart) }, 'Download PNG'),
    h('button', { type: 'button', class: 'btn-link', onclick: () => downloadCsv(chart) }, 'Download CSV')));
  return figure;
}

function drawCartesian(svg, chart, pal, showTip, hideTip) {
  const k = chart.series.length;
  const directLabels = chart.type === 'line' && k >= 2 && k <= 4;
  const right = PAD.right + (directLabels ? 84 : 0); // room for labels at the line ends
  const innerW = W - PAD.left - right;
  const innerH = H - PAD.top - PAD.bottom;
  const all = chart.series.flatMap((sr) => sr.values).filter((v) => v != null);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const n = chart.categories.length;
  const band = innerW / n;
  const cx = (i) => PAD.left + band * i + band / 2;

  for (const t of ticks) { // recessive grid + y labels
    svg.append(s('line', { x1: PAD.left, x2: W - right, y1: y(t), y2: y(t), stroke: t === 0 ? pal.axis : pal.grid, 'stroke-width': 1 }));
    const label = s('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: pal.muted });
    label.textContent = fmtCompact.format(t);
    svg.append(label);
  }
  if (chart.yLabel) {
    const yl = s('text', { x: 12, y: PAD.top + innerH / 2, 'font-size': 11, fill: pal.muted, 'text-anchor': 'middle', transform: `rotate(-90 12 ${PAD.top + innerH / 2})` });
    yl.textContent = truncate(chart.yLabel, 40);
    svg.append(yl);
  }
  const every = Math.max(1, Math.ceil(n / 12));
  const maxChars = Math.max(4, Math.floor((band * every) / 7));
  chart.categories.forEach((c, i) => {
    if (i % every) return;
    const t = s('text', { x: cx(i), y: H - PAD.bottom + 18, 'text-anchor': 'middle', 'font-size': 11, fill: pal.muted });
    t.textContent = truncate(c, maxChars);
    svg.append(t);
  });

  if (chart.type === 'bar') {
    const gap = 2;
    const barW = Math.max(3, Math.min(24, (band * 0.72 - gap * (k - 1)) / k));
    const groupW = barW * k + gap * (k - 1);
    chart.series.forEach((sr, si) => sr.values.forEach((v, i) => {
      if (v == null) return;
      const x = cx(i) - groupW / 2 + si * (barW + gap);
      svg.append(s('path', { d: barPath(x, barW, y(0), y(v)), fill: pal.series[si] }));
    }));
  } else {
    chart.series.forEach((sr, si) => {
      let d = '';
      let pen = false; // lift the pen over missing values so gaps stay visible
      sr.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${cx(i)},${y(v)} `;
        pen = true;
      });
      svg.append(s('path', { d: d.trim(), fill: 'none', stroke: pal.series[si], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      sr.values.forEach((v, i) => {
        if (v != null) svg.append(s('circle', { cx: cx(i), cy: y(v), r: 4, fill: pal.series[si], stroke: pal.surface, 'stroke-width': 2 }));
      });
    });
  }

  if (directLabels) { // name each line at its end, nudged apart so labels never overlap
    const labels = chart.series.map((sr, si) => {
      const last = sr.values.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
      return last ? { name: sr.name, x: cx(last[1]) + 10, y: y(last[0]) + 4, si } : null;
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
    const overflow = labels.length ? labels[labels.length - 1].y - (PAD.top + innerH) : 0;
    if (overflow > 0) labels.forEach((l) => { l.y -= overflow; });
    for (const l of labels) {
      const t = s('text', { x: l.x, y: l.y, 'font-size': 11, fill: pal.ink });
      t.textContent = truncate(l.name, 14);
      svg.append(t);
    }
  }

  const cross = s('line', { y1: PAD.top, y2: PAD.top + innerH, stroke: pal.axis, 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  chart.categories.forEach((c, i) => { // hit targets bigger than the marks
    const hit = s('rect', { x: PAD.left + band * i, y: PAD.top, width: band, height: innerH, fill: 'transparent' });
    const lines = [[c], ...chart.series.map((sr, si) => [sr.name, formatValue(sr.values[i]), pal.series[si]])];
    hit.addEventListener('mousemove', (e) => {
      if (chart.type === 'line') { cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.setAttribute('visibility', 'visible'); }
      showTip(e, lines);
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    svg.append(hit);
  });
}

function drawPie(svg, chart, pal, showTip, hideTip) {
  const values = chart.series[0].values;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cxp = W / 2;
  const cyp = (H - 8) / 2 + 4;
  const r = Math.min(W, H) / 2 - 20;
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const a2 = angle + (v / total) * Math.PI * 2;
    const large = a2 - angle > Math.PI ? 1 : 0;
    const p = (a) => `${cxp + r * Math.cos(a)},${cyp + r * Math.sin(a)}`;
    const d = values.length === 1 ? `M${cxp - r},${cyp} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`
      : `M${cxp},${cyp} L${p(angle)} A${r},${r} 0 ${large} 1 ${p(a2)} Z`;
    const slice = s('path', { d, fill: pal.series[i], stroke: pal.surface, 'stroke-width': 2 });
    const pct = `${fmt.format((v / total) * 100)}%`;
    slice.addEventListener('mousemove', (e) => showTip(e, [[chart.categories[i]], [chart.series[0].name, `${formatValue(v)} (${pct})`, pal.series[i]]]));
    slice.addEventListener('mouseleave', hideTip);
    svg.append(slice);
    angle = a2;
  });
}

// ------------------------------------------------------------------ downloads

const safeName = (t) => (t || 'chart').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'chart';

function save(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function downloadCsv(chart) {
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [[chart.xLabel || 'Category', ...chart.series.map((sr) => sr.name)].map(cell).join(',')];
  chart.categories.forEach((c, i) => lines.push([c, ...chart.series.map((sr) => sr.values[i] ?? '')].map(cell).join(',')));
  lines.push('', cell(`Source: ${chart.sourceLine}`));
  save(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }), `${safeName(chart.title)}.csv`);
}

function downloadPng(svg, chart) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', W * 2);
  clone.setAttribute('height', H * 2);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const canvas = h('canvas', { width: W * 2, height: H * 2 });
    canvas.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => save(blob, `${safeName(chart.title)}.png`), 'image/png');
  };
  img.src = url;
}
