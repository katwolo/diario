// Envoltorio mínimo de IndexedDB: notas, libretas y archivos (audio/fotos).
const DB_NAME = 'diario';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('notebooks', { keyPath: 'id' });
        d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) =>
    run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};
