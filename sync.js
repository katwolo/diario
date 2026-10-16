// Conexión con el script de Google (Codigo.gs): configuración, llamadas y borrados pendientes.
const CFG_KEY = 'diario.sync';
const TOMB_KEY = 'diario.tombstones';

function readJson(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

// URL de la aplicación web de Apps Script (Codigo.gs). La clave no va aquí: se escribe en la app.
export const DEFAULT_URL =
  'https://script.google.com/macros/s/AKfycbyLtp8_X_a7VLe6yHjVeOZXZ5JeKuhz6oF8CXTBW9o-lEYvxOShypjobtiszYtxYllA/exec';

export const getConfig = () => {
  const c = readJson(CFG_KEY, {});
  return { ...c, url: c.url || DEFAULT_URL };
};
export const setConfig = (patch) => writeJson(CFG_KEY, { ...getConfig(), ...patch });
export const isConfigured = () => {
  const c = getConfig();
  return Boolean(c.url && c.token);
};

export async function api(action, payload = {}) {
  const { url, token } = getConfig();
  if (!url) throw new Error('Falta la URL del script');
  let res;
  try {
    // Sin cabeceras propias: así el navegador no hace petición previa CORS y Apps Script la acepta.
    res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, token, ...payload }) });
  } catch {
    throw new Error('No hay conexión con Google');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Respuesta no válida: revisa la URL y que el script esté implementado para "Cualquier usuario"');
  }
  if (!data.ok) throw new Error(data.error || 'Error del servidor');
  return data;
}

// Borrados que aún hay que comunicar a la hoja.
export const getTombstones = () => readJson(TOMB_KEY, []);
export function addTombstone(kind, id) {
  writeJson(TOMB_KEY, [...getTombstones().filter((t) => t.id !== id), { kind, id, deleted: true, updatedAt: Date.now() }]);
}
export function clearTombstones(sent) {
  const ids = new Set(sent.map((t) => t.id));
  writeJson(TOMB_KEY, getTombstones().filter((t) => !ids.has(t.id)));
}
export const resetTombstones = () => writeJson(TOMB_KEY, []);
