import { db } from './db.js';

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

async function load() {
  [items, notebooks] = await Promise.all([db.all('items'), db.all('notebooks')]);
  if (!notebooks.length) {
    const nb = { id: uid(), name: 'Primera libreta', createdAt: Date.now() };
    await db.put('notebooks', nb);
    notebooks = [nb];
  }
}

function touch(it) {
  it.updatedAt = Date.now();
  pending.set(it.id, it);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  const list = [...pending.values()];
  pending.clear();
  await Promise.all(list.map((it) => db.put('items', it)));
}

const isEmpty = (it) => !it.title.trim() && !it.body.trim() && !it.hasMedia;

async function removeItem(id) {
  items = items.filter((i) => i.id !== id);
  pending.delete(id);
  await Promise.all([db.del('items', id), db.del('blobs', id)]);
}

async function newItem(type, extra = {}) {
  const m = location.hash.match(/^#\/libreta\/(.+)$/);
  const now = Date.now();
  const it = {
    id: uid(), type, title: '', body: '',
    notebookId: (m && m[1]) || notebooks[0].id,
    done: false, due: '', when: '', place: '', hasMedia: false,
    createdAt: now, updatedAt: now, ...extra,
  };
  items.push(it);
  await db.put('items', it);
  cameFromApp = true;
  location.hash = `#/editar/${it.id}`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
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
    <header class="top"><div class="avatar" aria-hidden="true">D</div></header>
    <section class="hero"><h1>Mi Diario</h1><p class="date">${fmtLong(new Date())}</p></section>
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
      <a class="nb-row" href="#/libreta/${nb.id}" style="color:inherit;text-decoration:none">
        <span class="type">${icon('book')}</span><strong>${esc(nb.name)}</strong>
        <span class="count">${counts[nb.id] || 0}</span>
      </a>`).join('')}
  `;
}

function renderMore() {
  app.innerHTML = `
    <div class="page-head"><h1>Más</h1></div>
    <div class="section-head"><h2>Tus datos</h2></div>
    <p class="prose">Todo se guarda solo en este dispositivo. Haz copias de seguridad de vez en cuando.</p>
    <div class="stack">
      <button class="btn" data-action="export">Exportar copia (.json)</button>
      <label class="btn file-btn">Importar copia<input type="file" id="import" accept="application/json,.json"></label>
      <button class="btn danger" data-action="wipe">Borrar todos los datos</button>
    </div>
    <div class="section-head"><h2>Acerca de</h2></div>
    <p class="prose">Diario es un proyecto independiente de notas personales. No está afiliado, patrocinado ni respaldado por Evernote Corporation ni por ninguna otra empresa.</p>
  `;
  $('#import').addEventListener('change', (e) => e.target.files[0] && importData(e.target.files[0]));
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
      <textarea class="ed-body" name="body" placeholder="${it.type === 'note' ? 'Empieza a escribir...' : 'Añade notas'}" aria-label="Contenido">${esc(it.body)}</textarea>
      <p class="ed-meta">Creado ${fmtDateTime(it.createdAt)}</p>
    </form>
  `;
  const form = $('#ed');
  const onChange = () => {
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
  if ($('#media')) renderMedia(it);
  if (it.type === 'note' && !it.title && !it.body) form.body.focus();
}

async function renderMedia(it) {
  const box = $('#media');
  if (it.hasMedia) {
    const blob = await db.get('blobs', it.id);
    if (!blob || editingId !== it.id) return;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    box.innerHTML = it.type === 'audio' ? `<audio controls src="${url}"></audio>` : `<img src="${url}" alt="${esc(it.title || 'Foto')}">`;
  }
  if (it.type === 'audio') {
    if (!it.hasMedia) {
      box.innerHTML = rec && rec.id === it.id
        ? `<button type="button" class="rec-btn on" data-action="rec-stop">Detener <span id="rec-time">0:00</span></button>`
        : `<button type="button" class="rec-btn" data-action="rec-start">${icon('mic')} Empezar a grabar</button>`;
    }
  } else {
    box.insertAdjacentHTML('beforeend', `
      <label class="btn file-btn">${icon('camera')} ${it.hasMedia ? 'Cambiar foto' : 'Hacer o elegir foto'}
        <input type="file" id="photo-input" accept="image/*" capture="environment">
      </label>`);
    $('#photo-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await db.put('blobs', file, it.id);
      it.hasMedia = true;
      if (!it.title) it.title = `Foto ${fmtDateTime(Date.now())}`;
      touch(it);
      await flush();
      renderEditor(it.id);
    });
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
const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function exportData() {
  await flush();
  const blobs = {};
  for (const it of items) {
    if (!it.hasMedia) continue;
    const b = await db.get('blobs', it.id);
    if (b) blobs[it.id] = await blobToDataUrl(b);
  }
  const data = { app: 'diario', version: 1, exportedAt: new Date().toISOString(), notebooks, items, blobs, scratch: store.get('diario.scratch') };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `diario-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'diario' || !Array.isArray(data.items) || !Array.isArray(data.notebooks)) throw new Error();
    for (const nb of data.notebooks) await db.put('notebooks', nb);
    for (const it of data.items) await db.put('items', it);
    for (const [id, url] of Object.entries(data.blobs || {})) await db.put('blobs', await (await fetch(url)).blob(), id);
    if (data.scratch && !store.get('diario.scratch')) store.set('diario.scratch', data.scratch);
    await load();
    toast(`Importados ${data.items.length} elementos`);
    location.hash = '#/notas';
  } catch {
    toast('El archivo no es una copia válida de Diario');
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
    route();
  } else {
    await runAction(t.dataset.action, t.dataset.id);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-new]');
  if (t) newItem(t.dataset.new);
});

async function runAction(action, id) {
  const it = editingId && items.find((i) => i.id === editingId);
  switch (action) {
    case 'close':
      if (cameFromApp && history.length > 1) history.back();
      else location.replace('#/notas');
      break;
    case 'delete':
      if (!confirm('¿Eliminar este elemento?')) return;
      await removeItem(id);
      editingId = null;
      toast('Eliminado');
      if (cameFromApp && history.length > 1) history.back();
      else location.replace('#/notas');
      break;
    case 'rec-start':
      if (it) startRecording(it);
      break;
    case 'rec-stop':
      if (rec) rec.mr.stop();
      break;
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
      await db.put('notebooks', nb);
      notebooks.push(nb);
      location.hash = `#/libreta/${nb.id}`;
      break;
    }
    case 'rename-notebook': {
      const nb = notebooks.find((n) => n.id === id);
      const name = await ask('Renombrar libreta', nb.name);
      if (!name) return;
      nb.name = name;
      await db.put('notebooks', nb);
      route();
      break;
    }
    case 'delete-notebook': {
      if (notebooks.length === 1) return toast('Necesitas al menos una libreta');
      const inside = items.filter((i) => i.notebookId === id);
      const msg = inside.length ? `Se eliminarán también ${inside.length} elemento(s). ¿Continuar?` : '¿Eliminar esta libreta?';
      if (!confirm(msg)) return;
      for (const i of inside) await removeItem(i.id);
      await db.del('notebooks', id);
      notebooks = notebooks.filter((n) => n.id !== id);
      location.hash = '#/libretas';
      break;
    }
    case 'export':
      exportData();
      break;
    case 'wipe':
      if (!confirm('Esto borrará todas tus notas, tareas, libretas y archivos. ¿Seguro?')) return;
      await Promise.all(['items', 'notebooks', 'blobs'].map((s) => db.clear(s)));
      store.set('diario.scratch', '');
      await load();
      toast('Datos borrados');
      location.hash = '#/crear';
      break;
  }
}

// ---------- Router ----------
async function route() {
  const [, view = 'crear', arg] = location.hash.split('/');

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
  if (view !== 'editar') window.scrollTo(0, 0);

  switch (view) {
    case 'notas': return renderNotes();
    case 'libretas': return renderNotebooks();
    case 'libreta': return renderNotes(arg);
    case 'mas': return renderMore();
    case 'editar': return renderEditor(arg);
    default: return renderHome();
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.hidden && flush());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load().then(route);
