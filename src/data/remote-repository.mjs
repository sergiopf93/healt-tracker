export const REMOTE_CONFIG_KEY = "health-tracker:remote-config:v1";

export function readRemoteConfig(storage = globalThis.localStorage) {
  try {
    const config = JSON.parse(storage.getItem(REMOTE_CONFIG_KEY) || "null");
    if (!config || typeof config.endpoint !== "string" || typeof config.token !== "string") return null;
    return { endpoint: config.endpoint.replace(/\/$/, ""), token: config.token };
  } catch {
    return null;
  }
}

export class RemoteRepository {
  constructor(localRepository, { endpoint, token, fetcher = (...args) => globalThis.fetch(...args) }) {
    this.local = localRepository;
    this.endpoint = endpoint.replace(/\/$/, "");
    this.token = token;
    this.fetcher = fetcher;
    this.revision = null;
  }

  async request(path, options = {}) {
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "No se pudo sincronizar con el backend.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async connect() {
    const remote = await this.request("/api/state");
    this.revision = remote.revision;
    this.pendingImport = remote.pendingImport || null;
    if (remote.revision === 0) {
      const localState = await this.local.getState();
      await this.write(localState);
    } else {
      await this.local.replaceState(remote.state);
    }
  }

  async refresh() {
    const remote = await this.request("/api/state");
    this.revision = remote.revision;
    this.pendingImport = remote.pendingImport || null;
    await this.local.replaceState(remote.state);
    return remote.state;
  }

  async clearPendingImport() {
    const result = await this.request("/api/pending-import", {
      method: "DELETE",
      headers: { "If-Match": String(this.revision) }
    });
    this.revision = result.revision;
    this.pendingImport = result.pendingImport || null;
  }

  async write(state) {
    const result = await this.request("/api/state", {
      method: "PUT",
      headers: { "If-Match": String(this.revision) },
      body: JSON.stringify(state)
    });
    this.revision = result.revision;
    return result;
  }

  async mutate(method, ...args) {
    await this.refresh();
    const result = await this.local[method](...args);
    const localState = await this.local.getState();
    try {
      await this.write(localState);
      if (method === "deleteAll" && this.pendingImport) await this.clearPendingImport();
    } catch (error) {
      if (error.status === 409) {
        await this.refresh();
        error.message = "Otro dispositivo guardó cambios antes. Se ha actualizado la copia local; vuelve a aplicar tu cambio.";
      } else {
        error.message = `El cambio quedó en la copia local, pero no se sincronizó con el backend. ${error.message}`;
      }
      throw error;
    }
    return result;
  }

  getState() { return this.local.getState(); }
  createCycleWithBaseline(...args) { return this.mutate("createCycleWithBaseline", ...args); }
  saveMeasurement(...args) { return this.mutate("saveMeasurement", ...args); }
  deleteMeasurement(...args) { return this.mutate("deleteMeasurement", ...args); }
  closeCycle(...args) { return this.mutate("closeCycle", ...args); }
  deleteCycle(...args) { return this.mutate("deleteCycle", ...args); }
  importHealthData(...args) { return this.mutate("importHealthData", ...args); }
  saveSettings(...args) { return this.mutate("saveSettings", ...args); }
  deleteAll(...args) { return this.mutate("deleteAll", ...args); }
  close(...args) { return this.local.close(...args); }
}
