import { db } from './db.js';
import { api, getConfig, setConfig, isConfigured, getTombstones, addTombstone, clearTombstones, resetTombstones } from './sync.js';
import { recognize } from './ocr.js';
import { openCamera, closeCamera, cameraSupported } from './camera.js';

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const nav = $('#nav');

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
  check: '<path d="m6 12 4 4 8-9"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 10h8M8 14h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const TYPES = {
  note: { label: 'Nota', plural: 'Notas', icon: 'note' },
  task: { label: 'Tarea', plural: 'Tareas', icon: 'check' },
  event: { label: 'Evento', plural: 'Eventos', icon: 'calendar' },
  audio: { label: 'Grabación', plural: 'Audio', icon: 'mic' },
  photo: { label: 'Foto', plural: 'Fotos', icon: 'camera' },
};

const ITEM_DEFAULTS = {
  title: '', body: '', done: false, due: '', when: '', place: '',
  hasMedia: false, driveId: '', driveUrl: '', mime: '',
};

// ---------- Formato de fechas ----------
const fmtLong = (d) => d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDay = (s) => new Date(s + 'T00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const fmtDateTime = (d) =>
  new Date(d).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function fmtRel(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

// ---------- Almacenamiento local seguro ----------
const store = {
  get(k, def = '') { try { return localStorage.getItem(k) ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

// ---------- Estado ----------
let items = [];
let notebooks = [];
let query = '';
let filter = 'all';
let editingId = null;
let cameFromApp = false;
let rec = null;
let objectUrls = [];
const pending = new Map();
let saveTimer = null;
let autoCamera = null; // id de la foto nueva que abre la cámara al entrar

async function ensureNotebook() {
  if (notebooks.length) return;
  // Id fijo: así todos tus dispositivos comparten la misma libreta inicial.
  const nb = { id: 'principal', name: 'Primera libreta', createdAt: Date.now(), updatedAt: 0, dirty: true };
  await db.put('notebooks', nb);
  notebooks = [nb];
}

async function load() {
  [items, notebooks] = await Promise.all([db.all('items'), db.all('notebooks')]);
  await ensureNotebook();
}

function touch(it) {
  it.updatedAt = Date.now();
  it.dirty = true;
  pending.set(it.id, it);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
  scheduleSync();
}

async function flush() {
  clearTimeout(saveTimer);
  const list = [...pending.values()];
  pending.clear();
  await Promise.all(list.map((it) => db.put('items', it)));
}

async function saveNotebook(nb) {
  nb.updatedAt = Date.now();
  nb.dirty = true;
  await db.put('notebooks', nb);
  scheduleSync();
}

const isEmpty = (it) => !it.title.trim() && !it.body.trim() && !it.hasMedia;

async function removeItem(id, { tombstone = true } = {}) {
  const it = items.find((i) => i.id === id);
  if (tombstone && it && it.remote) addTombstone('items', id);
  items = items.filter((i) => i.id !== id);
  pending.delete(id);
  await Promise.all([db.del('items', id), db.del('blobs', id)]);
  if (tombstone) scheduleSync();
}

async function newItem(type, extra = {}) {
  const m = location.hash.match(/^#\/libreta\/(.+)$/);
  const now = Date.now();
  const it = {
    id: uid(), type, ...ITEM_DEFAULTS,
    notebookId: (m && m[1]) || notebooks[0].id,
    createdAt: now, updatedAt: now, dirty: true, ...extra,
  };
  items.push(it);
  await db.put('items', it);
  if (type === 'photo') autoCamera = it.id;
  cameFromApp = true;
  location.hash = `#/editar/${it.id}`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function ask(title, value = '') {
  const dlg = $('#dlg');
  $('#dlg-title').textContent = title;
  const input = $('#dlg-input');
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() || null : null), { once: true });
  });
}

function revokeUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

// Lee ancho, alto y orientación EXIF de un JPEG o PNG sin decodificar la imagen.
async function imageInfo(file) {
  const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const dv = new DataView(b.buffer);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20), orientation: 1 };
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    const len = dv.getUint16(i + 2);
    if (m === 0xe1 && dv.getUint32(i + 4) === 0x45786966) orientation = exifOrientation(dv, i + 10) || 1;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7), orientation };
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(dv, tiff) {
  try {
    const le = dv.getUint16(tiff) === 0x4949;
    const ifd = tiff + dv.getUint32(tiff + 4, le);
    for (let k = 0, n = dv.getUint16(ifd, le); k < n; k++) {
      const entry = ifd + 2 + k * 12;
      if (dv.getUint16(entry, le) === 0x0112) return dv.getUint16(entry + 8, le);
    }
  } catch { /* EXIF incompleto */ }
  return 0;
}

// Reduce fotos grandes del móvil: menos memoria, suben antes a Drive y el OCR va más rápido.
async function shrinkImage(file, max = 2000, quality = 0.85) {
  const info = await imageInfo(file).catch(() => null);
  if (info ? Math.max(info.w, info.h) <= max : file.size < 1.5e6) return file;
  // Se decodifica ya reducida: abrir una foto de 50 MP a tamaño completo puede agotar la memoria.
  // Solo se fija el ancho (el alto sale proporcional). Si la foto va girada por EXIF se usa
  // el lado corto, para que nunca pase de "max" sea cual sea el orden en que se gire y escale.
  let resizeWidth = Math.round(max * 0.75);
  if (info) {
    const scale = max / Math.max(info.w, info.h);
    resizeWidth = Math.round((info.orientation >= 5 ? Math.min(info.w, info.h) : info.w) * scale);
  }
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth, resizeQuality: 'high' });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', quality));
  } catch {
    return file;
  } finally {
    bmp?.close();
  }
}

// Abre la cámara dentro de la app; si no se puede, usa el selector del sistema.
async function capturePhoto(title, fallbackInput) {
  if (cameraSupported()) {
    try {
      return await openCamera({ title });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        toast('Permite el acceso a la cámara para hacer fotos');
        return null;
      }
    }
  }
  $(fallbackInput)?.click();
  return null;
}

async function savePhoto(it, file) {
  await db.put('blobs', await shrinkImage(file), it.id);
  it.hasMedia = true;
  it.driveId = '';
  it.driveUrl = '';
  if (!it.title) it.title = `Foto ${fmtDateTime(Date.now())}`;
  touch(it);
  await flush();
  if (editingId === it.id) renderEditor(it.id);
}

// ---------- Sincronización con Google Sheets y Drive ----------
let syncTimer = null;
let syncing = false;
let syncAgain = false;

function scheduleSync(delay = 4000) {
  if (!isConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

const stripLocal = ({ dirty, remote, hasMedia, ...rest }) => rest;

async function syncNow({ manual = false } = {}) {
  if (!isConfigured()) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { if (manual) toast('Sin conexión: se sincronizará más tarde'); return; }
  syncing = true;
  clearTimeout(syncTimer);
  updateSyncStatus('Sincronizando…');
  try {
    await flush();

    // 1. Fotos y grabaciones nuevas → carpeta de Drive
    for (const it of items) {
      if (!it.hasMedia || it.driveId) continue;
      const blob = await db.get('blobs', it.id);
      if (!blob) continue;
      const mime = (blob.type || 'application/octet-stream').split(';')[0];
      const ext = mime.split('/')[1] || 'bin';
      const base = (it.title || TYPES[it.type].label).replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'archivo';
      const up = await api('upload', { name: `${base}.${ext}`, mime, data: (await blobToDataUrl(blob)).split(',')[1] });
      Object.assign(it, { driveId: up.id, driveUrl: up.url, mime });
      touch(it);
    }
    await flush();

    // 2. Cambios de texto → hoja de cálculo
    const sentNbs = notebooks.filter((n) => n.dirty).map(stripLocal);
    const sentItems = items.filter((i) => i.dirty).map(stripLocal);
    const tombs = getTombstones();
    const res = await api('sync', {
      notebooks: [...sentNbs, ...tombs.filter((t) => t.kind === 'notebooks')],
      items: [...sentItems, ...tombs.filter((t) => t.kind === 'items')],
    });
    clearTombstones(tombs);

    const sentVersion = new Map([...sentNbs, ...sentItems].map((r) => [r.id, r.updatedAt]));
    for (const [store_, list] of [['notebooks', notebooks], ['items', items]]) {
      for (const r of list) {
        if (r.dirty && sentVersion.get(r.id) === r.updatedAt) {
          r.dirty = false;
          r.remote = true;
          await db.put(store_, r);
        }
      }
    }

    // 3. Lo que venga de la hoja (otros dispositivos o ediciones a mano)
    let changed = await mergeRemote('notebooks', res.notebooks || []);
    changed = (await mergeRemote('items', res.items || [])) || changed;
    await ensureNotebook();
    for (const it of items) {
      if (!notebooks.some((n) => n.id === it.notebookId)) {
        it.notebookId = notebooks[0].id;
        touch(it);
        changed = true;
      }
    }
    await flush();

    setConfig({ lastSync: Date.now(), lastError: '' });
    updateSyncStatus();
    if (manual) toast('Sincronizado con Google');
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (changed && !editingId && !typing) route({ keepScroll: true });
  } catch (err) {
    setConfig({ lastError: err.message });
    updateSyncStatus();
    if (manual) toast(err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(1000); }
  }
}

async function mergeRemote(kind, list) {
  let changed = false;
  for (const r of list) {
    const arr = kind === 'items' ? items : notebooks;
    const local = arr.find((x) => x.id === r.id);
    const localWins = local && local.dirty && local.updatedAt > r.updatedAt;
    if (r.deleted) {
      if (!local || localWins) continue;
      if (kind === 'items') await removeItem(r.id, { tombstone: false });
      else {
        notebooks = notebooks.filter((n) => n.id !== r.id);
        await db.del('notebooks', r.id);
      }
      changed = true;
      continue;
    }
    if (local) {
      local.remote = true;
      if (localWins || r.updatedAt <= local.updatedAt) continue;
      if (kind === 'items') {
        const hadUpload = Boolean(local.driveId);
        if (hadUpload && local.driveId !== r.driveId) await db.del('blobs', r.id);
        r.hasMedia = Boolean(r.driveId) || (local.hasMedia && !hadUpload);
      }
      Object.assign(local, r, { dirty: false });
      await db.put(kind, local);
    } else {
      const fresh = kind === 'items'
        ? { ...ITEM_DEFAULTS, ...r, hasMedia: Boolean(r.driveId), remote: true, dirty: false }
        : { ...r, remote: true, dirty: false };
      arr.push(fresh);
      await db.put(kind, fresh);
    }
    changed = true;
  }
  return changed;
}

function updateSyncStatus(text) {
  const el = $('#sync-status');
  if (!el) return;
  const c = getConfig();
  if (text) el.textContent = text;
  else if (!isConfigured()) el.textContent = 'Sin conectar: todo se guarda solo en este dispositivo.';
  else if (c.lastError) el.textContent = `Último intento falló: ${c.lastError}`;
  else if (c.lastSync) el.textContent = `Última sincronización: ${fmtRel(c.lastSync)}`;
  else el.textContent = 'Conectado, aún sin sincronizar.';
}

// ---------- OCR ----------
async function runOcr(it, image) {
  const status = $('#ocr-status');
  const show = (t) => status && editingId === it.id && (status.textContent = t);
  show('Preparando el reconocedor de texto…');
  try {
    const text = await recognize(await shrinkImage(image, 2500, 0.9), (p, stage) => {
      if (p != null) show(`Leyendo texto… ${Math.round(p * 100)} %`);
      else if (stage && stage.includes('load')) show('Descargando el idioma español (solo la primera vez)…');
    });
    if (!text) {
      show('');
      return toast('No se ha encontrado texto en la imagen');
    }
    it.body = it.body.trim() ? `${it.body.trimEnd()}\n\n${text}` : text;
    if (!it.title) it.title = text.split('\n')[0].slice(0, 60);
    touch(it);
    await flush();
    if (editingId === it.id) {
      const form = $('#ed');
      form.body.value = it.body;
      form.title.value = it.title;
    }
    show('');
    toast('Texto añadido a la nota');
  } catch (err) {
    show('');
    toast(err.message || 'No se pudo leer el texto');
  }
}

// ---------- Vistas ----------
function itemRow(it) {
  const nb = notebooks.find((n) => n.id === it.notebookId);
  let sub = (it.body || '').replace(/\s+/g, ' ').slice(0, 100);
  if (it.type === 'task' && it.due) sub = `Vence ${fmtDay(it.due)}${sub ? ' · ' + sub : ''}`;
  if (it.type === 'event' && it.when) sub = `${fmtDateTime(it.when)}${it.place ? ' · ' + it.place : ''}`;
  const lead =
    it.type === 'task'
      ? `<button class="tick" data-toggle="${it.id}" aria-label="${it.done ? 'Marcar pendiente' : 'Completar'}"><span class="box ${it.done ? 'on' : ''}">${it.done ? icon('check') : ''}</span></button>`
      : `<span class="type t-${it.type}">${icon(TYPES[it.type].icon)}</span>`;
  return `<li class="row ${it.done ? 'done' : ''}">${lead}
    <button class="row-main" data-open="${it.id}">
      <strong>${esc(it.title || 'Sin título')}</strong>
      ${sub ? `<span>${esc(sub)}</span>` : ''}
      <small>${esc(nb ? nb.name : '')} · ${fmtRel(it.updatedAt)}</small>
    </button></li>`;
}

const sorted = (list) => [...list].sort((a, b) => b.updatedAt - a.updatedAt);

function renderHome() {
  const recent = sorted(items).slice(0, 4);
  app.innerHTML = `
    <header class="top"><div class="avatar" aria-hidden="true">N</div></header>
    <section class="hero"><h1>Notes</h1><p class="date">${fmtLong(new Date())}</p></section>
    <form class="search" id="home-search" role="search">
      <input type="search" name="q" placeholder="Busca notas, tareas o documentos" aria-label="Buscar">
      <button aria-label="Buscar">${icon('search')}</button>
    </form>
    <div class="big-actions">
      <button class="big note" data-new="note">${icon('plus')}<span>Nota nueva</span><i class="deco"></i></button>
      <button class="big task" data-new="task">${icon('plus')}<span>Tarea nueva</span><i class="deco"></i></button>
    </div>
    <div class="small-actions">
      <button data-new="event">${icon('calendar')}<span>Evento</span></button>
      <button data-action="new-notebook">${icon('book')}<span>Libreta</span></button>
      <button data-new="audio">${icon('mic')}<span>Grabadora</span></button>
      <button data-new="photo">${icon('camera')}<span>Cámara</span></button>
    </div>
    <div class="section-head"><h2>Bloc de notas</h2><button class="link" data-action="scratch-to-note">Guardar como nota</button></div>
    <textarea class="scratch" id="scratch" placeholder="Empieza a escribir..." aria-label="Bloc de notas">${esc(store.get('diario.scratch'))}</textarea>
    ${recent.length ? `<div class="section-head"><h2>Recientes</h2><a class="link" href="#/notas">Ver todo</a></div><ul class="list">${recent.map(itemRow).join('')}</ul>` : ''}
  `;
  $('#scratch').addEventListener('input', (e) => store.set('diario.scratch', e.target.value));
  $('#home-search').addEventListener('submit', (e) => {
    e.preventDefault();
    query = e.target.q.value.trim();
    filter = 'all';
    location.hash = '#/notas';
  });
}

function matches(it) {
  if (filter !== 'all' && it.type !== filter) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return [it.title, it.body, it.place].some((f) => (f || '').toLowerCase().includes(q));
}

function renderList(notebookId) {
  const list = sorted(items.filter((it) => (!notebookId || it.notebookId === notebookId) && matches(it)));
  $('#count').textContent = `${list.length} ${list.length === 1 ? 'elemento' : 'elementos'}`;
  $('#list').innerHTML = list.length
    ? list.map(itemRow).join('')
    : `<li class="empty">${query ? 'Nada coincide con tu búsqueda.' : 'Aún no hay nada aquí. Pulsa ✎ para crear una nota.'}</li>`;
}

function renderNotes(notebookId) {
  const nb = notebookId && notebooks.find((n) => n.id === notebookId);
  if (notebookId && !nb) return void (location.hash = '#/libretas');
  const chips = [['all', 'Todo'], ...Object.entries(TYPES).map(([k, v]) => [k, v.plural])];
  app.innerHTML = `
    <div class="page-head">
      ${nb ? `<a class="icon-btn" href="#/libretas" aria-label="Volver">${icon('back')}</a>` : ''}
      <h1>${nb ? esc(nb.name) : 'Notas'}</h1>
      ${nb ? `<button class="icon-btn" data-action="rename-notebook" data-id="${nb.id}" aria-label="Renombrar">${icon('edit')}</button>
              <button class="icon-btn" data-action="delete-notebook" data-id="${nb.id}" aria-label="Eliminar libreta">${icon('trash')}</button>` : ''}
    </div>
    <form class="search" role="search" onsubmit="return false">
      <input type="search" id="q" placeholder="Buscar" value="${esc(query)}" aria-label="Buscar">${icon('search')}
    </form>
    <div class="chips">${chips.map(([k, l]) => `<button data-filter="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
    <p class="count" id="count"></p>
    <ul class="list" id="list"></ul>
  `;
  $('#q').addEventListener('input', (e) => {
    query = e.target.value.trim();
    renderList(notebookId);
  });
  app.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      app.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      renderList(notebookId);
    })
  );
  renderList(notebookId);
}

function renderNotebooks() {
  const counts = {};
  items.forEach((it) => (counts[it.notebookId] = (counts[it.notebookId] || 0) + 1));
  app.innerHTML = `
    <div class="page-head"><h1>Libretas</h1><button class="btn primary" data-action="new-notebook">${icon('plus')} Nueva</button></div>
    ${[...notebooks].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((nb) => `
      <a class="nb-row" href="#/libreta/${nb.id}">
        <span class="type">${icon('book')}</span><strong>${esc(nb.name)}</strong>
        <span class="count">${counts[nb.id] || 0}</span>
      </a>`).join('')}
  `;
}

function renderMore() {
  const cfg = getConfig();
  app.innerHTML = `
    <div class="page-head"><h1>Más</h1></div>

    <div class="section-head"><h2>Google Sheets y Drive</h2></div>
    <p class="prose">El texto se guarda en tu hoja de cálculo y las fotos y grabaciones en tu carpeta de Drive. Escribe tu clave (la propiedad TOKEN del script) para conectar este dispositivo.</p>
    <form id="sync-form" class="settings" autocomplete="off">
      <label class="field">URL de la aplicación web
        <input name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.url || '')}">
      </label>
      <label class="field">Clave (la misma que TOKEN en Codigo.gs)
        <input name="token" type="password" required value="${esc(cfg.token || '')}">
      </label>
      <div class="btn-row">
        <button class="btn primary">${icon('cloud')} Guardar y sincronizar</button>
        ${isConfigured() ? '<button type="button" class="btn danger" data-action="sync-off">Desconectar</button>' : ''}
      </div>
    </form>
    <p class="prose" id="sync-status"></p>

    <div class="section-head"><h2>Copia de seguridad</h2></div>
    <div class="stack">
      <button class="btn" data-action="export">Exportar copia (.json)</button>
      <label class="btn file-btn">Importar copia<input type="file" id="import" accept="application/json,.json"></label>
      <button class="btn danger" data-action="wipe">Borrar datos de este dispositivo</button>
    </div>

    <div class="section-head"><h2>Acerca de</h2></div>
    <p class="prose">Notes es un proyecto independiente de notas personales. No está afiliado, patrocinado ni respaldado por Evernote Corporation ni por ninguna otra empresa. El reconocimiento de texto usa Tesseract.js (licencia Apache 2.0) y funciona en tu propio dispositivo.</p>
  `;
  updateSyncStatus();
  $('#import').addEventListener('change', (e) => e.target.files[0] && importData(e.target.files[0]));
  $('#sync-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    const token = e.target.token.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('La URL debe ser la de tu script de Google (…/exec)');
    setConfig({ url, token, lastError: '' });
    // Primera vez: hay que subir todo lo que ya existe.
    if (!cfg.token) {
      items.forEach((i) => (i.dirty = true));
      notebooks.forEach((n) => (n.dirty = true));
    }
    await syncNow({ manual: true });
    if (location.hash === '#/mas') renderMore();
  });
}

function renderEditor(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return void (location.hash = '#/notas');
  editingId = id;
  revokeUrls();
  const nbOpts = notebooks
    .map((n) => `<option value="${n.id}" ${n.id === it.notebookId ? 'selected' : ''}>${esc(n.name)}</option>`)
    .join('');
  let extra = '';
  if (it.type === 'task') {
    extra = `<label class="field inline"><input type="checkbox" name="done" ${it.done ? 'checked' : ''}> Completada</label>
             <label class="field">Fecha límite<input type="date" name="due" value="${esc(it.due)}"></label>`;
  } else if (it.type === 'event') {
    extra = `<label class="field">Fecha y hora<input type="datetime-local" name="when" value="${esc(it.when)}"></label>
             <label class="field">Lugar<input name="place" value="${esc(it.place)}"></label>`;
  } else if (it.type === 'audio' || it.type === 'photo') {
    extra = `<div class="media" id="media"></div>`;
  }
  const ocrTools = it.type === 'note'
    ? `<div class="ed-tools">
         <button type="button" class="btn small" data-action="scan-text">${icon('scan')} Escanear texto</button>
         <label class="btn small file-btn">${icon('image')} Desde galería<input type="file" data-ocr accept="image/*"></label>
         <input type="file" data-ocr id="scan-fallback" accept="image/*" capture="environment" hidden>
       </div>`
    : '';
  app.innerHTML = `
    <form id="ed" autocomplete="off">
      <header class="ed-top">
        <button type="button" class="icon-btn" data-action="close" aria-label="Volver">${icon('back')}</button>
        <span class="ed-kind">${TYPES[it.type].label} en</span>
        <select name="notebookId" aria-label="Libreta">${nbOpts}</select>
        <button type="button" class="icon-btn" data-action="delete" data-id="${it.id}" aria-label="Eliminar">${icon('trash')}</button>
      </header>
      <input class="ed-title" name="title" placeholder="Título" value="${esc(it.title)}" aria-label="Título">
      ${extra}
      ${ocrTools}
      <p class="ed-meta" id="ocr-status" aria-live="polite"></p>
      <textarea class="ed-body" name="body" placeholder="${it.type === 'note' ? 'Empieza a escribir...' : 'Añade notas'}" aria-label="Contenido">${esc(it.body)}</textarea>
      <p class="ed-meta">Creado ${fmtDateTime(it.createdAt)}</p>
    </form>
  `;
  const form = $('#ed');
  const onChange = (e) => {
    if (e.target.matches('input[type=file]')) return;
    it.title = form.title.value;
    it.body = form.body.value;
    it.notebookId = form.notebookId.value;
    if (form.done) it.done = form.done.checked;
    if (form.due) it.due = form.due.value;
    if (form.when) it.when = form.when.value;
    if (form.place) it.place = form.place.value;
    touch(it);
  };
  form.addEventListener('input', onChange);
  form.addEventListener('change', onChange);
  form.addEventListener('submit', (e) => e.preventDefault());
  form.querySelectorAll('[data-ocr]').forEach((input) =>
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      if (file) runOcr(it, file);
    })
  );
  if ($('#media')) renderMedia(it);
  if (it.type === 'note' && !it.title && !it.body) form.body.focus();
}

async function renderMedia(it) {
  const box = $('#media');
  if (it.hasMedia) {
    let blob = await db.get('blobs', it.id);
    if (!blob && it.driveId && isConfigured()) {
      box.innerHTML = '<p class="prose">Descargando desde Drive…</p>';
      try {
        const f = await api('file', { id: it.driveId });
        blob = await (await fetch(`data:${f.mime};base64,${f.data}`)).blob();
        await db.put('blobs', blob, it.id);
      } catch (err) {
        box.innerHTML = '';
        toast(err.message);
      }
    }
    if (editingId !== it.id) return;
    if (blob) {
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      box.innerHTML = it.type === 'audio' ? `<audio controls src="${url}"></audio>` : `<img src="${url}" alt="${esc(it.title || 'Foto')}">`;
    } else if (it.driveUrl) {
      box.innerHTML = `<a class="btn" href="${esc(it.driveUrl)}" target="_blank" rel="noopener">${icon('cloud')} Abrir en Drive</a>`;
    }
    if (it.driveUrl) box.insertAdjacentHTML('beforeend', `<p class="prose">${icon('cloud')} Guardado en tu Drive</p>`);
  }
  if (it.type === 'audio') {
    if (!it.hasMedia) {
      box.innerHTML = rec && rec.id === it.id
        ? `<button type="button" class="rec-btn on" data-action="rec-stop">Detener <span id="rec-time">0:00</span></button>`
        : `<button type="button" class="rec-btn" data-action="rec-start">${icon('mic')} Empezar a grabar</button>`;
    }
    return;
  }
  box.insertAdjacentHTML('beforeend', `
    <div class="btn-row">
      <button type="button" class="btn" data-action="take-photo">${icon('camera')} ${it.hasMedia ? 'Repetir foto' : 'Hacer foto'}</button>
      <label class="btn file-btn">${icon('image')} Galería<input type="file" data-photo accept="image/*"></label>
      <input type="file" data-photo id="photo-fallback" accept="image/*" capture="environment" hidden>
      ${it.hasMedia ? `<button type="button" class="btn" data-action="ocr-photo">${icon('scan')} Extraer texto</button>` : ''}
    </div>`);
  box.querySelectorAll('[data-photo]').forEach((input) =>
    input.addEventListener('change', () => {
      const file = input.files[0];
      input.value = '';
      if (file) savePhoto(it, file);
    })
  );
  if (autoCamera === it.id) {
    autoCamera = null;
    runAction('take-photo');
  }
}

// ---------- Grabadora ----------
async function startRecording(it) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    return toast('Este navegador no permite grabar audio');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('No se pudo acceder al micrófono');
  }
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(rec.timer);
    rec = null;
    await db.put('blobs', new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), it.id);
    it.hasMedia = true;
    if (!it.title) it.title = `Grabación ${fmtDateTime(it.createdAt)}`;
    touch(it);
    await flush();
    if (editingId === it.id) renderEditor(it.id);
  };
  const start = Date.now();
  rec = {
    id: it.id, mr,
    timer: setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      const el = $('#rec-time');
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500),
  };
  mr.start();
  renderMedia(it);
}

// ---------- Copias de seguridad ----------
async function exportData() {
  await flush();
  const blobs = {};
  for (const it of items) {
    if (!it.hasMedia) continue;
    const b = await db.get('blobs', it.id);
    if (b) blobs[it.id] = await blobToDataUrl(b);
  }
  const data = {
    app: 'diario', version: 1, exportedAt: new Date().toISOString(),
    notebooks: notebooks.map(stripLocal), items: items.map(({ dirty, remote, ...rest }) => rest),
    blobs, scratch: store.get('diario.scratch'),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `notes-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'diario' || !Array.isArray(data.items) || !Array.isArray(data.notebooks)) throw new Error();
    for (const nb of data.notebooks) await db.put('notebooks', { updatedAt: nb.createdAt || 0, ...nb, dirty: true });
    for (const it of data.items) await db.put('items', { ...ITEM_DEFAULTS, ...it, dirty: true });
    for (const [id, url] of Object.entries(data.blobs || {})) await db.put('blobs', await (await fetch(url)).blob(), id);
    if (data.scratch && !store.get('diario.scratch')) store.set('diario.scratch', data.scratch);
    await load();
    toast(`Importados ${data.items.length} elementos`);
    scheduleSync(500);
    location.hash = '#/notas';
  } catch {
    toast('El archivo no es una copia válida de Notes');
  }
}

// ---------- Acciones ----------
app.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-toggle],[data-action]');
  if (!t) return;
  if (t.dataset.open) {
    cameFromApp = true;
    location.hash = `#/editar/${t.dataset.open}`;
  } else if (t.dataset.toggle) {
    const it = items.find((i) => i.id === t.dataset.toggle);
    it.done = !it.done;
    touch(it);
    route({ keepScroll: true });
  } else {
    await runAction(t.dataset.action, t.dataset.id);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-new]');
  if (t) newItem(t.dataset.new);
});

function leaveEditor() {
  if (cameFromApp && history.length > 1) history.back();
  else location.replace('#/notas');
}

async function runAction(action, id) {
  const it = editingId && items.find((i) => i.id === editingId);
  switch (action) {
    case 'close':
      leaveEditor();
      break;
    case 'delete':
      if (!confirm('¿Eliminar este elemento?')) return;
      await removeItem(id);
      editingId = null;
      toast('Eliminado');
      leaveEditor();
      break;
    case 'rec-start':
      if (it) startRecording(it);
      break;
    case 'rec-stop':
      if (rec) rec.mr.stop();
      break;
    case 'take-photo': {
      if (!it) return;
      const blob = await capturePhoto(it.hasMedia ? 'Repetir foto' : 'Hacer foto', '#photo-fallback');
      if (blob) await savePhoto(it, blob);
      break;
    }
    case 'scan-text': {
      if (!it) return;
      const blob = await capturePhoto('Escanear texto', '#scan-fallback');
      if (blob) runOcr(it, blob);
      break;
    }
    case 'ocr-photo': {
      const blob = it && (await db.get('blobs', it.id));
      if (blob) runOcr(it, blob);
      break;
    }
    case 'scratch-to-note': {
      const text = store.get('diario.scratch').trim();
      if (!text) return toast('El bloc de notas está vacío');
      const [first, ...rest] = text.split('\n');
      store.set('diario.scratch', '');
      await newItem('note', { title: first.slice(0, 80), body: first.length > 80 ? text : rest.join('\n').trim() });
      break;
    }
    case 'new-notebook': {
      const name = await ask('Nueva libreta');
      if (!name) return;
      const nb = { id: uid(), name, createdAt: Date.now() };
      notebooks.push(nb);
      await saveNotebook(nb);
      location.hash = `#/libreta/${nb.id}`;
      break;
    }
    case 'rename-notebook': {
      const nb = notebooks.find((n) => n.id === id);
      const name = await ask('Renombrar libreta', nb.name);
      if (!name) return;
      nb.name = name;
      await saveNotebook(nb);
      route({ keepScroll: true });
      break;
    }
    case 'delete-notebook': {
      if (notebooks.length === 1) return toast('Necesitas al menos una libreta');
      const inside = items.filter((i) => i.notebookId === id);
      const msg = inside.length ? `Se eliminarán también ${inside.length} elemento(s). ¿Continuar?` : '¿Eliminar esta libreta?';
      if (!confirm(msg)) return;
      for (const i of inside) await removeItem(i.id);
      const nb = notebooks.find((n) => n.id === id);
      if (nb && nb.remote) addTombstone('notebooks', id);
      await db.del('notebooks', id);
      notebooks = notebooks.filter((n) => n.id !== id);
      scheduleSync();
      location.hash = '#/libretas';
      break;
    }
    case 'sync-off':
      if (!confirm('¿Dejar de sincronizar este dispositivo? Tus datos en Google no se borran.')) return;
      setConfig({ token: '', lastSync: 0, lastError: '' });
      renderMore();
      break;
    case 'export':
      exportData();
      break;
    case 'wipe':
      if (!confirm('Se borrarán las notas, tareas, libretas y archivos de este dispositivo. Lo guardado en Google no se toca. ¿Seguro?')) return;
      await Promise.all(['items', 'notebooks', 'blobs'].map((s) => db.clear(s)));
      store.set('diario.scratch', '');
      resetTombstones();
      await load();
      toast('Datos del dispositivo borrados');
      location.hash = '#/crear';
      break;
  }
}

// ---------- Router ----------
async function route(opts) {
  const keepScroll = opts && opts.keepScroll;
  const [, view = 'crear', arg] = location.hash.split('/');
  closeCamera();

  if (editingId && !(view === 'editar' && arg === editingId)) {
    const prev = items.find((i) => i.id === editingId);
    const recording = rec && rec.id === editingId;
    editingId = null;
    revokeUrls();
    await flush();
    if (prev && isEmpty(prev) && !recording) await removeItem(prev.id);
  }

  if (view !== 'editar') cameFromApp = false;
  nav.classList.toggle('hidden', view === 'editar');
  const tab = view === 'libreta' ? 'libretas' : view;
  nav.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (view !== 'editar' && !keepScroll) window.scrollTo(0, 0);

  switch (view) {
    case 'notas': return renderNotes();
    case 'libretas': return renderNotebooks();
    case 'libreta': return renderNotes(arg);
    case 'mas': return renderMore();
    case 'editar': return renderEditor(arg);
    default: return renderHome();
  }
}

window.addEventListener('hashchange', () => route());
window.addEventListener('pagehide', flush);
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush().then(() => syncNow());
  else scheduleSync(500);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load().then(() => {
  route();
  scheduleSync(1000);
});
