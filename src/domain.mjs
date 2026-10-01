export const SCHEMA_VERSION = 1;
export const CYCLE_TYPES = [
  { id: "deficit", label: "Déficit calórico" },
  { id: "maintenance", label: "Mantenimiento" },
  { id: "muscle_gain", label: "Ganancia de masa" },
  { id: "recomposition", label: "Recomposición" }
];

export const METRICS = [
  { id: "Weight", label: "Peso", unit: "kg", dimension: "mass", health: true },
  { id: "Body Fat Percentage", label: "Grasa corporal", unit: "%", dimension: "percent", health: true, estimate: true },
  { id: "Lean Body Mass", label: "Masa libre de grasa", unit: "kg", dimension: "mass", health: true, estimate: true },
  { id: "Resting Calories", label: "TMB · energía en reposo", unit: "kcal", dimension: "energy", health: true, estimate: true },
  { id: "Body Mass Index", label: "IMC", unit: "count", dimension: "index", health: true, estimate: true },
  { id: "Waist", label: "Cintura", unit: "cm", dimension: "length" },
  { id: "Hips", label: "Cadera", unit: "cm", dimension: "length" },
  { id: "Flotadores", label: "Flotadores", unit: "cm", dimension: "length" }
];

export const HEALTH_KEYS = METRICS.filter(metric => metric.health).map(metric => metric.id);
export const HEALTH_ESTIMATES = new Set(["Body Fat Percentage", "Lean Body Mass", "Resting Calories", "Body Mass Index"]);

export function todayLocalDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function daysBetween(startDate, endDate) {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) throw new Error("La fecha no es válida.");
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

export function cycleWeek(startDate, measurementDate) {
  return Math.floor(daysBetween(startDate, measurementDate) / 7) + 1;
}

export function createId(prefix = "id") {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : null;
  return `${prefix}_${uuid || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

export function parseLocaleNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  let normalized = value.trim().replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else normalized = normalized.replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function toCanonical(metricId, value, unit, system = "metric") {
  const metric = METRICS.find(item => item.id === metricId);
  if (!metric || !Number.isFinite(value)) throw new Error("No se puede convertir esta medición.");
  if (metric.dimension === "mass") {
    if (["lb", "lbs"].includes(unit) || (system === "imperial" && unit !== "kg")) return value / 2.2046226218;
    if (unit === "kg" || !unit) return value;
  }
  if (metric.dimension === "length") {
    if (unit === "in" || (system === "imperial" && unit !== "cm")) return value * 2.54;
    if (unit === "cm" || !unit) return value;
  }
  if (metric.dimension === "energy" && unit === "cal") return value / 1000;
  return value;
}

export function fromCanonical(metricId, value, system = "metric") {
  const metric = METRICS.find(item => item.id === metricId);
  if (!metric || !Number.isFinite(value)) return null;
  if (system === "imperial" && metric.dimension === "mass") return value * 2.2046226218;
  if (system === "imperial" && metric.dimension === "length") return value / 2.54;
  return value;
}

export function displayUnit(metricId, system = "metric") {
  const metric = METRICS.find(item => item.id === metricId);
  if (!metric) return "";
  if (system === "imperial" && metric.dimension === "mass") return "lb";
  if (system === "imperial" && metric.dimension === "length") return "in";
  return metric.unit;
}

function isPlausibleMetricValue(metricId, value) {
  const limits = {
    Weight: [0, 500],
    "Lean Body Mass": [0, 500],
    "Body Fat Percentage": [0, 100],
    "Resting Calories": [0, 10000],
    "Body Mass Index": [0, 100],
    Waist: [0, 300],
    Hips: [0, 300],
    Flotadores: [0, 300]
  }[metricId];
  return Boolean(limits && value > limits[0] && value <= limits[1]);
}

export function makeObservation({ metric, value, unit, source, sourceName = null, measuredAt = null, fingerprint = null, quality = "measured" }) {
  return {
    id: createId("obs"), metric, value, unit, source, sourceName,
    measuredAt, fingerprint, quality, createdAt: new Date().toISOString()
  };
}

export function createMeasurement(cycleId, date, observations = [], id = createId("measurement")) {
  if (!isValidDateOnly(date)) throw new Error("Introduce una fecha válida.");
  const grouped = {};
  for (const observation of observations) {
    if (!grouped[observation.metric]) grouped[observation.metric] = [];
    grouped[observation.metric].push(observation);
  }
  return { id, cycleId, date, observations: grouped, resolutions: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export function observationValues(measurement, metricId) {
  return measurement && measurement.observations && measurement.observations[metricId] || [];
}

export function isObservationConflict(observations = []) {
  if (observations.length < 2) return false;
  const values = observations.map(item => item.value);
  return values.some(value => Math.abs(value - values[0]) > 1e-7);
}

export function effectiveObservation(measurement, metricId) {
  const observations = observationValues(measurement, metricId);
  if (!observations.length) return null;
  const resolutionId = measurement && measurement.resolutions && measurement.resolutions[metricId];
  if (resolutionId) return observations.find(item => item.id === resolutionId) || null;
  if (isObservationConflict(observations)) return null;
  return observations.find(item => item.source === "manual") || observations[0];
}

export function setManualObservations(measurement, entries, system = "metric") {
  const result = structuredCloneSafe(measurement);
  let changed = false;
  for (const [metricId, rawValue] of Object.entries(entries)) {
    if (rawValue === "" || rawValue == null) continue;
    const valueShown = parseLocaleNumber(rawValue);
    if (valueShown === null) throw new Error(`Revisa el valor de ${metricId}.`);
    const metric = METRICS.find(item => item.id === metricId);
    if (!metric || metric.health === false && !metric.unit) throw new Error("Métrica desconocida.");
    const value = toCanonical(metricId, valueShown, displayUnit(metricId, system), system);
    if (!Number.isFinite(value) || !isPlausibleMetricValue(metricId, value)) throw new Error(`El valor de ${metric.label} no es válido.`);
    const list = result.observations[metricId] || (result.observations[metricId] = []);
    const existing = list.find(item => item.source === "manual");
    const previousEffective = effectiveObservation(result, metricId);
    if (existing && Math.abs(existing.value - value) < 1e-7) continue;
    if (!existing && previousEffective && Math.abs(previousEffective.value - value) < 1e-7) continue;
    const observation = makeObservation({ metric: metricId, value, unit: metric.unit, source: "manual", quality: "measured" });
    if (existing) list[list.indexOf(existing)] = { ...observation, id: existing.id, createdAt: existing.createdAt };
    else list.push(observation);
    if (result.resolutions[metricId]) delete result.resolutions[metricId];
    changed = true;
  }
  if (!Object.values(result.observations).some(list => list.length)) throw new Error("Añade al menos un valor a la medición.");
  if (changed) result.updatedAt = new Date().toISOString();
  return result;
}

export function resolveObservation(measurement, metricId, observationId) {
  const result = structuredCloneSafe(measurement);
  if (!observationValues(result, metricId).some(item => item.id === observationId)) throw new Error("No se encontró el valor seleccionado.");
  result.resolutions[metricId] = observationId;
  result.updatedAt = new Date().toISOString();
  return result;
}

export function deriveMetrics(measurement) {
  const weight = effectiveObservation(measurement, "Weight");
  const bodyFat = effectiveObservation(measurement, "Body Fat Percentage");
  if (!weight || !bodyFat || bodyFat.value < 0 || bodyFat.value > 100) return {};
  const fatMass = weight.value * bodyFat.value / 100;
  const leanObservation = effectiveObservation(measurement, "Lean Body Mass");
  return {
    fatMass: { value: fatMass, unit: "kg", source: "calculated", quality: "estimated" },
    fatFreeMass: leanObservation
      ? { value: leanObservation.value, unit: "kg", source: leanObservation.source, quality: leanObservation.quality }
      : { value: weight.value - fatMass, unit: "kg", source: "calculated", quality: "estimated" }
  };
}

export function difference(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference)) return null;
  return current - reference;
}

export function percentageChange(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) return null;
  return 100 * (current - reference) / reference;
}

export function selectReference(measurements, latestMeasurement, cycle, horizon) {
  if (horizon === "start") return measurements.find(item => item.id === cycle.baselineMeasurementId) || null;
  const latestWeek = cycleWeek(cycle.startDate, latestMeasurement.date);
  const targetWeek = latestWeek - Number(horizon);
  if (!Number.isInteger(targetWeek) || targetWeek < 1) return null;
  return measurements
    .filter(item => cycleWeek(cycle.startDate, item.date) === targetWeek)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

export function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createCycleRecord({ type, startDate, baselineDate = startDate, baselineObservations }) {
  if (!CYCLE_TYPES.some(item => item.id === type)) throw new Error("Selecciona un tipo de ciclo.");
  if (!isValidDateOnly(startDate) || !isValidDateOnly(baselineDate)) throw new Error("Introduce fechas válidas.");
  if (baselineDate < startDate) throw new Error("La medición inicial no puede ser anterior al inicio del ciclo.");
  if (baselineDate > todayLocalDate()) throw new Error("La medición inicial no puede estar en el futuro.");
  if (cycleWeek(startDate, baselineDate) > 16) throw new Error("La medición inicial debe estar dentro de las 16 semanas del ciclo.");
  if (!baselineObservations || !baselineObservations.length) throw new Error("La medición inicial necesita al menos un valor.");
  const cycle = {
    id: createId("cycle"), type, startDate, plannedWeeks: 16, status: "active",
    baselineMeasurementId: null, createdAt: new Date().toISOString(), closedAt: null
  };
  const measurement = createMeasurement(cycle.id, baselineDate, baselineObservations);
  cycle.baselineMeasurementId = measurement.id;
  return { cycle, measurement };
}

export function makeManualBaselineObservations(entries, system = "metric") {
  const observations = [];
  for (const [metricId, rawValue] of Object.entries(entries)) {
    if (rawValue === "" || rawValue == null) continue;
    const valueShown = parseLocaleNumber(rawValue);
    if (valueShown === null) throw new Error(`Revisa el valor de ${metricId}.`);
    const metric = METRICS.find(item => item.id === metricId);
    if (!metric) throw new Error("Métrica desconocida.");
    const value = toCanonical(metricId, valueShown, displayUnit(metricId, system), system);
    if (!Number.isFinite(value) || !isPlausibleMetricValue(metricId, value)) throw new Error(`El valor de ${metric.label} no es válido.`);
    observations.push(makeObservation({ metric: metricId, value, unit: metric.unit, source: "manual" }));
  }
  return observations;
}
