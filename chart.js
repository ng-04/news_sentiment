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
