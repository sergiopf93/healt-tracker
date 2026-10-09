import { HEALTH_ESTIMATES, HEALTH_KEYS, METRICS, createId, isValidDateOnly, makeObservation, toCanonical } from "../../domain.mjs";

const MAX_PAYLOAD_LENGTH = 32_768;

function decodeCandidate(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  try {
    const decoded = decodeURIComponent(trimmed);
    return decoded.startsWith("{") || decoded.startsWith("[") ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}

function parseJsonText(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("El parámetro healthData está vacío.");
  if (value.length > MAX_PAYLOAD_LENGTH) throw new Error("La importación supera el tamaño permitido.");
  try {
    return JSON.parse(decodeCandidate(value));
  } catch {
    throw new Error("El JSON de Apple Health no es válido.");
  }
}

function unwrapPayload(value) {
  let parsed = parseJsonText(value);
  if (parsed && typeof parsed === "object" && typeof parsed.healthData === "string") parsed = parseJsonText(parsed.healthData);
  return parsed;
}

function expectedUnit(metricId, unit) {
  const normalized = String(unit || "").toLowerCase().trim();
  if (metricId === "Weight" || metricId === "Lean Body Mass") return ["kg", "lb", "lbs"].includes(normalized);
  if (metricId === "Body Fat Percentage") return ["%", "percent", "percentage"].includes(normalized);
  if (metricId === "Resting Calories") return ["kcal", "cal", "kilocalories"].includes(normalized);
  if (metricId === "Steps") return ["steps", "step", "count", "pasos", ""].includes(normalized);
  if (metricId === "Body Mass Index") return ["count", "index", ""].includes(normalized);
  return false;
}

function validateRange(metricId, value) {
  const limits = {
    Weight: [0, 500],
    "Lean Body Mass": [0, 500],
    "Body Fat Percentage": [0, 100],
    "Resting Calories": [0, 10000],
    Steps: [0, 100000],
    "Body Mass Index": [0, 100]
  }[metricId];
  return limits && (metricId === "Steps" ? value >= limits[0] : value > limits[0]) && value <= limits[1];
}

function weeklyStepsObservation(payload) {
  if (payload.steps == null) return null;
  let steps = payload.steps;
  if (typeof steps === "string") {
    try { steps = JSON.parse(decodeCandidate(steps)); }
    catch { throw new Error("El campo steps debe contener un objeto JSON válido."); }
  }
  if (!steps || typeof steps !== "object" || Array.isArray(steps)) {
    throw new Error("El campo steps debe ser un diccionario de fecha a número de pasos o texto JSON válido con ese diccionario.");
  }
  const entries = Object.entries(steps);
  if (entries.length > 7) throw new Error("El nodo steps puede incluir como máximo los siete días anteriores al registro.");
  const dailyValues = [];
  for (const [date, value] of entries) {
    if (!isValidDateOnly(date)) throw new Error(`La fecha ${date} del nodo steps no es válida.`);
    if (date >= payload.date) throw new Error("Las fechas del nodo steps deben ser anteriores a la fecha del registro.");
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000) {
      throw new Error(`Los pasos del ${date} deben ser un número entre 0 y 100000.`);
    }
    dailyValues.push([date, value]);
  }
  if (!dailyValues.length) return null;
  const average = dailyValues.reduce((sum, [, value]) => sum + value, 0) / dailyValues.length;
  const measuredAt = payload.date;
  const fingerprint = [payload.date, "Steps", JSON.stringify(dailyValues.sort(([a], [b]) => a.localeCompare(b)))].join("|");
  return makeObservation({
    metric: "Steps",
    value: average,
    unit: "pasos/día",
    source: "apple_health",
    sourceName: `Fitbit · media de ${dailyValues.length} ${dailyValues.length === 1 ? "día" : "días"}`,
    measuredAt,
    fingerprint,
    quality: "measured"
  });
}

export function parseHealthDataParam(search) {
  const params = new URLSearchParams(search || "");
  const values = params.getAll("healthData");
  if (!values.length) return { status: "absent" };
  if (values.length !== 1) throw new Error("La URL contiene más de un parámetro healthData.");
  return parseHealthData(values[0]);
}

export function parseHealthData(rawPayload) {
  const payload = unwrapPayload(rawPayload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("El contenido de healthData debe ser un objeto JSON.");
  if (!isValidDateOnly(payload.date)) throw new Error("La fecha de Apple Health no tiene el formato YYYY-MM-DD.");
  let data = payload.data;
  if (typeof data === "string") {
    try { data = JSON.parse(decodeCandidate(data)); }
    catch { throw new Error("El campo data debe contener un objeto JSON válido."); }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Falta el objeto data de Apple Health. Envía data como diccionario o como texto JSON válido.");
  }

  const observations = [];
  const ignored = [];
  const weeklySteps = weeklyStepsObservation(payload);
  for (const [metricId, item] of Object.entries(data)) {
    if (!HEALTH_KEYS.includes(metricId)) {
      ignored.push(metricId);
      continue;
    }
    if (metricId === "Steps" && weeklySteps) continue;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`El valor de ${metricId} no tiene un formato válido.`);
    if (typeof item.value !== "number" || !Number.isFinite(item.value)) throw new Error(`El valor de ${metricId} debe ser un número válido.`);
    if (!expectedUnit(metricId, item.unit)) throw new Error(`La unidad de ${metricId} no está reconocida.`);
    const metric = METRICS.find(entry => entry.id === metricId);
    const canonicalUnit = metric.unit;
    const normalizedUnit = String(item.unit || "").toLowerCase().trim();
    const value = toCanonical(metricId, item.value, normalizedUnit, "metric");
    if (!validateRange(metricId, value)) throw new Error(`El valor de ${metricId} está fuera de un rango válido.`);
    const measuredAt = item.measuredAt || item.dateTime || item.timestamp || null;
    if (measuredAt && (typeof measuredAt !== "string" || Number.isNaN(Date.parse(measuredAt)))) {
      throw new Error(`La fecha de la muestra ${metricId} no es válida.`);
    }
    const sourceName = typeof item.source === "string" ? item.source.slice(0, 80) : null;
    const fingerprint = [payload.date, metricId, sourceName || "", value.toFixed(8), canonicalUnit, measuredAt || ""].join("|");
    observations.push(makeObservation({
      metric: metricId,
      value,
      unit: canonicalUnit,
      source: "apple_health",
      sourceName,
      measuredAt,
      fingerprint,
      quality: HEALTH_ESTIMATES.has(metricId) ? "estimated" : "measured"
    }));
  }
  if (weeklySteps) observations.push(weeklySteps);
  if (!observations.length) throw new Error("No se encontraron métricas compatibles para importar.");
  return { status: "valid", date: payload.date, observations, ignored };
}

export function createImportObservationFingerprint(date, metric, value, unit, sourceName, measuredAt = null) {
  return [date, metric, sourceName || "", Number(value).toFixed(8), unit, measuredAt || ""].join("|");
}

export function importBatchId(date, observations) {
  const source = observations.map(item => item.fingerprint).sort().join(";");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `health_${date}_${(hash >>> 0).toString(36)}_${createId("run").slice(-7)}`;
}
