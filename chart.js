const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 220;
const PAD = { top: 20, right: 16, bottom: 28, left: 56 };

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function formatDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function formatPrice(v) {
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatPct(v) {
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

// Renders a simple single-series closing-price line chart into `container`.
// `series` is an ascending { date, close }[]. Returns nothing; safe to call
// repeatedly on the same container to redraw.
export function renderPriceChart(container, series, title) {
  container.innerHTML = "";

  if (!series || series.length < 2) {
    const p = document.createElement("p");
    p.className = "chart-empty";
    p.textContent = "Not enough trading days in this horizon to draw a trend line.";
    container.appendChild(p);
    return;
  }

  if (title) {
    const heading = document.createElement("p");
    heading.className = "chart-title";
    heading.textContent = title;
    container.appendChild(heading);
  }

  const width = container.clientWidth || 640;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const closes = series.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || max * 0.01 || 1;
  const yPad = span * 0.1;
  const yMin = min - yPad;
  const yMax = max + yPad;

  const xAt = (i) => PAD.left + (i / (series.length - 1)) * innerW;
  const yAt = (v) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${HEIGHT}`,
    width: "100%",
    height: HEIGHT,
    role: "img",
    "aria-label": `${title || "Closing price"} line chart, ${series[0].date} to ${
      series[series.length - 1].date
    }, from ${formatPrice(min)} to ${formatPrice(max)}`,
  });

  svg.appendChild(
    el("line", {
      x1: PAD.left,
      x2: width - PAD.right,
      y1: PAD.top + innerH,
      y2: PAD.top + innerH,
      class: "chart-baseline",
    })
  );

  const linePath = series.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i)},${yAt(p.close)}`).join(" ");
  svg.appendChild(el("path", { d: linePath, class: "chart-line" }));

  const lastX = xAt(series.length - 1);
  const lastY = yAt(series[series.length - 1].close);
  svg.appendChild(el("circle", { cx: lastX, cy: lastY, r: 5, class: "chart-end-ring" }));
  svg.appendChild(el("circle", { cx: lastX, cy: lastY, r: 4, class: "chart-end-dot" }));

  const maxLabel = el("text", { x: 4, y: yAt(max) + 4, class: "chart-axis-label" });
  maxLabel.textContent = formatPrice(max);
  svg.appendChild(maxLabel);

  const minLabel = el("text", { x: 4, y: yAt(min) + 4, class: "chart-axis-label" });
  minLabel.textContent = formatPrice(min);
  svg.appendChild(minLabel);

  const startLabel = el("text", {
    x: PAD.left,
    y: HEIGHT - 8,
    class: "chart-axis-label",
    "text-anchor": "start",
  });
  startLabel.textContent = formatDateLabel(series[0].date);
  svg.appendChild(startLabel);

  const endLabel = el("text", {
    x: width - PAD.right,
    y: HEIGHT - 8,
    class: "chart-axis-label",
    "text-anchor": "end",
  });
  endLabel.textContent = formatDateLabel(series[series.length - 1].date);
  svg.appendChild(endLabel);

  const crosshair = el("line", {
    x1: 0,
    x2: 0,
    y1: PAD.top,
    y2: PAD.top + innerH,
    class: "chart-crosshair",
  });
  crosshair.style.display = "none";
  svg.appendChild(crosshair);

  const hoverDot = el("circle", { r: 4, class: "chart-hover-dot" });
  hoverDot.style.display = "none";
  svg.appendChild(hoverDot);

  container.appendChild(svg);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  container.style.position = "relative";
  container.appendChild(tooltip);

  function showAt(index) {
    const point = series[index];
    const x = xAt(index);
    const y = yAt(point.close);

    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.style.display = "";

    hoverDot.setAttribute("cx", x);
    hoverDot.setAttribute("cy", y);
    hoverDot.style.display = "";

    tooltip.innerHTML = "";
    const dateEl = document.createElement("div");
    dateEl.className = "chart-tooltip-date";
    dateEl.textContent = formatDateLabel(point.date);
    const priceEl = document.createElement("div");
    priceEl.className = "chart-tooltip-price";
    priceEl.textContent = formatPrice(point.close);
    tooltip.appendChild(dateEl);
    tooltip.appendChild(priceEl);
    tooltip.hidden = false;

    const tooltipWidth = 120;
    let left = (x / width) * container.clientWidth - tooltipWidth / 2;
    left = Math.max(4, Math.min(left, container.clientWidth - tooltipWidth - 4));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `4px`;
  }

  function hide() {
    crosshair.style.display = "none";
    hoverDot.style.display = "none";
    tooltip.hidden = true;
  }

  function nearestIndex(clientX) {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * width;
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(xAt(i) - relX);
      if (d < closestDist) {
        closestDist = d;
        closest = i;
      }
    }
    return closest;
  }

  svg.addEventListener("pointermove", (e) => showAt(nearestIndex(e.clientX)));
  svg.addEventListener("pointerleave", hide);

  let focusedIndex = series.length - 1;
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("focus", () => showAt(focusedIndex));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      focusedIndex = Math.max(0, focusedIndex - 1);
      showAt(focusedIndex);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      focusedIndex = Math.min(series.length - 1, focusedIndex + 1);
      showAt(focusedIndex);
      e.preventDefault();
    }
  });
}

// Renders a multi-stock comparison as a %-change-from-start line chart, so
// stocks at very different price levels are plotted on one shared axis
// (indexing to a common base) rather than a misleading dual/raw-price axis.
// `seriesList` is [{ label, color, points: [{date, close}] }, ...], 2-3
// entries. Each series is independently indexed to its own first point.
export function renderComparisonChart(container, seriesList, title) {
  container.innerHTML = "";

  const usable = seriesList.filter((s) => s.points && s.points.length >= 2);
  if (usable.length === 0) {
    const p = document.createElement("p");
    p.className = "chart-empty";
    p.textContent = "Not enough overlapping trading days in this horizon to compare.";
    container.appendChild(p);
    return;
  }

  if (title) {
    const heading = document.createElement("p");
    heading.className = "chart-title";
    heading.textContent = title;
    container.appendChild(heading);
  }

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  for (const s of usable) {
    const item = document.createElement("span");
    item.className = "chart-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "chart-legend-swatch";
    swatch.style.background = s.color;
    const label = document.createElement("span");
    label.textContent = s.label;
    item.appendChild(swatch);
    item.appendChild(label);
    legend.appendChild(item);
  }
  container.appendChild(legend);

  const dateSet = new Set();
  usable.forEach((s) => s.points.forEach((p) => dateSet.add(p.date)));
  const dates = [...dateSet].sort();

  const indexed = usable.map((s) => {
    const base = s.points[0].close;
    const byDate = new Map(s.points.map((p) => [p.date, p.close]));
    return {
      label: s.label,
      color: s.color,
      values: dates.map((d) => {
        const close = byDate.get(d);
        return close == null ? null : ((close - base) / base) * 100;
      }),
    };
  });

  const allVals = indexed.flatMap((s) => s.values.filter((v) => v != null));
  const rawMin = Math.min(0, ...allVals);
  const rawMax = Math.max(0, ...allVals);
  const span = rawMax - rawMin || 1;
  const yPad = span * 0.15;
  const yMin = rawMin - yPad;
  const yMax = rawMax + yPad;

  const width = container.clientWidth || 640;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const xAt = (i) => PAD.left + (i / (dates.length - 1)) * innerW;
  const yAt = (v) => PAD.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${HEIGHT}`,
    width: "100%",
    height: HEIGHT,
    role: "img",
    "aria-label": `${title || "Comparison"} chart, ${dates[0]} to ${dates[dates.length - 1]}, ${usable
      .map((s) => s.label)
      .join(" vs ")}`,
  });

  svg.appendChild(
    el("line", {
      x1: PAD.left,
      x2: width - PAD.right,
      y1: yAt(0),
      y2: yAt(0),
      class: "chart-zero-line",
    })
  );

  for (const s of indexed) {
    let d = "";
    let drawing = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        drawing = false;
        return;
      }
      d += `${drawing ? "L" : "M"}${xAt(i)},${yAt(v)} `;
      drawing = true;
    });
    svg.appendChild(el("path", { d, class: "chart-line", style: `stroke:${s.color}` }));

    for (let i = s.values.length - 1; i >= 0; i--) {
      if (s.values[i] != null) {
        svg.appendChild(
          el("circle", { cx: xAt(i), cy: yAt(s.values[i]), r: 5, class: "chart-end-ring" })
        );
        svg.appendChild(
          el("circle", {
            cx: xAt(i),
            cy: yAt(s.values[i]),
            r: 4,
            class: "chart-end-dot",
            style: `fill:${s.color}`,
          })
        );
        break;
      }
    }
  }

  const maxLabel = el("text", { x: 4, y: yAt(rawMax) + 4, class: "chart-axis-label" });
  maxLabel.textContent = formatPct(rawMax);
  svg.appendChild(maxLabel);

  const minLabel = el("text", { x: 4, y: yAt(rawMin) + 4, class: "chart-axis-label" });
  minLabel.textContent = formatPct(rawMin);
  svg.appendChild(minLabel);

  const startLabel = el("text", { x: PAD.left, y: HEIGHT - 8, class: "chart-axis-label" });
  startLabel.textContent = formatDateLabel(dates[0]);
  svg.appendChild(startLabel);

  const endLabel = el("text", {
    x: width - PAD.right,
    y: HEIGHT - 8,
    class: "chart-axis-label",
    "text-anchor": "end",
  });
  endLabel.textContent = formatDateLabel(dates[dates.length - 1]);
  svg.appendChild(endLabel);

  const crosshair = el("line", {
    x1: 0,
    x2: 0,
    y1: PAD.top,
    y2: PAD.top + innerH,
    class: "chart-crosshair",
  });
  crosshair.style.display = "none";
  svg.appendChild(crosshair);

  container.appendChild(svg);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  container.style.position = "relative";
  container.appendChild(tooltip);

  function showAt(index) {
    const x = xAt(index);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.style.display = "";

    tooltip.innerHTML = "";
    const dateEl = document.createElement("div");
    dateEl.className = "chart-tooltip-date";
    dateEl.textContent = formatDateLabel(dates[index]);
    tooltip.appendChild(dateEl);

    for (const s of indexed) {
      const v = s.values[index];
      const row = document.createElement("div");
      row.className = "chart-tooltip-row";
      const key = document.createElement("span");
      key.className = "chart-tooltip-key";
      key.style.background = s.color;
      const text = document.createElement("span");
      text.textContent = `${s.label}: `;
      const value = document.createElement("span");
      value.className = "chart-tooltip-price";
      value.textContent = v == null ? "—" : formatPct(v);
      row.appendChild(key);
      row.appendChild(text);
      row.appendChild(value);
      tooltip.appendChild(row);
    }
    tooltip.hidden = false;

    const tooltipWidth = 160;
    let left = (x / width) * container.clientWidth - tooltipWidth / 2;
    left = Math.max(4, Math.min(left, container.clientWidth - tooltipWidth - 4));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `4px`;
  }

  function hide() {
    crosshair.style.display = "none";
    tooltip.hidden = true;
  }

  function nearestIndex(clientX) {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * width;
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < dates.length; i++) {
      const d = Math.abs(xAt(i) - relX);
      if (d < closestDist) {
        closestDist = d;
        closest = i;
      }
    }
    return closest;
  }

  svg.addEventListener("pointermove", (e) => showAt(nearestIndex(e.clientX)));
  svg.addEventListener("pointerleave", hide);

  let focusedIndex = dates.length - 1;
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("focus", () => showAt(focusedIndex));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      focusedIndex = Math.max(0, focusedIndex - 1);
      showAt(focusedIndex);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      focusedIndex = Math.min(dates.length - 1, focusedIndex + 1);
      showAt(focusedIndex);
      e.preventDefault();
    }
  });
}
