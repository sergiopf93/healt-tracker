import { fromCanonical, isValidDateOnly } from "../../domain.mjs";

export const APPLE_HEALTH_SHORTCUT_NAME = "health-care - Apple Health";
export const SHORTCUT_DRAFT_STORAGE_KEY = "health-tracker:apple-health-draft:v1";
export const SHORTCUT_DRAFT_TTL_MS = 10 * 60 * 1000;

export function buildAppleHealthShortcutUrl(date) {
  if (!isValidDateOnly(date)) throw new Error("Selecciona una fecha válida antes de abrir Apple Health.");
  const query = new URLSearchParams({
    name: APPLE_HEALTH_SHORTCUT_NAME,
    input: "text",
    text: date
  });
  return `shortcuts://run-shortcut?${query.toString()}`;
}

export function createShortcutDraft({ view, cycleId = null, measurementId = null, date, values, type = null, startDate = null, now = Date.now() }) {
  if (!["create-cycle", "measurement-form"].includes(view)) throw new Error("El formulario actual no admite una importación.");
  if (!isValidDateOnly(date)) throw new Error("Selecciona una fecha válida antes de abrir Apple Health.");
  return {
    version: 1,
    view,
    cycleId,
    measurementId,
    requestedDate: date,
    createdAt: now,
    expiresAt: now + SHORTCUT_DRAFT_TTL_MS,
    type,
    startDate,
    values: { ...values },
    prefilledValues: {},
    healthObservations: [],
    ignoredMetrics: []
  };
}

export function isShortcutDraftFresh(draft, now = Date.now()) {
  return Boolean(draft && draft.version === 1 && Number.isFinite(draft.expiresAt) && draft.expiresAt > now);
}

export function attachShortcutImport(draft, imported, system = "metric") {
  if (!isShortcutDraftFresh(draft)) throw new Error("El formulario pendiente ha caducado. Vuelve a abrir Apple Health desde el formulario.");
  if (imported.date !== draft.requestedDate) throw new Error("La fecha devuelta por el atajo no coincide con la fecha del formulario.");
  const values = { ...draft.values };
  const prefilledValues = { ...draft.prefilledValues };
  for (const observation of imported.observations) {
    const current = values[observation.metric];
    if (current == null || String(current).trim() === "") {
      const shown = fromCanonical(observation.metric, observation.value, system);
      const formatted = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(shown);
      values[observation.metric] = formatted;
      prefilledValues[observation.metric] = formatted;
    }
  }
  return {
    ...draft,
    values,
    prefilledValues,
    healthObservations: imported.observations,
    ignoredMetrics: imported.ignored || [],
    importedDate: imported.date
  };
}

export function manualEntriesFromDraft(values, prefilledValues = {}) {
  const manual = { ...values };
  for (const [metricId, importedText] of Object.entries(prefilledValues)) {
    if (String(manual[metricId] == null ? "" : manual[metricId]) === String(importedText)) delete manual[metricId];
  }
  return manual;
}
