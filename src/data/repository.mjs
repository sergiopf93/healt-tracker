import { SCHEMA_VERSION, createId, cycleWeek, todayLocalDate } from "../domain.mjs";

const DATABASE_NAME = "health-tracker-local";
const DATABASE_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo leer el almacenamiento local."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el cambio."));
    transaction.onabort = () => reject(transaction.error || new Error("El cambio se canceló."));
  });
}

export function openDatabase(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error("Este navegador no permite almacenamiento local. Prueba Safari o un navegador actualizado."));
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("cycles")) db.createObjectStore("cycles", { keyPath: "id" });
      if (!db.objectStoreNames.contains("measurements")) {
        const measurements = db.createObjectStore("measurements", { keyPath: "id" });
        measurements.createIndex("cycleId", "cycleId", { unique: false });
        measurements.createIndex("date", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error("No se pudo abrir la base de datos local."));
    request.onblocked = () => reject(new Error("Cierra otras pestañas de Health Tracker para actualizar el almacenamiento."));
  });
}

export class LocalRepository {
  constructor(db) {
    this.db = db;
  }

  async getAll(storeName) {
    const tx = this.db.transaction(storeName, "readonly");
    return requestResult(tx.objectStore(storeName).getAll());
  }

  async getState() {
    const [cycles, measurements, settings] = await Promise.all([
      this.getAll("cycles"), this.getAll("measurements"), this.getAll("settings")
    ]);
    return {
      cycles: cycles.sort((a, b) => b.startDate.localeCompare(a.startDate)),
      measurements: measurements.sort((a, b) => a.date.localeCompare(b.date)),
      settings: (settings.find(item => item.key === "preferences") || {}).value || { units: "metric" }
    };
  }

  createCycleWithBaseline(cycle, measurement) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["cycles", "measurements"], "readwrite");
      let failure = null;
      const cycles = tx.objectStore("cycles");
      const request = cycles.getAll();
      request.onsuccess = () => {
        if (request.result.some(item => item.status === "active")) {
          failure = new Error("Ya existe un ciclo activo. Ciérralo antes de crear otro.");
          tx.abort();
          return;
        }
        cycles.add(cycle);
        tx.objectStore("measurements").add(measurement);
      };
      request.onerror = () => { failure = request.error; tx.abort(); };
      tx.oncomplete = () => resolve({ cycle, measurement });
      tx.onabort = () => reject(failure || tx.error || new Error("No se pudo crear el ciclo."));
      tx.onerror = () => reject(failure || tx.error || new Error("No se pudo crear el ciclo."));
    });
  }

  async saveMeasurement(measurement) {
    const tx = this.db.transaction("measurements", "readwrite");
    tx.objectStore("measurements").put(measurement);
    await transactionDone(tx);
    return measurement;
  }

  async closeCycle(cycleId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("cycles", "readwrite");
      let updated = null;
      let failure = null;
      const store = tx.objectStore("cycles");
      const request = store.get(cycleId);
      request.onsuccess = () => {
        if (!request.result) {
          failure = new Error("No se encontró el ciclo.");
          tx.abort();
          return;
        }
        updated = { ...request.result, status: "completed", closedAt: todayLocalDate() };
        store.put(updated);
      };
      request.onerror = () => { failure = request.error; tx.abort(); };
      tx.oncomplete = () => resolve(updated);
      tx.onabort = () => reject(failure || tx.error || new Error("No se pudo cerrar el ciclo."));
      tx.onerror = () => reject(failure || tx.error || new Error("No se pudo cerrar el ciclo."));
    });
  }

  async deleteCycle(cycleId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["cycles", "measurements"], "readwrite");
      const cycles = tx.objectStore("cycles");
      const measurements = tx.objectStore("measurements");
      let failure = null;
      const cycleRequest = cycles.get(cycleId);
      const measurementRequest = measurements.index("cycleId").getAll(cycleId);
      cycleRequest.onsuccess = () => {
        const cycle = cycleRequest.result;
        if (!cycle || cycle.status === "active") {
          failure = new Error(cycle ? "Solo se pueden eliminar ciclos cerrados." : "No se encontró el ciclo.");
          tx.abort();
          return;
        }
        cycles.delete(cycleId);
        if (measurementRequest.readyState === "done") measurementRequest.result.forEach(item => measurements.delete(item.id));
        else measurementRequest.onsuccess = () => measurementRequest.result.forEach(item => measurements.delete(item.id));
      };
      cycleRequest.onerror = () => { failure = cycleRequest.error; tx.abort(); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure || tx.error || new Error("No se pudo eliminar el ciclo."));
      tx.onerror = () => reject(failure || tx.error || new Error("No se pudo eliminar el ciclo."));
    });
  }

  async replaceState(state) {
    const tx = this.db.transaction(["cycles", "measurements", "settings"], "readwrite");
    const cycles = tx.objectStore("cycles");
    const measurements = tx.objectStore("measurements");
    const settings = tx.objectStore("settings");
    cycles.clear();
    measurements.clear();
    settings.clear();
    state.cycles.forEach(cycle => cycles.put(cycle));
    state.measurements.forEach(measurement => measurements.put(measurement));
    settings.put({ key: "preferences", value: state.settings || { units: "metric" } });
    await transactionDone(tx);
  }

  importHealthData(imported) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["cycles", "measurements"], "readwrite");
      let failure = null;
      let outcome = null;
      const cycleStore = tx.objectStore("cycles");
      const cycleRequest = cycleStore.getAll();
      cycleRequest.onsuccess = () => {
        const cycle = cycleRequest.result
          .filter(item => item.startDate <= imported.date && cycleWeek(item.startDate, imported.date) <= (item.plannedWeeks || 16) && (item.status === "active" || !item.closedAt || imported.date <= item.closedAt))
          .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
        if (!cycle) {
          failure = new Error("No hay un ciclo que incluya la fecha de estos datos. Crea el ciclo antes de importarlos.");
          tx.abort();
          return;
        }
        const measurementStore = tx.objectStore("measurements");
        const index = measurementStore.index("cycleId");
        const measurementRequest = index.getAll(cycle.id);
        measurementRequest.onsuccess = () => {
          let measurement = measurementRequest.result.find(item => item.date === imported.date);
          const created = !measurement;
          if (!measurement) measurement = {
            id: createId("measurement"), cycleId: cycle.id, date: imported.date,
            observations: {}, resolutions: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          };
          let added = 0;
          let duplicates = 0;
          const conflicts = [];
          for (const observation of imported.observations) {
            const list = measurement.observations[observation.metric] || (measurement.observations[observation.metric] = []);
            if (list.some(item => item.fingerprint && item.fingerprint === observation.fingerprint)) {
              duplicates += 1;
              continue;
            }
            if (list.some(item => Math.abs(item.value - observation.value) > 1e-7)) conflicts.push(observation.metric);
            list.push(observation);
            added += 1;
          }
          if (added) {
            measurement.updatedAt = new Date().toISOString();
            measurementStore.put(measurement);
          }
          outcome = { cycle, measurement, created, added, duplicates, conflicts: [...new Set(conflicts)] };
        };
        measurementRequest.onerror = () => { failure = measurementRequest.error; tx.abort(); };
      };
      cycleRequest.onerror = () => { failure = cycleRequest.error; tx.abort(); };
      tx.oncomplete = () => resolve(outcome);
      tx.onabort = () => reject(failure || tx.error || new Error("La importación no se pudo guardar."));
      tx.onerror = () => reject(failure || tx.error || new Error("La importación no se pudo guardar."));
    });
  }

  async saveSettings(settings) {
    const tx = this.db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key: "preferences", value: settings });
    await transactionDone(tx);
  }

  async deleteAll() {
    const tx = this.db.transaction(["cycles", "measurements", "settings"], "readwrite");
    tx.objectStore("cycles").clear();
    tx.objectStore("measurements").clear();
    tx.objectStore("settings").clear();
    await transactionDone(tx);
  }

  async close() {
    this.db.close();
  }
}

export async function createRepository(factory = globalThis.indexedDB) {
  return new LocalRepository(await openDatabase(factory));
}

export function makeExport(state) {
  return {
    format: "health-tracker-backup",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ...state
  };
}
