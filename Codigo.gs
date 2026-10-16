/**
 * Diario — backend en Google Apps Script.
 *
 * Pega este archivo en Extensiones > Apps Script de tu hoja de cálculo.
 * - El texto (notas, tareas, eventos, libretas) se guarda en las pestañas "Notas" y "Libretas".
 * - Las fotos y grabaciones se guardan en la carpeta de Drive FOLDER_ID.
 * Pasos completos en el README.
 */

// La clave NO va aquí: está en Configuración del proyecto > Propiedades del script,
// con el nombre TOKEN. Así puedes pegar versiones nuevas de este archivo sin tocarla.
// Pon la misma clave en la app (Más > Google Sheets y Drive).
const TOKEN_PROPERTY = 'TOKEN';
// Carpeta de Drive donde se guardan las fotos y grabaciones.
const FOLDER_ID = '1MSY4B9YGGNCExrQkpKkp7rWHCIaRtD_y';

const MAX_CELL = 49000; // Sheets admite 50.000 caracteres por celda

const TIPOS = { note: 'Nota', task: 'Tarea', event: 'Evento', audio: 'Grabación', photo: 'Foto' };

// [clave en la app, encabezado en la hoja, formato]
const TABLES = {
  notebooks: {
    sheet: 'Libretas',
    cols: [
      ['id', 'ID'],
      ['name', 'Nombre'],
      ['modified', 'Modificado', 'readable'],
      ['createdAt', 'Creado', 'num'],
      ['updatedAt', 'Actualizado', 'num'],
      ['deleted', 'Borrado', 'bool'],
    ],
  },
  items: {
    sheet: 'Notas',
    cols: [
      ['id', 'ID'],
      ['type', 'Tipo', 'type'],
      ['title', 'Título'],
      ['body', 'Contenido'],
      ['notebookName', 'Libreta', 'computed'],
      ['done', 'Completada', 'bool'],
      ['due', 'Fecha límite'],
      ['when', 'Fecha evento'],
      ['place', 'Lugar'],
      ['driveUrl', 'Archivo'],
      ['modified', 'Modificado', 'readable'],
      ['notebookId', 'ID libreta'],
      ['driveId', 'ID archivo'],
      ['mime', 'Tipo archivo'],
      ['createdAt', 'Creado', 'num'],
      ['updatedAt', 'Actualizado', 'num'],
      ['deleted', 'Borrado', 'bool'],
    ],
  },
};

// ---------- Entradas web ----------
function doGet() {
  return ContentService.createTextOutput('Diario: el servicio funciona.');
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const token = getToken_();
    if (!token) return json_({ ok: false, error: 'Falta la propiedad TOKEN en las propiedades del script' });
    if (req.token !== token) return json_({ ok: false, error: 'Clave incorrecta' });
    switch (req.action) {
      case 'ping':
        return json_({ ok: true });
      case 'sync':
        return json_(Object.assign({ ok: true }, withLock_(() => sync_(req))));
      case 'upload':
        return json_(Object.assign({ ok: true }, upload_(req)));
      case 'file':
        return json_(Object.assign({ ok: true }, file_(req)));
      default:
        return json_({ ok: false, error: 'Acción desconocida' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Ejecútala una vez desde el editor para dar permisos y crear las pestañas. */
function configurar() {
  if (!getToken_()) {
    throw new Error('Añade la propiedad TOKEN en Configuración del proyecto > Propiedades del script');
  }
  table_('notebooks');
  table_('items');
  const folder = DriveApp.getFolderById(FOLDER_ID);
  Logger.log('Todo listo. Carpeta de Drive: ' + folder.getName());
}

/** Si editas una fila a mano en la hoja, se marca como cambiada para que llegue a la app. */
function onEdit(e) {
  const sh = e.range.getSheet();
  const key = Object.keys(TABLES).find((k) => TABLES[k].sheet === sh.getName());
  if (!key) return;
  const cols = TABLES[key].cols;
  const first = Math.max(2, e.range.getRow());
  const last = e.range.getLastRow();
  if (last < first) return;
  const col = (k) => cols.findIndex((c) => c[0] === k);
  const range = sh.getRange(first, 1, last - first + 1, cols.length);
  const rows = range.getValues();
  const now = String(Date.now());
  const tz = Session.getScriptTimeZone();
  rows.forEach((row) => {
    row.forEach((v, i) => { if (v instanceof Date) row[i] = Utilities.formatDate(v, tz, 'yyyy-MM-dd'); });
    if (row.every((v) => v === '')) return;
    if (!row[col('id')]) {
      row[col('id')] = Utilities.getUuid();
      row[col('createdAt')] = now;
      if (key === 'items' && !row[col('type')]) row[col('type')] = TIPOS.note;
    }
    row[col('updatedAt')] = now;
  });
  range.setNumberFormat('@').setValues(rows);
}

// ---------- Sincronización ----------
function sync_(req) {
  const nb = mergeTable_('notebooks', req.notebooks || []);
  const nbNames = {};
  nb.records.forEach((r) => { if (!r.deleted) nbNames[r.id] = r.name; });
  const it = mergeTable_('items', req.items || [], { nbNames: nbNames, force: nb.changed });
  return { notebooks: nb.records, items: it.records };
}

// Une lo que llega con lo que hay en la hoja: gana la versión más reciente.
function mergeTable_(key, incoming, ctx) {
  ctx = ctx || {};
  const sh = table_(key);
  const t = TABLES[key];
  const records = readRecords_(t, sh);
  const index = {};
  records.forEach((r, i) => (index[r.id] = i));
  let changed = false;

  incoming.forEach((rec) => {
    if (!rec || !rec.id) return;
    const i = index[rec.id];
    if (i === undefined) {
      if (rec.deleted) return;
      index[rec.id] = records.push(pick_(t, rec)) - 1;
      changed = true;
      return;
    }
    const cur = records[i];
    if (Number(rec.updatedAt) < Number(cur.updatedAt)) return;
    if (key === 'items' && cur.driveId && (rec.deleted || rec.driveId !== cur.driveId)) trash_(cur.driveId);
    records[i] = rec.deleted
      ? Object.assign({}, cur, { deleted: true, updatedAt: Number(rec.updatedAt) })
      : pick_(t, rec);
    changed = true;
  });

  if (changed || ctx.force) {
    const rows = records.map((r) => t.cols.map((c) => toCell_(c, r, ctx)));
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, t.cols.length).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, t.cols.length).setNumberFormat('@').setValues(rows);
  }
  return { records: records, changed: changed };
}

function table_(key) {
  const t = TABLES[key];
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(t.sheet);
  if (!sh) sh = ss.insertSheet(t.sheet);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols.map((c) => c[1])]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRecords_(t, sh) {
  if (sh.getLastRow() < 2) return [];
  return sh
    .getRange(2, 1, sh.getLastRow() - 1, t.cols.length)
    .getValues()
    .filter((row) => row[0] !== '')
    .map((row) => {
      const rec = {};
      t.cols.forEach((c, i) => {
        const v = fromCell_(c, row[i]);
        if (v !== undefined) rec[c[0]] = v;
      });
      return rec;
    });
}

function pick_(t, rec) {
  const out = {};
  t.cols.forEach((c) => {
    if (c[2] !== 'readable' && c[2] !== 'computed') out[c[0]] = rec[c[0]];
  });
  return fromCellRecord_(t, out);
}

// Normaliza tipos para que lo devuelto sea igual que lo leído de la hoja.
function fromCellRecord_(t, rec) {
  const out = {};
  t.cols.forEach((c) => {
    if (c[2] === 'readable' || c[2] === 'computed') return;
    const v = rec[c[0]];
    out[c[0]] = c[2] ? fromCell_(c, toCell_(c, rec, {})) : v === undefined || v === null ? '' : String(v).slice(0, MAX_CELL);
  });
  return out;
}

function toCell_(c, rec, ctx) {
  const v = rec[c[0]];
  switch (c[2]) {
    case 'num': return String(Number(v) || 0);
    case 'bool': return v ? 'Sí' : '';
    case 'type': return TIPOS[v] || TIPOS.note;
    case 'readable':
      return Utilities.formatDate(new Date(Number(rec.updatedAt) || 0), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    case 'computed': return (ctx.nbNames && ctx.nbNames[rec.notebookId]) || '';
    default: {
      const s = v === undefined || v === null ? '' : String(v).slice(0, MAX_CELL);
      // El apóstrofo evita que Sheets tome "= + - @" iniciales por una fórmula (no se ve ni se lee).
      return /^[=+\-@]/.test(s) ? "'" + s : s;
    }
  }
}

function fromCell_(c, v) {
  switch (c[2]) {
    case 'readable':
    case 'computed': return undefined;
    case 'num': return Number(v) || 0;
    case 'bool': return v === true || v === 'Sí' || v === 'TRUE';
    case 'type': {
      const k = Object.keys(TIPOS).find((key) => TIPOS[key] === v || key === v);
      return k || 'note';
    }
    default: return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v);
  }
}

// ---------- Archivos en Drive ----------
function upload_(req) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'application/octet-stream', req.name || 'archivo');
  const file = folder.createFile(blob);
  return { id: file.getId(), url: file.getUrl() };
}

function file_(req) {
  const file = DriveApp.getFileById(req.id);
  if (!inFolder_(file)) throw new Error('El archivo no está en la carpeta de Diario');
  const blob = file.getBlob();
  return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function trash_(id) {
  try {
    const file = DriveApp.getFileById(id);
    if (inFolder_(file)) file.setTrashed(true);
  } catch (err) {
    // ya no existe: nada que hacer
  }
}

function inFolder_(file) {
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === FOLDER_ID) return true;
  return false;
}

// ---------- Utilidades ----------
function getToken_() {
  return (PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '').trim();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
