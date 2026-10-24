'use strict';
const $ = s => document.querySelector(s);
const DB_NAME = 'dr-khalid', STORE = 'images', MAX = 25 * 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
let db, items = [], urls = [], pending = [], saving = false, editId = null, delId = null;
const vw = { item: null, url: null, z: 1, nw: 0, nh: 0 };

/* ---------- helpers ---------- */
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
const fmt = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fdate = t => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function toast(msg, kind) {
  const t = el('div', 'toast ' + (kind || ''), msg); $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}
const fail = (e, fallback) => toast(e && e.name === 'QuotaExceededError' ? 'Browser storage is full. Delete images or export a backup first.' : fallback, 'err');

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); s.createIndex('created', 'created'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Database blocked'));
  });
}
function run(mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode); let out;
    const q = fn(t.objectStore(STORE));
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const dbAll = () => run('readonly', s => s.getAll());
const dbAdd = rec => run('readwrite', s => s.add(rec));
const dbPut = rec => run('readwrite', s => s.put(rec));
const dbDel = id => run('readwrite', s => s.delete(id));

/* ---------- image utilities ---------- */
async function thumbOf(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Thumbnail failed')), 'image/webp', .82));
}
const toDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/* ---------- render ---------- */
function visible() {
  const toks = norm($('#q').value).split(' ').filter(Boolean);
  const l = items.filter(i => { const t = norm(i.title); return toks.every(k => t.includes(k)); });
  const m = $('#sort').value;
  l.sort(m === 'az' ? (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) : m === 'old' ? (a, b) => a.created - b.created : (a, b) => b.created - a.created);
  return l;
}
function render() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const list = visible(), q = $('#q').value.trim(), grid = $('#grid');
  grid.replaceChildren();
  $('#clearQ').hidden = !q;
  $('#emptyAll').hidden = items.length > 0;
  $('#emptySearch').hidden = !(items.length && !list.length);
  $('#count').textContent = items.length ? (q ? `${list.length} of ${items.length} images match` : `${items.length} image${items.length === 1 ? '' : 's'}`) : '';
  for (const it of list) {
    const u = URL.createObjectURL(it.thumb || it.blob); urls.push(u);
    const card = el('article', 'tile');
    const tb = el('button', 'thumb'); tb.type = 'button'; tb.setAttribute('aria-label', 'View ' + it.title);
    const img = el('img'); img.src = u; img.alt = it.title; img.loading = 'lazy'; img.decoding = 'async';
    tb.append(img); tb.onclick = () => openViewer(it);
    const info = el('div', 'info'); const h = el('h3', null, it.title); h.title = it.title;
    const t = el('time', null, 'Added ' + fdate(it.created)); t.dateTime = new Date(it.created).toISOString();
    info.append(h, t);
    const act = el('div', 'tact');
    const b = (txt, cls, fn) => { const x = el('button', 'btn ghost ' + cls, txt); x.type = 'button'; x.onclick = fn; return x; };
    act.append(b('View', '', () => openViewer(it)), b('Edit', '', () => openEdit(it)), b('Delete', 'del', () => openDelete(it)));
    card.append(tb, info, act); grid.append(card);
  }
  const week = Date.now() - 7 * 864e5;
  $('#sTotal').textContent = items.length;
  $('#sRecent').textContent = items.filter(i => i.created >= week).length;
  $('#sSize').textContent = fmt(items.reduce((n, i) => n + i.size, 0));
  updateQuota();
}
async function updateQuota() {
  const s = $('#storeInfo');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      s.textContent = `Browser storage: ${fmt(usage)} used of about ${fmt(quota)} available`;
    } else s.textContent = 'Stored locally in this browser';
  } catch { s.textContent = 'Stored locally in this browser'; }
}

/* ---------- upload ---------- */
function openUpload() { $('#upDlg').showModal(); }
async function addFiles(files) {
  if (!$('#upDlg').open) openUpload();
  for (const f of files) {
    if (!TYPES[f.type]) { toast(`“${f.name}” is not supported. Use PNG, JPG, JPEG or WebP.`, 'err'); continue; }
    if (f.size > MAX) { toast(`“${f.name}” is larger than 25 MB.`, 'err'); continue; }
    try { (await createImageBitmap(f)).close(); }
    catch { toast(`“${f.name}” is damaged or cannot be read as an image.`, 'err'); continue; }
    pending.push({ file: f, title: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f) });
  }
  renderPending();
}
function renderPending() {
  const ul = $('#pend'); ul.replaceChildren();
  pending.forEach((p, i) => {
    const li = el('li'), img = el('img'), inp = el('input'), rm = el('button', null, 'Remove');
    img.src = p.url; img.alt = '';
    inp.value = p.title; inp.maxLength = 200; inp.setAttribute('aria-label', 'Title for ' + p.file.name);
    inp.oninput = () => { p.title = inp.value; };
    rm.type = 'button'; rm.onclick = () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderPending(); };
    li.append(img, inp, rm); ul.append(li);
  });
  const b = $('#upSave'); b.disabled = !pending.length || saving;
  b.textContent = pending.length > 1 ? `Save ${pending.length} images` : 'Save image';
}
function closeUpload() { pending.forEach(p => URL.revokeObjectURL(p.url)); pending = []; renderPending(); $('#file').value = ''; $('#upDlg').close(); }
async function saveUploads() {
  if (saving || !pending.length) return;
  saving = true; renderPending();
  let ok = 0;
  try {
    for (const p of pending) {
      const thumb = await thumbOf(p.file);
      const rec = { title: p.title.trim() || p.file.name, type: p.file.type, size: p.file.size + thumb.size, created: Date.now() + ok, blob: p.file, thumb };
      rec.id = await dbAdd(rec); items.push(rec); ok++;
    }
    toast(`${ok} image${ok === 1 ? '' : 's'} saved to your library.`, 'ok');
    closeUpload();
  } catch (e) { fail(e, 'Could not save the image. Please try again.'); }
  finally { saving = false; renderPending(); render(); }
}

/* ---------- edit / delete ---------- */
function openEdit(it) { editId = it.id; $('#edIn').value = it.title; $('#edDlg').showModal(); $('#edIn').select(); }
async function saveEdit(e) {
  e.preventDefault();
  const it = items.find(i => i.id === editId), t = $('#edIn').value.trim();
  if (!it || !t) return;
  try { await dbPut({ ...it, title: t }); it.title = t; $('#edDlg').close(); render(); toast('Title updated.', 'ok'); }
  catch (er) { fail(er, 'Could not update the title.'); }
}
function openDelete(it) { delId = it.id; $('#delMsg').textContent = `“${it.title}” will be permanently removed from this browser.`; $('#delDlg').showModal(); }
async function confirmDelete() {
  try { await dbDel(delId); items = items.filter(i => i.id !== delId); $('#delDlg').close(); render(); toast('Image deleted.', 'ok'); }
  catch (e) { fail(e, 'Could not delete the image.'); }
}

/* ---------- viewer ---------- */
function openViewer(it) {
  vw.item = it; vw.url = URL.createObjectURL(it.blob);
  const img = $('#vImg'); img.alt = it.title; $('#vwT').textContent = it.title;
  img.onload = () => { vw.nw = img.naturalWidth; vw.nh = img.naturalHeight; fitView(); };
  img.src = vw.url; $('#vwDlg').showModal();
}
function fitScale() { const s = $('#stage'); return Math.min((s.clientWidth - 32) / vw.nw, (s.clientHeight - 32) / vw.nh, 1); }
function setZoom(z) {
  vw.z = Math.min(8, Math.max(.05, z));
  const img = $('#vImg'); img.style.width = Math.round(vw.nw * vw.z) + 'px'; img.style.height = Math.round(vw.nh * vw.z) + 'px';
  $('#zLbl').textContent = Math.round(vw.z * 100) + '%';
}
const fitView = () => setZoom(fitScale());
function closeViewer() { $('#vwDlg').close(); }
function downloadCurrent() {
  const it = vw.item; if (!it) return;
  const a = document.createElement('a'), u = URL.createObjectURL(it.blob);
  a.href = u; a.download = it.title.replace(/[\\/:*?"<>|]+/g, '_') + '.' + TYPES[it.type]; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

/* ---------- backup ---------- */
async function exportBackup() {
  if (!items.length) return toast('There are no images to export yet.', 'err');
  const btn = $('#exportBtn'); btn.disabled = true; btn.textContent = 'Exporting…';
  try {
    const out = [];
    for (const i of items) out.push({ title: i.title, type: i.type, created: i.created, data: await toDataURL(i.blob) });
    const blob = new Blob([JSON.stringify({ app: 'dr-khalid', version: 1, exported: Date.now(), images: out })], { type: 'application/json' });
    const a = document.createElement('a'), u = URL.createObjectURL(blob);
    a.href = u; a.download = `dr-khalid-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
    toast(`Backup created with ${out.length} images.`, 'ok');
  } catch { toast('Export failed. Try again with fewer images or free some memory.', 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Export backup'; }
}
async function importBackup(file) {
  const btn = $('#importBtn'); btn.disabled = true; btn.textContent = 'Importing…';
  let added = 0, skipped = 0;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'dr-khalid' || !Array.isArray(data.images)) throw new Error('bad');
    for (const r of data.images) {
      if (!TYPES[r.type] || typeof r.data !== 'string' || typeof r.title !== 'string') { skipped++; continue; }
      if (items.some(i => i.created === r.created && i.title === r.title)) { skipped++; continue; }
      try {
        const blob = await (await fetch(r.data)).blob(), typed = new Blob([blob], { type: r.type }), thumb = await thumbOf(typed);
        const rec = { title: r.title.slice(0, 200), type: r.type, size: typed.size + thumb.size, created: Number(r.created) || Date.now(), blob: typed, thumb };
        rec.id = await dbAdd(rec); items.push(rec); added++;
      } catch (e) { if (e && e.name === 'QuotaExceededError') throw e; skipped++; }
    }
    toast(`Imported ${added} image${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`, added ? 'ok' : 'err');
  } catch (e) { fail(e, 'This file is not a valid DR Khalid backup.'); }
  finally { btn.disabled = false; btn.textContent = 'Import backup'; $('#importFile').value = ''; render(); }
}

/* ---------- init ---------- */
function bind() {
  $('#uploadBtn').onclick = $('#uploadBtn2').onclick = openUpload;
  $('#browse').onclick = e => { e.stopPropagation(); $('#file').click(); };
  $('#file').onchange = e => addFiles([...e.target.files]);
  const dz = $('#drop');
  dz.onclick = () => $('#file').click();
  dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
  ['dragenter', 'dragover'].forEach(n => dz.addEventListener(n, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(n => dz.addEventListener(n, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); if (!dz.contains(e.target) && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $('#upCancel').onclick = closeUpload; $('#upSave').onclick = saveUploads;
  $('#upDlg').addEventListener('cancel', e => { e.preventDefault(); closeUpload(); });
  $('#edForm').onsubmit = saveEdit; $('#edCancel').onclick = () => $('#edDlg').close();
  $('#delCancel').onclick = () => $('#delDlg').close(); $('#delOk').onclick = confirmDelete;
  $('#q').oninput = render; $('#sort').onchange = () => { localStorage.setItem('drk-sort', $('#sort').value); render(); };
  $('#clearQ').onclick = () => { $('#q').value = ''; render(); $('#q').focus(); };
  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = e => e.target.files[0] && importBackup(e.target.files[0]);
  $('#zIn').onclick = () => setZoom(vw.z * 1.25); $('#zOut').onclick = () => setZoom(vw.z / 1.25);
  $('#zFit').onclick = fitView; $('#vDl').onclick = downloadCurrent; $('#vClose').onclick = closeViewer;
  $('#vwDlg').addEventListener('close', () => { URL.revokeObjectURL(vw.url); $('#vImg').removeAttribute('src'); vw.item = vw.url = null; });
  $('#vwDlg').addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') setZoom(vw.z * 1.25);
    else if (e.key === '-') setZoom(vw.z / 1.25);
    else if (e.key === '0') fitView();
  });
  window.addEventListener('resize', () => { if ($('#vwDlg').open && Math.abs(vw.z - fitScale()) < .001) fitView(); });
}
async function init() {
  bind();
  try { const s = localStorage.getItem('drk-sort'); if (s) $('#sort').value = s; } catch { /* storage blocked */ }
  try {
    db = await openDB();
    items = await dbAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    const b = $('#banner'); b.hidden = false;
    b.textContent = 'Browser storage is unavailable (private mode or blocked). Images cannot be saved. Open this app from http://localhost in a normal browser window.';
    $('#uploadBtn').disabled = $('#uploadBtn2').disabled = true;
  }
  $('#loading').hidden = true; render();
}
init();
