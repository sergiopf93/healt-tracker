import {
  CYCLE_TYPES, METRICS, createCycleRecord, createMeasurement, cycleWeek, daysBetween,
  averageMetricByCycleWeek, deriveMetrics, displayUnit, effectiveObservation, fromCanonical, isObservationConflict,
  isValidDateOnly, makeManualBaselineObservations, observationValues, percentageChange,
  difference, parseLocaleNumber, resolveObservation, selectReference, setManualObservations,
  toCanonical, todayLocalDate
} from "./domain.mjs";
import { createRepository, makeExport } from "./data/repository.mjs";
import { readRemoteConfig, RemoteRepository, REMOTE_CONFIG_KEY } from "./data/remote-repository.mjs";
import { parseHealthData, parseHealthDataParam } from "./integrations/apple-health/parser.mjs";
import {
  attachShortcutImport, buildAppleHealthShortcutUrl, createShortcutDraft,
  isShortcutDraftFresh, manualEntriesFromDraft, SHORTCUT_DRAFT_STORAGE_KEY
} from "./integrations/apple-health/shortcut.mjs";

const app = document.querySelector("#app");
const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const state = { view: "summary", cycleId: null, measurementId: null, comparison: "start", toast: null, toastKind: "info", busy: false, pendingShortcutDraft: null, remoteConnected: false, chartFocus: {}, chartScroll: {} };
let repository;
let snapshot = { cycles: [], measurements: [], settings: { units: "metric" } };
let pendingImportPollTimer = null;
let pendingImportWaitUntil = 0;
let remoteRefreshPromise = null;
const PENDING_IMPORT_WAIT_MS = 45_000;
const PENDING_IMPORT_POLL_MS = 1_500;

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function displayDate(date) {
  if (!isValidDateOnly(date)) return "Fecha pendiente";
  return dateFormat.format(new Date(`${date}T12:00:00Z`));
}

function formatValue(metricId, value, system = snapshot.settings.units, decimals = 1) {
  if (!Number.isFinite(value)) return "—";
  const shown = fromCanonical(metricId, value, system);
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(shown);
}

function valueWithUnit(metricId, value, system = snapshot.settings.units) {
  return `${formatValue(metricId, value, system)} ${displayUnit(metricId, system)}`;
}

function metricById(id) {
  return METRICS.find(metric => metric.id === id);
}

function allCycleMeasurements(cycleId) {
  return snapshot.measurements.filter(measurement => measurement.cycleId === cycleId).sort((a, b) => a.date.localeCompare(b.date));
}

function activeCycle() {
  return snapshot.cycles.find(cycle => cycle.status === "active") || null;
}

function currentCycle() {
  return snapshot.cycles.find(cycle => cycle.id === state.cycleId) || activeCycle();
}

function typeLabel(type) {
  const cycleType = CYCLE_TYPES.find(item => item.id === type);
  return cycleType ? cycleType.label : "Ciclo";
}

function setToast(message, kind = "success") {
  window.clearTimeout(render.toastTimer);
  render.toastTimer = null;
  state.toast = message;
  state.toastKind = kind;
}

function toastMarkup() {
  return state.toast ? `<div class="toast toast-${escapeHtml(state.toastKind)}" role="${state.toastKind === "error" ? "alert" : "status"}">${escapeHtml(state.toast)}</div>` : "";
}

function updateToastInPlace() {
  const previous = app.querySelector(".toast");
  if (previous) previous.remove();
  if (!state.toast) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${state.toastKind}`;
  toast.setAttribute("role", state.toastKind === "error" ? "alert" : "status");
  toast.textContent = state.toast;
  app.append(toast);
}

function shell(content) {
  const tabs = [
    ["summary", "Resumen", '<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5"/><path d="M3.5 5.5v6.5H10"/><path d="M12 7v5l3.5 2"/></svg>'],
    ["cycles", "Ciclos", '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3.5v3M16 3.5v3M4 9.5h16M8 13h3M8 16h6"/></svg>'],
    ["settings", "Ajustes", '<svg viewBox="0 0 24 24"><path d="M12 3.5 14 5l2.5-.2 1 2.3 2.1 1.4-.5 2.5.8 2.4-1.8 1.8-.4 2.5-2.4.8-1.5 2-2.5-.8-2.4.8-1.5-2-2.4-.8-.4-2.5-1.8-1.8.8-2.4-.5-2.5 2.1-1.4 1-2.3L10 5z"/><circle cx="12" cy="12" r="3"/></svg>']
  ];
  return `
    <div class="app-frame">
      <header class="topbar">
        <a class="brand" href="./" data-action="navigate" data-view="summary" aria-label="Health Tracker, resumen">
          <span class="brand-mark" aria-hidden="true"><span></span></span>
          <span>health<span class="brand-light">tracker</span></span>
        </a>
        <span class="privacy-chip"><span class="privacy-dot"></span> ${state.remoteConnected ? "Sincronizado en privado" : "Solo en este dispositivo"}</span>
      </header>
      <main id="main-content" class="main-content" tabindex="-1">${content}</main>
      ${toastMarkup()}
      <nav class="bottom-nav" aria-label="Navegación principal">
        ${tabs.map(([view, label, icon]) => {
          const active = state.view === view || (view === "cycles" && ["cycle-detail", "create-cycle", "measurement-form"].includes(state.view));
          return `<button class="nav-item ${active ? "is-active" : ""}" type="button" data-action="navigate" data-view="${view}" aria-current="${active ? "page" : "false"}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
        }).join("")}
      </nav>
    </div>`;
}

function emptySummary() {
  return `<section class="welcome-panel">
    <div class="welcome-orbit" aria-hidden="true"><span></span><i></i></div>
    <p class="eyebrow">UN PASO A LA VEZ</p>
    <h1>Tu evolución,<br><em>a tu ritmo.</em></h1>
    <p class="intro-copy">Registra tus mediciones y observa los cambios a lo largo de cada ciclo. Sin objetivos impuestos ni semanas perdidas.</p>
    <button class="button button-primary button-wide" type="button" data-action="new-cycle">Crear mi primer ciclo <span aria-hidden="true">↗</span></button>
    <p class="privacy-note">Tus datos se guardan solo en este navegador.</p>
  </section>`;
}

function latestOf(measurements) {
  return measurements.slice().sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

function comparisonOptions(cycle, latest) {
  const latestWeek = latest ? cycleWeek(cycle.startDate, latest.date) : 1;
  const options = [`<option value="start" ${state.comparison === "start" ? "selected" : ""}>Inicio del ciclo</option>`];
  for (let week = 1; week <= Math.min(16, latestWeek - 1); week += 1) {
    options.push(`<option value="${week}" ${state.comparison === String(week) ? "selected" : ""}>${week} ${week === 1 ? "semana" : "semanas"} antes</option>`);
  }
  return options.join("");
}

function metricDiffRow(metricId, latest, reference) {
  const metric = metricById(metricId);
  const current = effectiveObservation(latest, metricId);
  const base = reference && effectiveObservation(reference, metricId);
  const conflict = isObservationConflict(observationValues(latest, metricId)) || (reference && isObservationConflict(observationValues(reference, metricId)));
  if (conflict) return `<div class="comparison-row"><span>${escapeHtml(metric.label)}</span><strong class="value-muted">Resolver origen</strong></div>`;
  if (!current || !base) return `<div class="comparison-row"><span>${escapeHtml(metric.label)}</span><strong class="value-muted">Sin datos para comparar</strong></div>`;
  const delta = difference(current.value, base.value);
  const relative = percentageChange(current.value, base.value);
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const displayDelta = Math.abs(fromCanonical(metricId, delta, snapshot.settings.units));
  const unit = displayUnit(metricId, snapshot.settings.units);
  return `<div class="comparison-row"><span>${escapeHtml(metric.label)}</span><strong>${sign}${numberFormat.format(displayDelta)} ${escapeHtml(unit)} <small>${relative === null ? "" : `(${relative > 0 ? "+" : ""}${numberFormat.format(relative)}%)`}</small></strong></div>`;
}

function readingSummary(measurement) {
  if (!measurement) return `<div class="soft-empty"><span class="empty-glyph" aria-hidden="true">◌</span><p>Aún no hay mediciones</p><span>Registra una cuando quieras; no hay un día obligatorio.</span></div>`;
  const ids = ["Weight", "Body Fat Percentage", "Lean Body Mass", "Resting Calories"];
  const rows = ids.map(id => {
    const metric = metricById(id);
    const observation = effectiveObservation(measurement, id);
    const conflict = isObservationConflict(observationValues(measurement, id));
    if (conflict) return `<div class="reading-row"><span>${escapeHtml(metric.label)}</span><strong class="value-muted">Hay valores distintos</strong></div>`;
    if (!observation) return "";
    return `<div class="reading-row"><span>${escapeHtml(metric.label)}</span><strong>${valueWithUnit(id, observation.value)}</strong></div>`;
  }).filter(Boolean).join("");
  const derived = deriveMetrics(measurement);
  const derivedRows = [
    ["Masa grasa calculada", derived.fatMass],
    ["Masa libre de grasa", derived.fatFreeMass]
  ].filter(([, item]) => item).map(([label, item]) => `<div class="reading-row"><span>${escapeHtml(label)}</span><strong>${valueWithUnit("Weight", item.value)}</strong></div>`).join("");
  return `<div class="reading-list">${rows || `<p class="value-muted">Esta medición no contiene valores disponibles.</p>`}${derivedRows}</div>`;
}

function chartFor(cycle, metricIds, title, subtitle) {
  const measurements = allCycleMeasurements(cycle.id);
  const colors = ["#c87557", "#5f8271", "#7886a0", "#d0a85e"];
  const left = 42, top = 18, bottom = 132, weekWidth = 58;
  const plotWidth = 16 * weekWidth;
  const right = left + plotWidth;
  const axisRight = right + Math.max(0, metricIds.length - 1) * 48 + 8;
  const svgWidth = axisRight + 8;
  const series = metricIds.map((metricId, seriesIndex) => {
    const values = metricId === "Steps"
      ? averageMetricByCycleWeek(measurements, metricId, cycle.startDate).map(point => ({ metricId, week: point.week, value: point.value, count: point.count, dayOffset: (point.week - 0.5) * 7 }))
      : measurements.flatMap(measurement => {
        const observation = effectiveObservation(measurement, metricId);
        return observation ? [{ metricId, measurement, value: observation.value, week: cycleWeek(cycle.startDate, measurement.date), dayOffset: daysBetween(cycle.startDate, measurement.date) }] : [];
      }).sort((a, b) => a.dayOffset - b.dayOffset);
    const coords = values.map(point => ({
      ...point,
      shown: fromCanonical(metricId, point.value, snapshot.settings.units),
      x: left + Math.max(0, Math.min(1, point.dayOffset / (16 * 7 - 1))) * (plotWidth - weekWidth / 2)
    }));
    const shown = coords.map(point => point.shown);
    const minimum = shown.length ? Math.min(...shown) : 0;
    const maximum = shown.length ? Math.max(...shown) : 1;
    const padding = maximum === minimum ? Math.max(Math.abs(maximum) * 0.04, 0.5) : (maximum - minimum) * 0.18;
    const domain = [minimum - padding, maximum + padding];
    for (const point of coords) point.y = bottom - ((point.shown - domain[0]) / (domain[1] - domain[0])) * (bottom - top);
    return { metricId, color: colors[seriesIndex % colors.length], coords, points: values.length, domain };
  });
  const dimensions = new Set(metricIds.map(metricId => metricById(metricId)?.dimension));
  const sharedScale = dimensions.size === 1;
  if (sharedScale) {
    const shown = series.flatMap(item => item.coords.map(point => point.shown));
    const minimum = shown.length ? Math.min(...shown) : 0;
    const maximum = shown.length ? Math.max(...shown) : 1;
    const padding = maximum === minimum ? Math.max(Math.abs(maximum) * 0.04, 0.5) : (maximum - minimum) * 0.18;
    const domain = [minimum - padding, maximum + padding];
    for (const item of series) {
      item.domain = domain;
      for (const point of item.coords) point.y = bottom - ((point.shown - domain[0]) / (domain[1] - domain[0])) * (bottom - top);
    }
  }
  const points = series.reduce((sum, item) => sum + item.points, 0);
  const chartId = `${cycle.id}-${metricIds.join("-")}`;
  const selected = state.chartFocus[chartId] || [];
  const focusActive = selected.length > 0;
  const legend = series.map(item => {
    const pressed = focusActive ? selected.includes(item.metricId) : true;
    return `<button class="legend-item ${pressed ? "" : "is-dimmed"}" type="button" data-action="focus-series" data-chart-id="${escapeHtml(chartId)}" data-series-id="${escapeHtml(item.metricId)}" aria-pressed="${pressed}"><i style="--series-color:${item.color}"></i>${escapeHtml(metricById(item.metricId).label)}</button>`;
  }).join("");
  const grid = [0, 0.5, 1].map(fraction => {
    const y = bottom - fraction * (bottom - top);
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#e8e7e0" stroke-dasharray="3 5"/>`;
  }).join("");
  const axisSeries = sharedScale ? series.slice(0, 1) : series;
  const axes = axisSeries.map((item, index) => {
    const x = index === 0 ? left - 5 : right + 5 + (index - 1) * 48;
    const anchor = index === 0 ? "end" : "start";
    const values = [1, 0.5, 0].map(fraction => numberFormat.format(item.domain[0] + fraction * (item.domain[1] - item.domain[0])));
    return `<g fill="${item.color}" font-size="8"><text x="${x}" y="${top + 3}" text-anchor="${anchor}">${values[0]}</text><text x="${x}" y="${(top + bottom) / 2 + 3}" text-anchor="${anchor}">${values[1]}</text><text x="${x}" y="${bottom + 3}" text-anchor="${anchor}">${values[2]}</text></g>`;
  }).join("");
  const xTicks = Array.from({ length: 16 }, (_, index) => {
    const week = index + 1;
    const x = left + index * weekWidth + weekWidth / 2;
    return `<text x="${x}" y="${bottom + 14}" text-anchor="middle" fill="#888980" font-size="9">S${week}</text>`;
  }).join("");
  const plotted = series.map(item => {
    const segments = [];
    let segment = [];
    for (const point of item.coords) {
      if (segment.length && point.week - segment[segment.length - 1].week > 1) { segments.push(segment); segment = []; }
      segment.push(point);
    }
    if (segment.length) segments.push(segment);
    const paths = segments.filter(group => group.length > 1).map(group => `<path d="${group.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ")}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
    const dots = item.coords.map(point => {
      const when = point.measurement ? displayDate(point.measurement.date) : `Semana ${point.week}`;
      return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.6" fill="#fff" stroke="${item.color}" stroke-width="1.7"><title>${escapeHtml(metricById(item.metricId).label)} · ${escapeHtml(when)}: ${escapeHtml(valueWithUnit(item.metricId, point.value))}${item.metricId === "Steps" ? ` · media de ${point.count} ${point.count === 1 ? "día" : "días"}` : ""}</title></circle>`;
    }).join("");
    return `<g class="chart-series-markup" opacity="${focusActive && !selected.includes(item.metricId) ? "0.12" : "1"}">${paths}${dots}</g>`;
  }).join("");
  const list = series.flatMap(item => item.coords.map(point => `<li><span>${escapeHtml(metricById(item.metricId).label)} · semana ${point.week}${point.measurement ? ` · ${escapeHtml(displayDate(point.measurement.date))}` : point.metricId === "Steps" ? ` · media de ${point.count} días` : ""}</span><strong>${escapeHtml(valueWithUnit(item.metricId, point.value))}</strong></li>`)).join("");
  const focusDate = cycle.status === "active" ? todayLocalDate() : cycle.closedAt || measurements[measurements.length - 1]?.date || cycle.startDate;
  const weekNow = Math.min(16, Math.max(1, cycleWeek(cycle.startDate, focusDate)));
  const unitLabels = axisSeries.map((item, index) => {
    const x = index === 0 ? left : right + 5 + (index - 1) * 48;
    const anchor = index === 0 ? "start" : "start";
    return `<text x="${x}" y="10" fill="${item.color}" font-size="8" text-anchor="${anchor}">${escapeHtml(displayUnit(item.metricId, snapshot.settings.units))}</text>`;
  }).join("");
  return `<section class="chart-card">
    <div class="section-heading"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)} · ${sharedScale ? "escala vertical compartida" : "escalas verticales independientes por serie"}</p></div><span class="chart-count">${points} ${points === 1 ? "dato" : "datos"}</span></div>
    ${points ? `<div class="chart-wrap" data-chart-id="${escapeHtml(chartId)}" data-current-week="${weekNow}"><svg width="${svgWidth}" height="158" viewBox="0 0 ${svgWidth} 158" role="img" aria-label="${escapeHtml(title)} durante las 16 semanas, con ${sharedScale ? "escala compartida" : "escalas independientes por serie"}."><title>${escapeHtml(title)}</title>${grid}${axes}${xTicks}${plotted}${unitLabels}<text x="${(left + right) / 2}" y="154" text-anchor="middle" fill="#888980" font-size="9">Semana del ciclo</text></svg></div><div class="chart-legend">${legend}</div><details class="chart-data"><summary>Ver mediciones y fechas</summary><ul>${list}</ul></details>` : `<div class="chart-empty"><span aria-hidden="true">⌁</span><p>La evolución aparecerá cuando haya mediciones.</p></div>`}
  </section>`;
}

function summaryView() {
  const cycle = activeCycle();
  if (!cycle) return emptySummary();
  const measurements = allCycleMeasurements(cycle.id);
  const latest = latestOf(measurements);
  const week = cycleWeek(cycle.startDate, todayLocalDate());
  const reference = latest && selectReference(measurements, latest, cycle, state.comparison);
  const type = typeLabel(cycle.type);
  const weekSixteen = week >= 16;
  const beyondCycle = week > cycle.plannedWeeks;
  const daysFromStart = daysBetween(cycle.startDate, todayLocalDate());
  const compareLabel = state.comparison === "start" ? "Inicio del ciclo" : `${state.comparison} ${Number(state.comparison) === 1 ? "semana" : "semanas"} antes`;
  return `<div class="page-stack">
    <section class="cycle-hero cycle-hero-link" data-action="open-cycle" data-cycle-id="${escapeHtml(cycle.id)}" role="button" tabindex="0" aria-label="Abrir los detalles del ciclo activo">
      <div class="cycle-hero-top"><span class="status-pill"><i></i> Ciclo activo</span><span class="cycle-type">${escapeHtml(type)}</span></div>
      <h1>Semana <span>${Math.min(cycle.plannedWeeks, Math.max(1, week))}</span><small> / ${cycle.plannedWeeks}</small></h1>
      <p>Desde ${escapeHtml(displayDate(cycle.startDate))} <span class="dot-separator">·</span> día ${Math.max(0, daysFromStart) + 1}</p>
      <div class="cycle-progress" role="progressbar" aria-label="Progreso del ciclo" aria-valuemin="0" aria-valuemax="16" aria-valuenow="${Math.min(16, Math.max(0, week))}"><span class="progress-${Math.min(16, Math.max(0, week))}"></span></div>
    </section>
    ${weekSixteen ? `<div class="week-alert"><span aria-hidden="true">✳</span><span>${beyondCycle ? "El período de 16 semanas ha terminado. Cierra este ciclo para empezar otro." : "Has llegado a la semana 16. Cierra este ciclo al terminar esta semana."}</span><button type="button" data-action="close-cycle" data-cycle-id="${escapeHtml(cycle.id)}">Cerrar</button></div>` : ""}
    <div class="action-line"><div><p class="eyebrow">TU SEGUIMIENTO</p><h2>Un registro cada vez.</h2></div><button class="button button-primary" type="button" data-action="new-measurement" data-cycle-id="${escapeHtml(cycle.id)}" ${beyondCycle ? "disabled" : ""}><span aria-hidden="true">＋</span> Registrar</button></div>
    <section class="latest-panel">
      <div class="panel-heading"><div><p class="eyebrow">MEDICIÓN MÁS RECIENTE</p><h2>${latest ? escapeHtml(displayDate(latest.date)) : "Todavía no hay mediciones"}</h2></div>${latest ? `<button class="text-button" type="button" data-action="edit-measurement" data-measurement-id="${escapeHtml(latest.id)}">Editar</button>` : ""}</div>
      ${readingSummary(latest)}
    </section>
    <section class="comparison-panel">
      <div class="panel-heading compare-heading"><div><p class="eyebrow">PUNTO DE REFERENCIA</p><h2>Comparar evolución</h2></div><label class="select-wrap"><span class="sr-only">Comparar con</span><select data-action="comparison">${comparisonOptions(cycle, latest || { date: cycle.startDate })}</select><span aria-hidden="true">⌄</span></label></div>
      ${latest ? `<p class="reference-caption">Ahora · ${escapeHtml(displayDate(latest.date))} <span>vs.</span> ${escapeHtml(reference ? `${compareLabel} · ${displayDate(reference.date)}` : compareLabel)}</p>${reference ? `<div class="comparison-rows">${["Weight", "Body Fat Percentage", "Lean Body Mass", "Resting Calories"].map(metric => metricDiffRow(metric, latest, reference)).join("")}</div>` : `<div class="soft-empty compact"><p>${state.comparison === "start" ? "Aún no existe una medición inicial." : "Sin medición para esta semana."}</p><span>No interpolamos ni rellenamos huecos.</span></div>`}` : `<div class="soft-empty compact"><p>La comparación aparecerá con tu primera medición.</p></div>`}
    </section>
    <div class="section-title"><div><p class="eyebrow">TENDENCIAS</p><h2>Lo que va cambiando</h2></div><span class="trend-note">Sin nota de aprobado</span></div>
    ${chartFor(cycle, ["Weight", "Lean Body Mass", "Body Fat Percentage"], "Peso y composición corporal", "Peso y masa libre de grasa en kg · grasa corporal en %")}
    ${chartFor(cycle, ["Resting Calories", "Steps"], "TMB y pasos", "TMB por registro · media de los días con dato por semana del ciclo")}
    ${chartFor(cycle, ["Waist", "Hips", "Flotadores"], "Medidas corporales", "Cintura, cadera y flotadores en la unidad elegida")}
  </div>`;
}

function cycleCard(cycle) {
  const measurements = allCycleMeasurements(cycle.id);
  const first = measurements.find(item => item.id === cycle.baselineMeasurementId) || measurements[0];
  const last = latestOf(measurements);
  const summaryMetric = first && last && effectiveObservation(first, "Weight") && effectiveObservation(last, "Weight");
  const weightDelta = summaryMetric ? difference(effectiveObservation(last, "Weight").value, effectiveObservation(first, "Weight").value) : null;
  const week = cycleWeek(cycle.startDate, cycle.closedAt || todayLocalDate());
  return `<div class="history-item"><button class="history-card ${cycle.status === "active" ? "history-active" : ""}" type="button" data-action="open-cycle" data-cycle-id="${escapeHtml(cycle.id)}">
    <span class="history-mark" aria-hidden="true">${cycle.status === "active" ? "◉" : "◷"}</span>
    <span class="history-main"><span class="history-title">${escapeHtml(typeLabel(cycle.type))} <i class="${cycle.status === "active" ? "status-pill-inline" : ""}">${cycle.status === "active" ? "Activo" : "Cerrado"}</i></span><span class="history-date">${escapeHtml(displayDate(cycle.startDate))}${cycle.closedAt ? ` — ${escapeHtml(displayDate(cycle.closedAt))}` : " — en curso"}</span><span class="history-meta">${measurements.length} ${measurements.length === 1 ? "medición" : "mediciones"} · semana ${week}</span></span>
    <span class="history-change">${weightDelta === null ? "—" : `${weightDelta > 0 ? "+" : "−"}${numberFormat.format(Math.abs(fromCanonical("Weight", weightDelta, snapshot.settings.units)))} ${displayUnit("Weight", snapshot.settings.units)}`}<small>${summaryMetric ? "cambio de peso" : "sin resumen"}</small></span>
    <span class="history-arrow" aria-hidden="true">↗</span>
  </button>${cycle.status === "completed" ? `<details class="item-menu"><summary aria-label="Más opciones del ciclo">•••</summary><div><button class="danger-menu-item" type="button" data-action="delete-cycle" data-cycle-id="${escapeHtml(cycle.id)}">Eliminar ciclo</button></div></details>` : ""}</div>`;
}

function cyclesView() {
  const active = snapshot.cycles.filter(cycle => cycle.status === "active");
  const closed = snapshot.cycles.filter(cycle => cycle.status !== "active").sort((a, b) => b.startDate.localeCompare(a.startDate));
  return `<div class="page-stack">
    <div class="page-title-row"><div><p class="eyebrow">TU HISTORIAL</p><h1>Ciclos</h1><p>Un registro continuo de cada etapa.</p></div>${!active.length ? `<button class="icon-button" type="button" data-action="new-cycle" aria-label="Crear ciclo">＋</button>` : ""}</div>
    ${active.length ? `<section class="cycle-list-section"><div class="section-label"><h2>En curso</h2><span>${active.length}</span></div>${active.map(cycleCard).join("")}</section>` : `<section class="soft-empty spacious"><span class="empty-glyph" aria-hidden="true">◌</span><h2>No hay ciclos activos</h2><p>Al empezar uno, podrás registrar mediciones y seguir su evolución desde aquí.</p><button class="button button-primary" type="button" data-action="new-cycle">Crear ciclo</button></section>`}
    <section class="cycle-list-section"><div class="section-label"><h2>Anteriormente</h2><span>${closed.length}</span></div>${closed.length ? closed.map(cycleCard).join("") : `<p class="empty-caption">Tus ciclos completados aparecerán aquí.</p>`}</section>
  </div>`;
}

function fieldValue(measurement, metric, draft = null) {
  if (draft && Object.prototype.hasOwnProperty.call(draft.values, metric.id)) return draft.values[metric.id];
  const observation = measurement && effectiveObservation(measurement, metric.id);
  if (!observation) return "";
  return numberFormat.format(fromCanonical(metric.id, observation.value, snapshot.settings.units));
}

function incomingObservation(draft, metricId) {
  return draft && (draft.healthObservations || []).find(observation => observation.metric === metricId) || null;
}

function hasDraftManualValue(draft, metricId) {
  if (!draft) return false;
  const value = draft.values[metricId];
  return value != null && String(value).trim() !== "" && draft.prefilledValues[metricId] !== String(value);
}

function draftHasConflict(draft, metricId) {
  const incoming = incomingObservation(draft, metricId);
  if (!incoming || !hasDraftManualValue(draft, metricId)) return false;
  const parsed = parseLocaleNumber(draft.values[metricId]);
  const metric = metricById(metricId);
  if (parsed === null || !metric) return false;
  const canonical = toCanonical(metricId, parsed, displayUnit(metricId, snapshot.settings.units), snapshot.settings.units);
  return Math.abs(canonical - incoming.value) > 1e-7;
}

function measurementFields(measurement = null, draft = null) {
  const groups = [
    { title: "Composición corporal", description: "Puedes dejar cualquier campo vacío.", metrics: ["Weight", "Body Fat Percentage", "Lean Body Mass"] },
    { title: "Medidas", description: "Mide siempre en el mismo punto para comparar tendencias.", metrics: ["Waist", "Hips", "Flotadores"] },
    { title: "Actividad", description: "Media de pasos diarios de los siete días hasta la fecha del registro.", metrics: ["Steps"] },
    { title: "Metabolismo", description: "Añade la energía en reposo y el IMC si están disponibles.", metrics: ["Resting Calories", "Body Mass Index"] }
  ];
  return groups.map((group, groupIndex) => `<fieldset class="measurement-group"><legend>${escapeHtml(group.title)}</legend><p class="group-hint">${escapeHtml(group.description)}</p><div class="field-grid">${group.metrics.map(id => {
    const metric = metricById(id);
    const conflict = isObservationConflict(observationValues(measurement, id)) || draftHasConflict(draft, id);
    const incoming = incomingObservation(draft, id);
    let hint = measurement ? conflict ? "Hay valores de más de un origen" : sourceHint(measurement, id) : "";
    if (incoming) {
      if (draftHasConflict(draft, id)) hint = `Manual y Apple Health difieren · ${escapeHtml(incoming.sourceName || "Atajo")}: ${escapeHtml(valueWithUnit(id, incoming.value))}`;
      else if (hasDraftManualValue(draft, id)) hint = `Manual + Apple Health · ${escapeHtml(incoming.sourceName || "Atajo")}`;
      else hint = `Apple Health · ${escapeHtml(incoming.sourceName || "Atajo")}`;
    } else if (!measurement && draft && String(draft.values[id] || "").trim()) hint = "Registro manual";
    return `<label class="field ${conflict ? "field-conflict" : ""}"><span>${escapeHtml(metric.label)} <small>${escapeHtml(displayUnit(metric.id, snapshot.settings.units))}</small></span><input type="text" inputmode="decimal" autocomplete="off" name="${escapeHtml(metric.id)}" value="${escapeHtml(fieldValue(measurement, metric, draft))}" placeholder="—" aria-describedby="hint-${groupIndex}-${escapeHtml(metric.id)}"><small id="hint-${groupIndex}-${escapeHtml(metric.id)}" class="field-source">${hint}</small></label>`;
  }).join("")}</div></fieldset>`).join("");
}

function shortcutImportPreview(draft) {
  if (!draft || !draft.healthObservations || !draft.healthObservations.length) return "";
  const lines = draft.healthObservations.map(observation => {
    const metric = metricById(observation.metric);
    const label = metric ? metric.label : observation.metric;
    return `<li><span>${escapeHtml(label)}${draftHasConflict(draft, observation.metric) ? " · discrepancia con entrada manual" : ""}</span><strong>${escapeHtml(valueWithUnit(observation.metric, observation.value))}</strong></li>`;
  }).join("");
  const ignored = draft.ignoredMetrics.length ? `<p class="small-warning">Se omiten métricas no incluidas: ${escapeHtml(draft.ignoredMetrics.join(", "))}.</p>` : "";
  return `<section class="shortcut-import-preview" aria-live="polite"><div><strong>Datos recibidos del atajo</strong><span>${escapeHtml(displayDate(draft.importedDate))} · revisa antes de guardar</span></div><ul>${lines}</ul><p>Los valores manuales se conservan. Las discrepancias se guardarán con ambos orígenes para que puedas resolverlas.</p>${ignored}<button class="text-button" type="button" data-action="discard-shortcut-import">Quitar datos importados</button></section>`;
}

function shortcutButtonMarkup(draft = null) {
  const canImport = draft && !(draft.healthObservations || []).length;
  return `<div class="shortcut-launch"><button class="button button-secondary" type="button" data-action="launch-health-shortcut">♡ Obtener valores de Apple Health</button>${canImport && !state.remoteConnected ? `<button class="button button-secondary" type="button" data-action="import-health-file">Importar archivo de Atajos</button><input id="shortcut-health-file" type="file" hidden>` : ""}<p>${state.remoteConnected ? "El Atajo enviará el JSON al backend. Al volver, se cargarán los valores en este formulario." : canImport ? "Al volver a Health Tracker, selecciona el JSON que Atajos guardó en Archivos." : "Se abrirá Atajos; al terminar, vuelve aquí para revisar los datos."}</p></div>`;
}

function sourceHint(measurement, metricId) {
  const observation = effectiveObservation(measurement, metricId);
  if (!observation) return "";
  if (observation.source === "apple_health") return `Importado · ${escapeHtml(observation.sourceName || "Apple Health")}`;
  return observation.source === "manual" ? "Registro manual" : escapeHtml(observation.source);
}

function conflictMarkup(measurement) {
  if (!measurement) return "";
  const rows = Object.entries(measurement.observations).filter(([, observations]) => isObservationConflict(observations));
  if (!rows.length) return "";
  return `<section class="conflict-box" aria-labelledby="conflict-title"><div><p class="eyebrow">REVISIÓN NECESARIA</p><h3 id="conflict-title">Hay valores distintos para la misma medición</h3><p>Conservamos ambos orígenes. Elige cuál usar para los cálculos.</p></div>${rows.map(([metricId, observations]) => {
    const metric = metricById(metricId);
    return `<div class="conflict-metric"><strong>${escapeHtml(metric ? metric.label : metricId)}</strong>${observations.map(observation => `<button type="button" class="source-choice ${measurement.resolutions && measurement.resolutions[metricId] === observation.id ? "source-selected" : ""}" data-action="resolve-conflict" data-measurement-id="${escapeHtml(measurement.id)}" data-metric="${escapeHtml(metricId)}" data-observation-id="${escapeHtml(observation.id)}"><span>${escapeHtml(observation.sourceName || (observation.source === "manual" ? "Manual" : observation.source))}</span><b>${escapeHtml(valueWithUnit(metricId, observation.value))}</b></button>`).join("")}</div>`;
  }).join("")}</section>`;
}

function createCycleView() {
  const draft = state.pendingShortcutDraft && state.pendingShortcutDraft.view === "create-cycle" ? state.pendingShortcutDraft : null;
  const type = draft && draft.type || "deficit";
  const startDate = draft && draft.startDate || todayLocalDate();
  const measurementDate = draft && draft.requestedDate || todayLocalDate();
  return `<div class="page-stack form-page">
    <button class="back-button" type="button" data-action="navigate" data-view="cycles">← <span>Ciclos</span></button>
    <div class="page-title-row"><div><p class="eyebrow">EMPEZAR UNA ETAPA</p><h1>Nuevo ciclo</h1><p>Un ciclo a la vez, sin objetivos impuestos.</p></div><span class="step-mark">01</span></div>
    <form id="create-cycle-form" class="form-card">
      <section class="form-section"><h2>El ciclo</h2>
        <label class="select-field"><span>Tipo de ciclo</span><select name="type" required>${CYCLE_TYPES.map(item => `<option value="${item.id}" ${item.id === type ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select></label>
        <label class="select-field"><span>Fecha de inicio</span><input type="date" name="startDate" value="${escapeHtml(startDate)}" max="${todayLocalDate()}" required><small>Las semanas se cuentan desde esta fecha, aunque el ciclo empezara antes de usar la aplicación.</small></label>
      </section>
      <section class="form-section"><div class="form-heading"><div><h2>Medición inicial</h2><p>Será tu referencia para comparar la evolución. Añade al menos un dato para continuar.</p></div><span class="step-mark soft">02</span></div>
        <label class="select-field date-field"><span>Fecha real de la medición</span><input type="date" name="measurementDate" value="${escapeHtml(measurementDate)}" max="${todayLocalDate()}" required><small>Por defecto coincide con el inicio; puedes indicar otra fecha.</small></label>
        ${shortcutButtonMarkup(draft)}
        ${shortcutImportPreview(draft)}
        ${measurementFields(null, draft)}
      </section>
    <div class="form-footer"><p>Duración máxima: <strong>16 semanas</strong>. Cierra el ciclo para empezar otro.</p><button class="button button-primary button-wide" type="submit">Crear ciclo y guardar medición <span aria-hidden="true">↗</span></button><button class="text-button cancel-form" type="button" data-action="cancel-form">Cancelar</button></div>
    </form>
  </div>`;
}

function measurementFormView() {
  const cycle = snapshot.cycles.find(item => item.id === state.cycleId) || activeCycle();
  if (!cycle) return `<section class="soft-empty spacious"><h2>No hay un ciclo activo</h2><button class="button button-primary" data-action="new-cycle">Crear ciclo</button></section>`;
  const measurement = snapshot.measurements.find(item => item.id === state.measurementId) || null;
  const measurementId = measurement ? measurement.id : "";
  const draft = state.pendingShortcutDraft && state.pendingShortcutDraft.view === "measurement-form" ? state.pendingShortcutDraft : null;
  const measurementDate = draft && draft.requestedDate || (measurement ? measurement.date : todayLocalDate());
  const isEdit = Boolean(measurement);
  const minDate = cycle.startDate;
  const maxDate = cycle.status === "completed" ? cycle.closedAt : todayLocalDate();
  return `<div class="page-stack form-page">
    <button class="back-button" type="button" data-action="open-cycle" data-cycle-id="${escapeHtml(cycle.id)}">← <span>${escapeHtml(typeLabel(cycle.type))}</span></button>
    <div class="page-title-row"><div><p class="eyebrow">${isEdit ? "ACTUALIZAR REGISTRO" : "UNA NUEVA OBSERVACIÓN"}</p><h1>${isEdit ? "Editar medición" : "Registrar medición"}</h1><p>Semana ${isEdit ? cycleWeek(cycle.startDate, measurement.date) : cycleWeek(cycle.startDate, todayLocalDate())} del ciclo · los campos son opcionales.</p></div></div>
    ${conflictMarkup(measurement)}
    <form id="measurement-form" class="form-card" data-cycle-id="${escapeHtml(cycle.id)}" data-measurement-id="${escapeHtml(measurementId)}">
      <section class="form-section"><label class="select-field date-field"><span>Fecha real de la medición</span><input type="date" name="date" value="${escapeHtml(measurementDate)}" min="${escapeHtml(minDate)}" max="${escapeHtml(maxDate)}" required><small>La fecha no cambia la semana prevista del ciclo.</small></label>${shortcutButtonMarkup(draft)}${shortcutImportPreview(draft)}${measurementFields(measurement, draft)}</section>
      <div class="form-footer"><p>Los valores manuales conservan su origen. Dejar un campo vacío mantiene el valor anterior.</p><button class="button button-primary button-wide" type="submit">${isEdit ? "Guardar cambios" : "Guardar medición"} <span aria-hidden="true">↗</span></button><button class="text-button cancel-form" type="button" data-action="cancel-form">Cancelar</button></div>
    </form>
  </div>`;
}

function detailView() {
  const cycle = currentCycle();
  if (!cycle) return cyclesView();
  const measurements = allCycleMeasurements(cycle.id);
  const latest = latestOf(measurements);
  const reference = latest && selectReference(measurements, latest, cycle, state.comparison);
  return `<div class="page-stack">
    <button class="back-button" type="button" data-action="navigate" data-view="cycles">← <span>Todos los ciclos</span></button>
    <section class="detail-hero ${cycle.status === "active" ? "" : "is-closed"}"><div class="cycle-hero-top"><span class="status-pill ${cycle.status === "active" ? "" : "status-complete"}"><i></i>${cycle.status === "active" ? "Ciclo activo" : "Ciclo cerrado"}</span><span class="cycle-type">${escapeHtml(typeLabel(cycle.type))}</span></div><h1>${escapeHtml(typeLabel(cycle.type))}</h1><p>${escapeHtml(displayDate(cycle.startDate))}${cycle.closedAt ? ` — ${escapeHtml(displayDate(cycle.closedAt))}` : ` · Semana ${cycleWeek(cycle.startDate, todayLocalDate())}`}</p>${cycle.status === "active" ? `<div class="detail-actions"><button class="button button-primary" data-action="new-measurement" data-cycle-id="${escapeHtml(cycle.id)}">＋ Registrar medición</button><button class="text-button" data-action="close-cycle" data-cycle-id="${escapeHtml(cycle.id)}">Cerrar ciclo</button></div>` : ""}</section>
    <section class="comparison-panel"><div class="panel-heading compare-heading"><div><p class="eyebrow">COMPARACIÓN</p><h2>Una referencia real</h2></div><label class="select-wrap"><span class="sr-only">Comparar con</span><select data-action="comparison">${comparisonOptions(cycle, latest || { date: cycle.startDate })}</select><span aria-hidden="true">⌄</span></label></div>${latest && reference ? `<p class="reference-caption">${displayDate(latest.date)} vs. ${displayDate(reference.date)}</p><div class="comparison-rows">${["Weight", "Body Fat Percentage", "Lean Body Mass", "Resting Calories"].map(metric => metricDiffRow(metric, latest, reference)).join("")}</div>` : `<div class="soft-empty compact"><p>${latest ? state.comparison === "start" ? "No hay medición inicial." : "Sin medición para esta semana." : "Este ciclo todavía no tiene mediciones."}</p></div>`}</section>
    ${chartFor(cycle, ["Weight", "Lean Body Mass", "Body Fat Percentage"], "Peso y composición corporal", "Peso y masa libre de grasa en kg · grasa corporal en %")}
    ${chartFor(cycle, ["Resting Calories", "Steps"], "TMB y pasos", "TMB por registro · media de los días con dato por semana del ciclo")}
    ${chartFor(cycle, ["Waist", "Hips", "Flotadores"], "Medidas corporales", "Cintura, cadera y flotadores en la unidad elegida")}
    <section class="timeline-section"><div class="section-title"><div><p class="eyebrow">REGISTROS</p><h2>Mediciones</h2></div><span class="chart-count">${measurements.length}</span></div>
      ${measurements.length ? `<ol class="measurement-timeline">${measurements.slice().reverse().map(measurement => {
        const week = cycleWeek(cycle.startDate, measurement.date);
        const weight = effectiveObservation(measurement, "Weight");
        const conflicts = Object.entries(measurement.observations).filter(([, items]) => isObservationConflict(items));
        const metricCount = Object.values(measurement.observations).filter(items => Array.isArray(items) && items.length).length;
        return `<li><span class="timeline-point ${conflicts.length ? "has-conflict" : ""}"></span><button type="button" class="timeline-entry" data-action="edit-measurement" data-measurement-id="${escapeHtml(measurement.id)}"><span class="timeline-date">${escapeHtml(displayDate(measurement.date))}<i>Semana ${week}</i></span><strong>${weight ? escapeHtml(valueWithUnit("Weight", weight.value)) : "Sin peso"}</strong><small>${metricCount} métricas${conflicts.length ? " · revisar discrepancia" : ""}</small></button><details class="item-menu measurement-menu"><summary aria-label="Más opciones de la medición">•••</summary><div><button class="danger-menu-item" type="button" data-action="delete-measurement" data-measurement-id="${escapeHtml(measurement.id)}">Eliminar medición</button></div></details></li>`;
      }).join("")}</ol>` : `<div class="soft-empty compact"><p>No hay mediciones en este ciclo.</p></div>`}
    </section>
  </div>`;
}

function settingsView() {
  const remote = readRemoteConfig();
  return `<div class="page-stack">
    <div class="page-title-row"><div><p class="eyebrow">PREFERENCIAS</p><h1>Ajustes</h1><p>Tu experiencia, a tu manera.</p></div></div>
    <section class="settings-card"><div class="settings-icon" aria-hidden="true">↔</div><div class="settings-copy"><h2>Unidades</h2><p>Elige cómo ver tus medidas. Tus datos guardados no cambian.</p><label class="settings-select"><span class="sr-only">Sistema de unidades</span><select id="units-setting"><option value="metric" ${snapshot.settings.units === "metric" ? "selected" : ""}>Métrico · kg, cm</option><option value="imperial" ${snapshot.settings.units === "imperial" ? "selected" : ""}>Anglosajón · lb, in</option></select></label></div></section>
    <section class="settings-card"><div class="settings-icon health-icon" aria-hidden="true">♡</div><div class="settings-copy"><p class="eyebrow">PUENTE MANUAL</p><h2>Apple Health</h2><p>El Atajo envía los valores a Cloudflare. Vuelve a Health Tracker desde el selector de apps; el formulario espera y recibe la respuesta automáticamente.</p><div class="shortcut-name">health-care - Apple Health</div><ul class="settings-steps"><li>Configura la URL del backend y el token aquí.</li><li>En el Atajo, usa <b>Obtener contenido de URL</b> con método POST a <code>/api/import</code>, cabecera <code>Authorization: Bearer …</code> y cuerpo JSON con <code>date</code> y <code>data</code>.</li><li>Deja esa acción al final del envío. Al volver a Health Tracker desde el selector de apps, la app espera la importación automáticamente.</li></ul></div></section>
    <section class="settings-card backend-card"><div class="settings-icon" aria-hidden="true">↗</div><div class="settings-copy"><h2>Backend privado</h2><p>El endpoint y token se guardan solo en este navegador. Configura el mismo token como secreto de Cloudflare y en la cabecera del Atajo.</p><form id="backend-config-form" class="backend-config-form"><label><span>URL del Worker</span><input name="endpoint" type="url" inputmode="url" placeholder="https://healt-tracker.…workers.dev" value="${escapeHtml(remote && remote.endpoint || "")}" required></label><label><span>Token de acceso</span><input name="token" type="password" autocomplete="new-password" placeholder="${remote ? "Configurado; déjalo vacío para conservarlo" : "Pega el token que configurarás en Cloudflare"}" ${remote ? "" : "required"}></label><button class="button button-primary" type="submit">${remote ? "Guardar conexión" : "Conectar backend"}</button><small>El nivel gratuito tiene cuotas. No se activa ningún plan de pago desde la aplicación.</small></form></div></section>
    <section class="settings-card"><div class="settings-icon" aria-hidden="true">↓</div><div class="settings-copy"><h2>Exportar tus datos</h2><p>Descarga una copia JSON con tus ciclos, observaciones y preferencias.</p><button class="button button-secondary" type="button" data-action="export">Descargar copia</button></div></section>
    <section class="settings-card danger-card"><div class="settings-icon" aria-hidden="true">⌫</div><div class="settings-copy"><h2>Eliminar todos los datos</h2><p>${state.remoteConnected ? "Borra todos los ciclos, mediciones y preferencias del backend y de este navegador. No se puede deshacer." : "Borra ciclos, mediciones y preferencias de este navegador. No se puede deshacer."}</p><button class="button button-danger" type="button" data-action="delete-all">Eliminar datos</button></div></section>
    <p class="privacy-footer">${state.remoteConnected ? "Con backend conectado, tus mediciones se envían a Cloudflare D1 y se mantienen también en este navegador. Sin backend, permanecen solo localmente." : "Sin backend conectado, tus mediciones permanecen solo en este navegador. Configurar el backend las sincronizará de forma privada."} La conexión no usa analítica ni rastreadores.</p>
  </div>`;
}

function render() {
  app.querySelectorAll(".chart-wrap[data-chart-id]").forEach(element => {
    state.chartScroll[element.dataset.chartId] = element.scrollLeft;
  });
  const content = state.view === "summary" ? summaryView()
    : state.view === "cycles" ? cyclesView()
      : state.view === "settings" ? settingsView()
        : state.view === "create-cycle" ? createCycleView()
          : state.view === "measurement-form" ? measurementFormView()
            : state.view === "cycle-detail" ? detailView() : summaryView();
  app.innerHTML = shell(content);
  app.querySelectorAll(".chart-wrap[data-chart-id]").forEach(element => {
    const saved = state.chartScroll[element.dataset.chartId];
    if (saved != null) element.scrollLeft = saved;
    else {
      const currentWeek = Number(element.dataset.currentWeek) || 1;
      element.scrollLeft = Math.max(0, (currentWeek * 58) - element.clientWidth + 64);
    }
  });
  if (state.toast && state.toastKind !== "error") {
    window.clearTimeout(render.toastTimer);
    render.toastTimer = window.setTimeout(() => { state.toast = null; render(); }, 5500);
  }
}

async function reloadState() {
  snapshot = await repository.getState();
}

function navigate(view) {
  state.view = view;
  state.toast = null;
  if (view === "summary") state.cycleId = null;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function formEntries(form) {
  const values = {};
  for (const metric of METRICS) {
    const control = form.elements.namedItem(metric.id);
    if (control) values[metric.id] = control.value;
  }
  return values;
}

function readStoredShortcutDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(SHORTCUT_DRAFT_STORAGE_KEY) || "null");
    if (!isShortcutDraftFresh(draft)) {
      localStorage.removeItem(SHORTCUT_DRAFT_STORAGE_KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

function saveStoredShortcutDraft(draft) {
  try {
    localStorage.setItem(SHORTCUT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    state.pendingShortcutDraft = draft;
    return true;
  } catch {
    setToast("No se pudo conservar este formulario para abrir Atajos. Guarda los datos antes de continuar.", "error");
    updateToastInPlace();
    return false;
  }
}

function clearStoredShortcutDraft() {
  try { localStorage.removeItem(SHORTCUT_DRAFT_STORAGE_KEY); } catch { /* local storage can be unavailable */ }
  state.pendingShortcutDraft = null;
  stopPendingImportWait();
}

function restoreShortcutDraft() {
  const draft = readStoredShortcutDraft();
  if (!draft) return;
  state.pendingShortcutDraft = draft;
  state.view = draft.view;
  state.cycleId = draft.cycleId;
  state.measurementId = draft.measurementId;
  if (!draft.healthObservations || !draft.healthObservations.length) setToast("Borrador restaurado. No se han recibido datos todavía; puedes continuar manualmente o volver a abrir Atajos.", "warning");
}

function launchAppleHealthFromForm(form) {
  const formData = new FormData(form);
  const createCycle = form.id === "create-cycle-form";
  const date = String(formData.get(createCycle ? "measurementDate" : "date") || "");
  const draft = createShortcutDraft({
    view: createCycle ? "create-cycle" : "measurement-form",
    cycleId: createCycle ? null : form.dataset.cycleId,
    measurementId: createCycle ? null : form.dataset.measurementId || null,
    date,
    values: formEntries(form),
    type: createCycle ? String(formData.get("type") || "deficit") : null,
    startDate: createCycle ? String(formData.get("startDate") || "") : null
  });
  if (!saveStoredShortcutDraft(draft)) return;
  stopPendingImportWait();
  render();
  window.location.href = buildAppleHealthShortcutUrl(date);
}

async function importShortcutFile(file) {
  const draft = state.pendingShortcutDraft || readStoredShortcutDraft();
  if (!draft) throw new Error("No hay un formulario pendiente. Abre Apple Health desde el formulario que quieres rellenar.");
  if (!file) return;
  const text = await file.text();
  if (!text.trim()) throw new Error("El archivo está vacío. Comprueba que Atajos guardó el JSON generado.");
  const imported = parseHealthData(text);
  const updatedDraft = attachShortcutImport(draft, imported, snapshot.settings.units);
  state.pendingShortcutDraft = updatedDraft;
  state.view = updatedDraft.view;
  state.cycleId = updatedDraft.cycleId;
  state.measurementId = updatedDraft.measurementId;
  saveStoredShortcutDraft(updatedDraft);
  setToast(`${imported.observations.length} valor(es) listos para revisar. Todavía no se han guardado.`);
  render();
}

function importedObservationsForMeasurement(measurement, draft) {
  const result = { ...measurement, observations: { ...measurement.observations } };
  for (const observation of draft && draft.healthObservations || []) {
    const values = result.observations[observation.metric] || (result.observations[observation.metric] = []);
    if (observation.fingerprint && values.some(item => item.fingerprint === observation.fingerprint)) continue;
    values.push(observation);
  }
  return result;
}

function manualEntriesForForm(form, draft) {
  const entries = formEntries(form);
  return draft ? manualEntriesFromDraft(entries, draft.prefilledValues || {}) : entries;
}

function appendManualValues(measurement, entries, system) {
  if (!Object.values(entries).some(value => value != null && String(value).trim() !== "")) return measurement;
  return setManualObservations(measurement, entries, system);
}

function updateDraftFromCurrentForm(form, draft) {
  const createCycle = form.id === "create-cycle-form";
  draft.values = formEntries(form);
  draft.requestedDate = String(new FormData(form).get(createCycle ? "measurementDate" : "date") || draft.requestedDate);
  if (createCycle) {
    draft.type = String(new FormData(form).get("type") || draft.type);
    draft.startDate = String(new FormData(form).get("startDate") || draft.startDate);
  }
  return draft;
}

async function handleCreateCycle(form) {
  const formData = new FormData(form);
  const startDate = String(formData.get("startDate") || "");
  const measurementDate = String(formData.get("measurementDate") || "");
  if (!isValidDateOnly(startDate) || !isValidDateOnly(measurementDate)) throw new Error("Introduce fechas válidas.");
  if (startDate > todayLocalDate() || measurementDate > todayLocalDate()) throw new Error("Las fechas del ciclo no pueden estar en el futuro.");
  if (measurementDate < startDate) throw new Error("La medición inicial no puede ser anterior al inicio del ciclo.");
  const draft = state.pendingShortcutDraft && state.pendingShortcutDraft.view === "create-cycle" ? state.pendingShortcutDraft : null;
  if (draft && draft.healthObservations.length && draft.importedDate !== measurementDate) throw new Error("La fecha debe coincidir con la fecha de los datos importados. Quita los datos o restaura su fecha para continuar.");
  const manualObservations = makeManualBaselineObservations(manualEntriesForForm(form, draft), snapshot.settings.units);
  const observations = [...(draft ? draft.healthObservations : []), ...manualObservations];
  const { cycle, measurement } = createCycleRecord({ type: String(formData.get("type")), startDate, baselineDate: measurementDate, baselineObservations: observations });
  await repository.createCycleWithBaseline(cycle, measurement);
  if (repository.pendingImport) await repository.clearPendingImport();
  await reloadState();
  state.cycleId = cycle.id;
  state.view = "summary";
  clearStoredShortcutDraft();
  setToast("Ciclo creado. Tu medición inicial ya está guardada.");
  render();
}

async function handleMeasurementSave(form) {
  const cycleId = form.dataset.cycleId;
  const cycle = snapshot.cycles.find(item => item.id === cycleId);
  if (!cycle) throw new Error("No se encontró el ciclo asociado.");
  const date = String(new FormData(form).get("date") || "");
  if (!isValidDateOnly(date) || date < cycle.startDate || date > todayLocalDate() || (cycle.closedAt && date > cycle.closedAt)) throw new Error("La fecha debe estar dentro del ciclo y no puede ser futura.");
  if (cycleWeek(cycle.startDate, date) > cycle.plannedWeeks) throw new Error("El ciclo dura como máximo 16 semanas. Cierra este ciclo antes de registrar otra medición.");
  const draft = state.pendingShortcutDraft && state.pendingShortcutDraft.view === "measurement-form" ? state.pendingShortcutDraft : null;
  if (draft && draft.healthObservations.length && draft.importedDate !== date) throw new Error("La fecha debe coincidir con la fecha de los datos importados. Quita los datos o restaura su fecha para continuar.");
  const measurementId = form.dataset.measurementId;
  const existing = snapshot.measurements.find(item => item.id === measurementId) || null;
  const collision = snapshot.measurements.find(item => item.cycleId === cycleId && item.date === date && item.id !== measurementId);
  if (collision) throw new Error("Ya existe una medición para esa fecha. Edítala para mantener un solo registro diario.");
  let measurement = existing
    ? { ...existing, date, observations: { ...existing.observations }, resolutions: { ...existing.resolutions } }
    : createMeasurement(cycleId, date, draft ? draft.healthObservations : []);
  if (existing && draft) measurement = importedObservationsForMeasurement(measurement, draft);
  measurement = appendManualValues(measurement, manualEntriesForForm(form, draft), snapshot.settings.units);
  if (!Object.values(measurement.observations).some(items => items.length)) throw new Error("Añade al menos un valor a la medición.");
  await repository.saveMeasurement(measurement);
  if (repository.pendingImport) await repository.clearPendingImport();
  await reloadState();
  state.cycleId = cycleId;
  state.view = "cycle-detail";
  clearStoredShortcutDraft();
  setToast(existing ? "Cambios guardados." : "Medición guardada.");
  render();
}

async function handleImportCallback() {
  let imported;
  try {
    imported = parseHealthDataParam(window.location.search);
    if (imported.status === "absent") return;
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    const pendingDraft = readStoredShortcutDraft();
    if (pendingDraft) {
      const updatedDraft = attachShortcutImport(pendingDraft, imported, snapshot.settings.units);
      state.pendingShortcutDraft = updatedDraft;
      state.view = updatedDraft.view;
      state.cycleId = updatedDraft.cycleId;
      state.measurementId = updatedDraft.measurementId;
      saveStoredShortcutDraft(updatedDraft);
      setToast(`${imported.observations.length} valor(es) listos para revisar. Todavía no se han guardado.`);
      return;
    }
    const metricNames = imported.observations.map(observation => { const metric = metricById(observation.metric); return metric ? metric.label : observation.metric; }).join(", ");
    if (!window.confirm(`Se han recibido datos para ${displayDate(imported.date)} (${metricNames}). El enlace no demuestra por sí solo que el origen sea Apple Health. ¿Quieres guardarlos en este dispositivo?`)) {
      setToast("Importación cancelada. No se guardaron los datos recibidos.", "warning");
      return;
    }
    const result = await repository.importHealthData(imported);
    await reloadState();
    state.view = "summary";
    state.cycleId = result.cycle.id;
    const count = result.added;
    const skipped = imported.ignored.length ? ` Se omitieron ${imported.ignored.length} métricas no incluidas en esta versión.` : "";
    const duplicate = result.duplicates ? ` ${result.duplicates} valor(es) ya estaban importados.` : "";
    const conflict = result.conflicts.length ? ` Revisa las discrepancias en la medición: ${result.conflicts.map(id => { const metric = metricById(id); return metric ? metric.label : id; }).join(", ")}.` : "";
    setToast(count ? `${count} dato(s) importado(s) para ${displayDate(imported.date)}.${duplicate}${skipped}${conflict}` : `No había datos nuevos para ${displayDate(imported.date)}.${duplicate}${conflict}`, result.conflicts.length ? "warning" : "success");
  } catch (error) {
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    restoreShortcutDraft();
    setToast(error.message || "No se pudo importar Apple Health.", "error");
  }
}

async function exportData() {
  await reloadState();
  const content = JSON.stringify(makeExport(snapshot), null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `health-tracker-${todayLocalDate()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setToast("Copia descargada en este dispositivo.");
  render();
}

app.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button || state.busy) return;
  const action = button.dataset.action;
  try {
    if (action === "navigate") return navigate(button.dataset.view);
    if (action === "launch-health-shortcut") {
      const form = button.closest("form");
      if (!form || !["create-cycle-form", "measurement-form"].includes(form.id)) throw new Error("Abre la importación desde un formulario de medición.");
      launchAppleHealthFromForm(form);
      return;
    }
    if (action === "import-health-file") {
      const container = button.closest(".shortcut-launch");
      const input = container && container.querySelector("#shortcut-health-file");
      if (!input) throw new Error("No se encontró el selector del archivo JSON.");
      input.click();
      return;
    }
    if (action === "discard-shortcut-import") {
      const form = button.closest("form");
      let draft = state.pendingShortcutDraft;
      if (!form || !draft) return;
      draft = updateDraftFromCurrentForm(form, draft);
      for (const [metricId, importedText] of Object.entries(draft.prefilledValues || {})) {
        if (String(draft.values[metricId] == null ? "" : draft.values[metricId]) === String(importedText)) delete draft.values[metricId];
      }
      draft.prefilledValues = {};
      draft.healthObservations = [];
      draft.ignoredMetrics = [];
      delete draft.importedDate;
      saveStoredShortcutDraft(draft);
      if (repository.pendingImport) await repository.clearPendingImport();
      setToast("Se quitaron los datos importados. Tus entradas manuales siguen en el formulario.", "info");
      render();
      return;
    }
    if (action === "cancel-form") {
      const form = button.closest("form");
      if (!form) return;
      const draft = state.pendingShortcutDraft;
      const hasImportedValues = Boolean(draft && (draft.healthObservations || []).length);
      if (hasImportedValues && !window.confirm("Se descartarán los valores recibidos del Atajo y los cambios de este formulario. ¿Cancelar la medición?")) return;
      if (repository.pendingImport) await repository.clearPendingImport();
      const isCreateCycle = form.id === "create-cycle-form";
      clearStoredShortcutDraft();
      state.measurementId = null;
      state.view = isCreateCycle ? "cycles" : "cycle-detail";
      setToast(hasImportedValues ? "Medición cancelada. Los valores importados se descartaron." : "Formulario cancelado.", "info");
      render();
      return;
    }
    if (action === "new-cycle") { clearStoredShortcutDraft(); state.view = "create-cycle"; state.toast = null; render(); return; }
    if (action === "new-measurement") { clearStoredShortcutDraft(); state.cycleId = button.dataset.cycleId; state.measurementId = null; state.view = "measurement-form"; render(); return; }
    if (action === "edit-measurement") { state.measurementId = button.dataset.measurementId; const item = snapshot.measurements.find(value => value.id === state.measurementId); state.cycleId = item ? item.cycleId : null; state.view = "measurement-form"; render(); return; }
    if (action === "open-cycle") { state.cycleId = button.dataset.cycleId; state.view = "cycle-detail"; state.toast = null; render(); return; }
    if (action === "close-cycle") {
      if (!window.confirm("¿Cerrar este ciclo? Permanecerá en el historial con sus mediciones.")) return;
      await repository.closeCycle(button.dataset.cycleId);
      await reloadState();
      state.view = "cycle-detail";
      state.cycleId = button.dataset.cycleId;
      setToast("Ciclo cerrado y guardado en el historial.");
      render();
      return;
    }
    if (action === "delete-cycle") {
      const cycle = snapshot.cycles.find(item => item.id === button.dataset.cycleId);
      if (!cycle || cycle.status === "active") throw new Error("Solo se pueden eliminar ciclos cerrados.");
      if (!window.confirm("Se eliminará este ciclo cerrado y todas sus mediciones. No se puede deshacer. ¿Continuar?")) return;
      await repository.deleteCycle(cycle.id);
      await reloadState();
      state.cycleId = null;
      state.view = "cycles";
      setToast("Ciclo cerrado y sus mediciones eliminados.");
      render();
      return;
    }
    if (action === "delete-measurement") {
      const measurement = snapshot.measurements.find(item => item.id === button.dataset.measurementId);
      if (!measurement) throw new Error("No se encontró la medición.");
      const cycleMeasurements = allCycleMeasurements(measurement.cycleId);
      const isBaseline = snapshot.cycles.find(item => item.id === measurement.cycleId)?.baselineMeasurementId === measurement.id;
      const detail = cycleMeasurements.length === 1
        ? "El ciclo se quedará sin mediciones iniciales. El siguiente registro será la nueva referencia."
        : isBaseline ? "Es la referencia inicial; el registro más antiguo que quede pasará a ser el inicio del ciclo." : "";
      if (!window.confirm(`¿Eliminar la medición del ${displayDate(measurement.date)}? ${detail} Esta acción no se puede deshacer.`)) return;
      await repository.deleteMeasurement(measurement.id);
      await reloadState();
      state.cycleId = measurement.cycleId;
      state.view = "cycle-detail";
      setToast(isBaseline ? "Medición eliminada y referencia inicial actualizada." : "Medición eliminada.");
      render();
      return;
    }
    if (action === "focus-series") {
      const chartId = button.dataset.chartId;
      const seriesId = button.dataset.seriesId;
      const selected = new Set(state.chartFocus[chartId] || []);
      if (selected.has(seriesId)) selected.delete(seriesId);
      else selected.add(seriesId);
      state.chartFocus[chartId] = [...selected];
      render();
      return;
    }
    if (action === "resolve-conflict") {
      const measurement = snapshot.measurements.find(item => item.id === button.dataset.measurementId);
      if (!measurement) throw new Error("No se encontró la medición.");
      await repository.saveMeasurement(resolveObservation(measurement, button.dataset.metric, button.dataset.observationId));
      await reloadState();
      state.measurementId = measurement.id;
      state.cycleId = measurement.cycleId;
      state.view = "measurement-form";
      setToast("Preferencia guardada para los cálculos.");
      render();
      return;
    }
    if (action === "export") { await exportData(); return; }
    if (action === "delete-all") {
      if (!window.confirm(state.remoteConnected ? "Se eliminarán todos los ciclos y mediciones del backend y de este navegador. ¿Continuar?" : "Se eliminarán todos los ciclos y mediciones de este navegador. ¿Continuar?")) return;
      await repository.deleteAll();
      await reloadState();
      state.view = "summary";
      state.cycleId = null;
      setToast("Se eliminaron todos los datos locales.");
      render();
    }
  } catch (error) {
    setToast(error.message || "No se pudo completar la acción.", "error");
    render();
  }
});

app.addEventListener("change", async event => {
  if (event.target.matches("#shortcut-health-file")) {
    const file = event.target.files && event.target.files[0];
    try {
      await importShortcutFile(file);
    } catch (error) {
      setToast(error.message || "No se pudo importar el archivo.", "error");
      render();
    }
    return;
  }
  if (event.target.matches("[data-action='comparison']")) {
    state.comparison = event.target.value;
    render();
  }
  if (event.target.matches("#units-setting")) {
    const settings = { ...snapshot.settings, units: event.target.value === "imperial" ? "imperial" : "metric" };
    try {
      await repository.saveSettings(settings);
      await reloadState();
      setToast(`Unidades ${settings.units === "metric" ? "métricas" : "anglosajonas"} seleccionadas.`);
      render();
    } catch (error) { setToast(error.message, "error"); render(); }
  }
});

app.addEventListener("scroll", event => {
  const element = event.target;
  if (element instanceof HTMLElement && element.matches(".chart-wrap[data-chart-id]")) state.chartScroll[element.dataset.chartId] = element.scrollLeft;
}, true);

app.addEventListener("keydown", event => {
  const hero = event.target.closest(".cycle-hero-link");
  if (hero && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    state.cycleId = hero.dataset.cycleId;
    state.view = "cycle-detail";
    render();
  }
});

app.addEventListener("submit", async event => {
  if (event.target.matches("#backend-config-form")) {
    event.preventDefault();
    const form = event.target;
    const endpoint = String(new FormData(form).get("endpoint") || "").trim().replace(/\/$/, "");
    const token = String(new FormData(form).get("token") || "").trim() || (readRemoteConfig() || {}).token;
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("La URL del backend debe usar HTTPS.");
      if (!token) throw new Error("Introduce el token configurado en Cloudflare.");
      localStorage.setItem(REMOTE_CONFIG_KEY, JSON.stringify({ endpoint, token }));
      window.location.reload();
    } catch (error) {
      setToast(error.message || "No se pudo guardar la conexión.", "error");
      updateToastInPlace();
    }
    return;
  }
  if (!event.target.matches("#create-cycle-form, #measurement-form")) return;
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  const submitButton = event.target.querySelector("button[type='submit']");
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = "Guardando…"; }
  try {
    if (event.target.id === "create-cycle-form") await handleCreateCycle(event.target);
    else await handleMeasurementSave(event.target);
  } catch (error) {
    setToast(error.message || "No se pudo guardar.", "error");
    updateToastInPlace();
  } finally {
    state.busy = false;
  }
});

app.addEventListener("input", event => {
  if (event.target.matches("input[type='date'][name='startDate']")) {
    const measurementDate = app.querySelector("input[name='measurementDate']");
    if (measurementDate && measurementDate.dataset.touched !== "true") measurementDate.value = event.target.value;
  }
  if (event.target.matches("input[name='measurementDate']")) event.target.dataset.touched = "true";
});

async function boot() {
  let remoteConfig = null;
  try {
    const localRepository = await createRepository();
    remoteConfig = readRemoteConfig();
    repository = remoteConfig ? new RemoteRepository(localRepository, remoteConfig) : localRepository;
    if (remoteConfig) {
      await repository.connect();
      state.remoteConnected = true;
    }
    await reloadState();
    restoreShortcutDraft();
    if (remoteConfig && repository.pendingImport) await attachPendingBackendImport();
    await handleImportCallback();
    render();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { scope: new URL("../", import.meta.url).pathname }).catch(() => {
        setToast("La app funciona, pero no se pudo preparar el modo sin conexión.", "warning");
        render();
      });
    }
  } catch (error) {
    if (remoteConfig) {
      app.innerHTML = `<main class="storage-error connection-recovery"><div class="brand-mark" aria-hidden="true"><span></span></div><p class="eyebrow">HEALTH TRACKER</p><h1>No se pudo conectar con el backend</h1><p>${escapeHtml(error.message || "Comprueba la conexión, la URL y el token.")}</p><p>Los datos remotos no se han modificado. Corrige el acceso y vuelve a intentar.</p><form id="backend-config-form" class="backend-config-form"><label><span>URL del Worker</span><input name="endpoint" type="url" value="${escapeHtml(remoteConfig.endpoint)}" required></label><label><span>Token de acceso</span><input name="token" type="password" autocomplete="new-password" placeholder="Déjalo vacío para conservar el token actual"></label><button class="button button-primary" type="submit">Guardar y reintentar</button></form></main>`;
    } else {
      app.innerHTML = `<main class="storage-error"><div class="brand-mark" aria-hidden="true"><span></span></div><p class="eyebrow">HEALTH TRACKER</p><h1>No se pudo abrir el almacenamiento local</h1><p>${escapeHtml(error.message || "Prueba a abrir la aplicación desde Safari o un navegador actualizado.")}</p><p>Tus datos no se han modificado.</p></main>`;
    }
  }
}

function currentShortcutDraft() {
  return state.pendingShortcutDraft || readStoredShortcutDraft();
}

function stopPendingImportWait() {
  if (pendingImportPollTimer !== null) window.clearTimeout(pendingImportPollTimer);
  pendingImportPollTimer = null;
  pendingImportWaitUntil = 0;
}

function schedulePendingImportPoll() {
  const draft = currentShortcutDraft();
  if (document.visibilityState === "hidden" || !isShortcutDraftFresh(draft) || pendingImportPollTimer !== null) return;
  if (!pendingImportWaitUntil) pendingImportWaitUntil = Date.now() + PENDING_IMPORT_WAIT_MS;
  if (Date.now() >= pendingImportWaitUntil) {
    stopPendingImportWait();
    setToast("Todavía no llegaron los valores. Comprueba que el Atajo terminó el envío y vuelve a intentarlo.", "error");
    updateToastInPlace();
    return;
  }
  setToast("Esperando los valores de Apple Health desde Cloudflare…");
  updateToastInPlace();
  pendingImportPollTimer = window.setTimeout(() => {
    pendingImportPollTimer = null;
    refreshRemoteState();
  }, PENDING_IMPORT_POLL_MS);
}

async function refreshRemoteState() {
  if (!state.remoteConnected || state.busy || typeof repository.refresh !== "function" || document.visibilityState === "hidden") return;
  if (remoteRefreshPromise) return remoteRefreshPromise;
  remoteRefreshPromise = (async () => {
    try {
      await repository.refresh();
      await reloadState();
      const attached = await attachPendingBackendImport();
      if (attached) {
        stopPendingImportWait();
        render();
        return;
      }
      if (repository.pendingImport) {
        stopPendingImportWait();
        updateToastInPlace();
        return;
      }
      if (isShortcutDraftFresh(currentShortcutDraft())) {
        schedulePendingImportPoll();
        return;
      }
      stopPendingImportWait();
      if (["summary", "cycles", "cycle-detail"].includes(state.view)) render();
    } catch {
      if (isShortcutDraftFresh(currentShortcutDraft())) {
        setToast("Esperando la conexión con Cloudflare…", "warning");
        updateToastInPlace();
        schedulePendingImportPoll();
      } else {
        setToast("No se pudo actualizar desde el backend. Se mantienen los datos locales.", "warning");
        updateToastInPlace();
      }
    }
  })();
  try {
    await remoteRefreshPromise;
  } finally {
    remoteRefreshPromise = null;
  }
}

async function attachPendingBackendImport() {
  const imported = repository && repository.pendingImport;
  if (!imported) return false;
  let draft = currentShortcutDraft();
  const form = app.querySelector("#create-cycle-form, #measurement-form");
  if (draft && form) draft = updateDraftFromCurrentForm(form, { ...draft, values: { ...draft.values } });
  if (!draft || draft.requestedDate !== imported.date || !isShortcutDraftFresh(draft)) {
    setToast(`Hay una importación pendiente para ${displayDate(imported.date)}. Abre el formulario de esa medición para recibirla.`, "warning");
    return false;
  }
  try {
    const updatedDraft = attachShortcutImport(draft, imported, snapshot.settings.units);
    state.pendingShortcutDraft = updatedDraft;
    state.view = updatedDraft.view;
    state.cycleId = updatedDraft.cycleId;
    state.measurementId = updatedDraft.measurementId;
    if (!saveStoredShortcutDraft(updatedDraft)) return false;
    setToast(`${imported.observations.length} valor(es) recibidos del Atajo. Revisa el formulario y guarda la medición.`);
    return true;
  } catch (error) {
    setToast(error.message || "No se pudo recibir la importación pendiente.", "error");
    return false;
  }
}

window.addEventListener("pageshow", refreshRemoteState);
window.addEventListener("focus", refreshRemoteState);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshRemoteState();
});

boot();
