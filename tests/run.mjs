import assert from "assert";
import {
  cycleWeek, daysBetween, isValidDateOnly, parseLocaleNumber, toCanonical, fromCanonical,
  averageMetricByCycleWeek, createCycleRecord, makeManualBaselineObservations, createMeasurement, makeObservation,
  effectiveObservation, isObservationConflict, resolveObservation, selectReference,
  percentageChange, deriveMetrics, setManualObservations
} from "../src/domain.mjs";
import { parseHealthData, parseHealthDataParam } from "../src/integrations/apple-health/parser.mjs";
import { APPLE_HEALTH_SHORTCUT_NAME, attachShortcutImport, buildAppleHealthShortcutUrl, createShortcutDraft, isShortcutDraftFresh, manualEntriesFromDraft } from "../src/integrations/apple-health/shortcut.mjs";
import { LocalRepository, makeExport } from "../src/data/repository.mjs";
import { RemoteRepository } from "../src/data/remote-repository.mjs";

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function rejects(fn, pattern) { assert.throws(fn, pattern); }

test("dates are strict local calendar dates and weeks tolerate missing records", () => {
  assert.equal(isValidDateOnly("2026-02-28"), true);
  assert.equal(isValidDateOnly("2026-02-29"), false);
  assert.equal(isValidDateOnly("2026-2-03"), false);
  assert.equal(daysBetween("2026-03-01", "2026-03-08"), 7);
  assert.equal(cycleWeek("2026-03-01", "2026-03-07"), 1);
  assert.equal(cycleWeek("2026-03-01", "2026-03-08"), 2);
  assert.equal(cycleWeek("2026-01-01", "2026-04-22"), 16);
  assert.equal(cycleWeek("2026-01-01", "2026-04-23"), 17);
});

test("metric parsing and conversions keep canonical values", () => {
  assert.equal(parseLocaleNumber("1.234,5"), 1234.5);
  assert.equal(parseLocaleNumber("72,4"), 72.4);
  assert.equal(parseLocaleNumber(""), null);
  assert.ok(Math.abs(toCanonical("Weight", 160, "lb") - 72.5748) < .001);
  assert.ok(Math.abs(fromCanonical("Waist", 88.9, "imperial") - 35) < .001);
  assert.ok(Math.abs(toCanonical("Waist", 35, "in", "imperial") - 88.9) < .001);
  assert.equal(toCanonical("Resting Calories", 1600000, "cal"), 1600);
});

test("cycle requires a baseline, accepts its actual later date, and rejects earlier date", () => {
  const observations = makeManualBaselineObservations({ Weight: "72,4", "Body Fat Percentage": "24" });
  const { cycle, measurement } = createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineDate: "2026-01-04", baselineObservations: observations });
  assert.equal(measurement.date, "2026-01-04");
  assert.equal(cycle.baselineMeasurementId, measurement.id);
  rejects(() => createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineDate: "2025-12-31", baselineObservations: observations }), /anterior/);
  rejects(() => createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineDate: "2026-04-23", baselineObservations: observations }), /16 semanas/);
  rejects(() => createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineObservations: [] }), /al menos un valor/);
});

test("manual measurements enforce plausible nonzero quantities and preserve blank values", () => {
  const base = createMeasurement("c1", "2026-01-01");
  rejects(() => makeManualBaselineObservations({ Weight: "0" }), /no es válido/);
  rejects(() => makeManualBaselineObservations({ Weight: "700" }), /no es válido/);
  rejects(() => makeManualBaselineObservations({ "Body Fat Percentage": "101" }), /no es válido/);
  rejects(() => makeManualBaselineObservations({ "Body Mass Index": "101" }), /no es válido/);
  const saved = setManualObservations(base, { Weight: "72", Waist: "80" });
  const edited = setManualObservations(saved, { Weight: "", Waist: "82" });
  assert.equal(effectiveObservation(edited, "Weight").value, 72);
  assert.equal(effectiveObservation(edited, "Waist").value, 82);
});

test("observation conflicts need a deliberate choice; derived composition stays estimated", () => {
  const manual = makeObservation({ metric: "Weight", value: 72, unit: "kg", source: "manual" });
  const health = makeObservation({ metric: "Weight", value: 71, unit: "kg", source: "apple_health" });
  const fat = makeObservation({ metric: "Body Fat Percentage", value: 25, unit: "%", source: "apple_health", quality: "estimated" });
  let measurement = createMeasurement("c1", "2026-01-01", [manual, health, fat]);
  assert.equal(isObservationConflict(measurement.observations.Weight), true);
  assert.equal(effectiveObservation(measurement, "Weight"), null);
  measurement = resolveObservation(measurement, "Weight", manual.id);
  assert.equal(effectiveObservation(measurement, "Weight").value, 72);
  assert.equal(deriveMetrics(measurement).fatMass.value, 18);
  assert.equal(deriveMetrics(measurement).fatMass.quality, "estimated");
  assert.equal(percentageChange(4, 0), null);
});

test("reference selection returns recorded weeks only", () => {
  const baseline = createMeasurement("c1", "2026-01-01", [], "baseline");
  const week3 = createMeasurement("c1", "2026-01-15", [], "week3");
  const cycle = { startDate: "2026-01-01", baselineMeasurementId: "baseline" };
  assert.equal(selectReference([baseline, week3], week3, cycle, "start").id, "baseline");
  assert.equal(selectReference([baseline, week3], week3, cycle, "1"), null);
});

test("weekly step means use cycle-relative seven-day windows and omit unresolved values", () => {
  const measurements = [
    createMeasurement("c1", "2026-01-01", [makeObservation({ metric: "Steps", value: 4000, unit: "pasos/día", source: "apple_health" })]),
    createMeasurement("c1", "2026-01-05", [makeObservation({ metric: "Steps", value: 6000, unit: "pasos/día", source: "apple_health" })]),
    createMeasurement("c1", "2026-01-08", [makeObservation({ metric: "Steps", value: 8000, unit: "pasos/día", source: "apple_health" })])
  ];
  assert.deepEqual(averageMetricByCycleWeek(measurements, "Steps", "2026-01-01"), [
    { week: 1, value: 5000, count: 2 }, { week: 2, value: 8000, count: 1 }
  ]);
});

test("Apple Health JSON parser accepts callback payload and safely canonicalizes values", () => {
  const payload = { date: "2026-01-01", data: {
    Weight: { value: 160, unit: "lb", source: "Scale" },
    "Body Fat Percentage": { value: 24, unit: "%" },
    "Resting Calories": { value: 1600000, unit: "CAL" },
    Steps: { value: 5000, unit: "count" }
  } };
  const parsed = parseHealthData(JSON.stringify(payload));
  assert.equal(parsed.observations.length, 4);
  assert.deepEqual(parsed.ignored, []);
  assert.ok(Math.abs(parsed.observations[0].value - 72.5748) < .001);
  assert.equal(parsed.observations[1].quality, "estimated");
  assert.equal(parsed.observations.find(item => item.metric === "Resting Calories").value, 1600);
  const encoded = encodeURIComponent(JSON.stringify(payload));
  assert.equal(parseHealthDataParam(`?healthData=${encoded}`).date, "2026-01-01");
  assert.equal(parsed.observations.find(item => item.metric === "Steps").unit, "pasos/día");
  assert.equal(parseHealthDataParam(`?healthData=${encodeURIComponent(encoded)}`).observations.length, 4);
  assert.equal(parseHealthDataParam("").status, "absent");
});

test("Apple Health parser rejects malformed, ambiguous, oversized, and implausible payloads", () => {
  rejects(() => parseHealthData("{no"), /JSON/);
  rejects(() => parseHealthData(JSON.stringify({ date: "2026-02-30", data: { Weight: { value: 70, unit: "kg" } } })), /fecha/);
  rejects(() => parseHealthData(JSON.stringify({ date: "2026-01-01", data: { Weight: { value: 70, unit: "stones" } } })), /unidad/);
  rejects(() => parseHealthData(JSON.stringify({ date: "2026-01-01", data: { Weight: { value: "70", unit: "kg" } } })), /número/);
  rejects(() => parseHealthData(JSON.stringify({ date: "2026-01-01", data: { "Body Fat Percentage": { value: 120, unit: "%" } } })), /rango/);
  assert.equal(parseHealthData(JSON.stringify({ date: "2026-01-01", data: { Steps: { value: 2, unit: "count" } } })).observations[0].metric, "Steps");
  assert.equal(parseHealthData(JSON.stringify({ date: "2026-01-01", data: { Steps: { value: 0, unit: "count" } } })).observations[0].value, 0);
  rejects(() => parseHealthDataParam("?healthData=%7B%7D&healthData=%7B%7D"), /más de un/);
  rejects(() => parseHealthData("x".repeat(33000)), /tamaño/);
});

test("Apple Health shortcut URL passes the selected date and draft imports only into empty fields", () => {
  const shortcutUrl = buildAppleHealthShortcutUrl("2026-01-02");
  assert.equal(shortcutUrl, "shortcuts://run-shortcut?name=health-care%20-%20Apple%20Health&input=text&text=2026-01-02");
  const url = new URL(shortcutUrl);
  assert.equal(url.protocol, "shortcuts:");
  assert.equal(url.hostname, "run-shortcut");
  assert.equal(url.searchParams.get("name"), APPLE_HEALTH_SHORTCUT_NAME);
  assert.equal(url.searchParams.get("input"), "text");
  assert.equal(url.searchParams.get("text"), "2026-01-02");
  rejects(() => buildAppleHealthShortcutUrl("2026-02-30"), /fecha/);

  const now = Date.now();
  const draft = createShortcutDraft({ view: "create-cycle", date: "2026-01-02", values: { Weight: "73,5", "Body Mass Index": "" }, now });
  const parsed = parseHealthData(JSON.stringify({ date: "2026-01-02", data: {
    Weight: { value: 70, unit: "kg" }, "Body Mass Index": { value: 22, unit: "count" }
  } }));
  const attached = attachShortcutImport(draft, parsed, "metric");
  assert.equal(attached.values.Weight, "73,5");
  assert.equal(attached.values["Body Mass Index"], "22");
  assert.equal(attached.healthObservations.length, 2);
  assert.deepEqual(manualEntriesFromDraft(attached.values, attached.prefilledValues), { Weight: "73,5" });
  assert.equal(isShortcutDraftFresh(draft, now + 1), true);
  assert.equal(isShortcutDraftFresh(draft, draft.expiresAt), false);
  rejects(() => attachShortcutImport(draft, { ...parsed, date: "2026-01-03" }), /no coincide/);
});

test("JSON export has a stable product envelope without server dependencies", () => {
  const backup = makeExport({ cycles: [], measurements: [], settings: { units: "metric" } });
  assert.equal(backup.format, "health-tracker-backup");
  assert.equal(backup.settings.units, "metric");
  assert.ok(backup.exportedAt);
});

class FakeDatabase {
  constructor() { this.stores = { cycles: new Map(), measurements: new Map(), settings: new Map() }; }
  transaction(names) {
    const db = this;
    const selected = Array.isArray(names) ? names : [names];
    const staged = {};
    selected.forEach(name => { staged[name] = new Map(Array.from(db.stores[name], ([key, value]) => [key, JSON.parse(JSON.stringify(value))])); });
    let pending = 0, aborted = false, finishQueued = false;
    const completeIfReady = () => {
      if (pending || aborted || finishQueued) return;
      finishQueued = true;
      queueMicrotask(() => {
        finishQueued = false;
        if (aborted || pending) return;
        Object.keys(staged).forEach(storeName => { db.stores[storeName] = staged[storeName]; });
        if (tx.oncomplete) tx.oncomplete();
      });
    };
    const tx = {
      error: null,
      touch() { setTimeout(completeIfReady, 0); },
      objectStore(name) {
        const map = staged[name];
        const schedule = (result, request) => {
          pending += 1;
          setTimeout(() => {
            if (!aborted) {
              request.result = result;
              if (request.onsuccess) request.onsuccess();
            }
            pending -= 1;
            completeIfReady();
          }, 0);
          return request;
        };
        const store = {
          getAll() { return schedule(Array.from(map.values()), {}); },
          get(key) { return schedule(map.get(key), {}); },
          add(value) { map.set(value.id, JSON.parse(JSON.stringify(value))); tx.touch(); },
          put(value) { map.set(value.id || value.key, JSON.parse(JSON.stringify(value))); tx.touch(); },
          clear() { map.clear(); tx.touch(); },
          delete(key) { map.delete(key); tx.touch(); },
          index() { return { getAll(key) { return schedule(Array.from(map.values()).filter(value => value.cycleId === key), {}); } }; }
        };
        return store;
      },
      abort() {
        if (aborted) return;
        aborted = true;
        tx.error = new Error("AbortError");
        setTimeout(() => { if (tx.onabort) tx.onabort(); }, 0);
      }
    };
    return tx;
  }
  close() {}
}

test("repository persists cycles/settings, deduplicates Apple Health and preserves conflicts", async () => {
  const repository = new LocalRepository(new FakeDatabase());
  const baseline = makeManualBaselineObservations({ Weight: "72" });
  const { cycle, measurement } = createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineObservations: baseline });
  await repository.createCycleWithBaseline(cycle, measurement);
  await assert.rejects(repository.deleteCycle(cycle.id), /Solo se pueden eliminar ciclos cerrados/);
  const imported = parseHealthData(JSON.stringify({ date: "2026-01-01", data: { Weight: { value: 70, unit: "kg", source: "Health Scale" }, "Body Fat Percentage": { value: 24, unit: "%" } } }));
  const first = await repository.importHealthData(imported);
  assert.equal(first.added, 2);
  assert.deepEqual(first.conflicts, ["Weight"]);
  const repeated = await repository.importHealthData(imported);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicates, 2);
  await repository.saveSettings({ units: "imperial" });
  let state = await repository.getState();
  assert.equal(state.cycles.length, 1);
  assert.equal(state.measurements.length, 1);
  assert.equal(state.settings.units, "imperial");
  assert.equal(state.measurements[0].observations.Weight.length, 2);
  const closed = await repository.closeCycle(cycle.id);
  assert.equal(closed.status, "completed");
  await repository.deleteCycle(cycle.id);
  state = await repository.getState();
  assert.equal(state.cycles.length, 0);
  assert.equal(state.measurements.length, 0);
  assert.equal(makeExport(state).format, "health-tracker-backup");
  await repository.deleteAll();
  state = await repository.getState();
  assert.equal(state.cycles.length, 0);
  assert.equal(state.measurements.length, 0);
  assert.equal(state.settings.units, "metric");
});

test("remote repository bootstraps local state and synchronizes later changes", async () => {
  const local = new LocalRepository(new FakeDatabase());
  const server = { revision: 0, state: { cycles: [], measurements: [], settings: { units: "metric" } } };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (options.headers.Authorization !== "Bearer test-token") return { ok: false, status: 401, json: async () => ({ error: "auth" }) };
    if (options.method === "PUT") {
      if (Number(options.headers["If-Match"]) !== server.revision) return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
      server.state = JSON.parse(options.body);
      server.revision += 1;
    }
    return { ok: true, status: 200, json: async () => ({ ...server, pendingImport: null }) };
  };
  const repository = new RemoteRepository(local, { endpoint: "https://api.example", token: "test-token", fetcher });
  await repository.connect();
  const baseline = makeManualBaselineObservations({ Weight: "72" });
  const { cycle, measurement } = createCycleRecord({ type: "deficit", startDate: "2026-01-01", baselineObservations: baseline });
  await repository.createCycleWithBaseline(cycle, measurement);
  assert.equal(server.state.cycles.length, 1);
  assert.equal(server.state.measurements.length, 1);
  assert.equal(server.revision, 2);
  assert.equal(requests.every(item => item.options.headers.Authorization === "Bearer test-token"), true);
  server.state.settings.units = "imperial";
  server.revision += 1;
  await repository.refresh();
  assert.equal((await repository.getState()).settings.units, "imperial");
});

test("remote repository calls the browser fetch with its required global context", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = function (url, options) {
    assert.equal(this, globalThis);
    called = true;
    return Promise.resolve({ ok: true, json: async () => ({ url, method: options.method || "GET" }) });
  };
  try {
    const repository = new RemoteRepository({}, { endpoint: "https://api.example", token: "test-token" });
    const result = await repository.request("/api/state");
    assert.equal(called, true);
    assert.equal(result.url, "https://api.example/api/state");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (error) { failed += 1; console.error(`✗ ${name}\n  ${error.stack}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} pruebas correctas.`);
  if (failed) process.exitCode = 1;
})();
