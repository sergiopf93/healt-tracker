import { parseHealthData } from "../src/integrations/apple-health/parser.mjs";
const EMPTY_STATE = { cycles: [], measurements: [], settings: { units: "metric" } };
const MAX_STATE_BYTES = 1_000_000;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.APP_ORIGIN;
  if (origin && allowed && origin !== allowed) return {};
  return origin ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  } : {};
}

function authorized(request, env) {
  const value = request.headers.get("Authorization") || "";
  return Boolean(env.HEALTH_TRACKER_API_KEY && value === `Bearer ${env.HEALTH_TRACKER_API_KEY}`);
}

function validState(state) {
  return Boolean(state && typeof state === "object" && !Array.isArray(state)
    && Array.isArray(state.cycles) && Array.isArray(state.measurements)
    && state.measurements.length <= 10000 && state.cycles.length <= 1000
    && state.settings && typeof state.settings === "object");
}

async function readState(db) {
  const row = await db.prepare("SELECT revision, payload, pending_import FROM health_state WHERE id = 1").first();
  return row
    ? { revision: row.revision, state: JSON.parse(row.payload), pendingImport: row.pending_import ? JSON.parse(row.pending_import) : null }
    : { revision: 0, state: structuredClone(EMPTY_STATE), pendingImport: null };
}

async function storeState(db, state, expectedRevision) {
  const result = await db.prepare(`
    INSERT INTO health_state (id, revision, payload, pending_import, updated_at)
    VALUES (1, 1, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision = health_state.revision + 1,
      payload = excluded.payload,
      updated_at = excluded.updated_at
    WHERE health_state.revision = ?
  `).bind(JSON.stringify(state), new Date().toISOString(), expectedRevision).run();
  return result.meta && result.meta.changes === 1;
}

async function storePendingImport(db, imported, expectedRevision) {
  const result = await db.prepare(`
    INSERT INTO health_state (id, revision, payload, pending_import, updated_at)
    VALUES (1, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision = health_state.revision + 1,
      pending_import = excluded.pending_import,
      updated_at = excluded.updated_at
    WHERE health_state.revision = ? AND health_state.pending_import IS NULL
  `).bind(JSON.stringify(EMPTY_STATE), JSON.stringify(imported), new Date().toISOString(), expectedRevision).run();
  return result.meta && result.meta.changes === 1;
}

async function clearPendingImport(db, expectedRevision) {
  const result = await db.prepare(`
    UPDATE health_state SET revision = revision + 1, pending_import = NULL, updated_at = ?
    WHERE id = 1 AND revision = ? AND pending_import IS NOT NULL
  `).bind(new Date().toISOString(), expectedRevision).run();
  return result.meta && result.meta.changes === 1;
}

async function readJson(request, limit) {
  const declaredSize = Number(request.headers.get("Content-Length") || 0);
  if (declaredSize > limit) throw new Error("La solicitud supera el tamaño permitido.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) throw new Error("La solicitud supera el tamaño permitido.");
  try { return JSON.parse(text); }
  catch { throw new Error("El contenido JSON no es válido."); }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!authorized(request, env)) return json({ error: "No autorizado." }, 401, headers);
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await readState(env.DB), 200, headers);
      }
      if (url.pathname === "/api/pending-import" && request.method === "DELETE") {
        const expectedRevision = Number(request.headers.get("If-Match"));
        const current = await readState(env.DB);
        if (current.revision !== expectedRevision) return json({ error: "La importación cambió mientras se procesaba." }, 409, headers);
        if (current.pendingImport && !await clearPendingImport(env.DB, expectedRevision)) return json({ error: "La importación cambió mientras se procesaba." }, 409, headers);
        return json(await readState(env.DB), 200, headers);
      }
      if (url.pathname === "/api/state" && request.method === "PUT") {
        const state = await readJson(request, MAX_STATE_BYTES);
        if (!validState(state)) return json({ error: "El estado enviado no tiene un formato válido." }, 400, headers);
        const expectedRevision = Number(request.headers.get("If-Match"));
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return json({ error: "Falta la revisión esperada del estado." }, 400, headers);
        if (!await storeState(env.DB, state, expectedRevision)) return json({ error: "Los datos cambiaron en otro dispositivo. La copia local se ha actualizado; vuelve a intentar el cambio." }, 409, headers);
        return json(await readState(env.DB), 200, headers);
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        const payload = await readJson(request, 32_768);
        const imported = parseHealthData(JSON.stringify(payload));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await readState(env.DB);
          if (current.pendingImport) return json({ error: "Ya hay una importación pendiente. Vuelve a la app para recibirla antes de iniciar otra." }, 409, headers);
          if (await storePendingImport(env.DB, imported, current.revision)) {
            const stored = await readState(env.DB);
            return json({ status: "pending", date: imported.date, observations: imported.observations.length, revision: stored.revision }, 200, headers);
          }
        }
        return json({ error: "El estado está cambiando desde otro dispositivo. Inténtalo de nuevo." }, 409, headers);
      }
      return json({ error: "Ruta no encontrada." }, 404, headers);
    } catch (error) {
      return json({ error: error.message || "No se pudo procesar la solicitud." }, 400, headers);
    }
  }
};
