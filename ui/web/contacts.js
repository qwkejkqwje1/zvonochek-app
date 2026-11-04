// contacts.js — Адресная книга: контакты и «обратные номера»
// v44: вынесено из app.js без изменения логики (строки 4435–4768 v43).
import { decryptWithVault, encryptWithVault } from './identity.js?v=44';
import { kvGet, kvPut } from './store.js?v=44';
import { renderContactsList } from './stats-ui.js?v=44';
import { $, S, parseCallLink, renderCalls, route, toast } from './app.js?v=44';

// ---------- v38: адресная книга (контакты и «обратные номера») ----------
// identity/contacts: {v:1, items:{[fp]: {fp, name, secretEnc, saved, addedAt, lastAt}}}.
// fp — отпечаток личности собеседника (d=… его личной ссылки), secretEnc —
// секрет его ссылки под vault-ключом устройства (как секреты комнат).
// Номера из журнала, не сохранённые в контакты, забываются через 30 дней
// после последнего звонка — вместе с самим журналом. Контакты не уходят ни
// на сервер, ни в резервную копию: это только локальная записная книжка.
export const PEER_TTL_MS = 30 * 24 * 3600000;
export let contactsCache = null;
export const validFp = (fp) => typeof fp === 'string' && /^[a-f0-9]{32}$/.test(fp);
export const validSecret = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{22,}$/.test(k);
export const shareBackOn = () => {
  try {
    return localStorage.zvShareBack !== '0';
  } catch {
    return true;
  }
};
/** «Обратный номер» из payload звонка: {k, d}, только если d = отпечаток звонящего. */
export function backOf(payload, fromFp) {
  const b = payload && payload.back;
  if (!b || !validSecret(b.k) || !validFp(b.d)) return null;
  if (fromFp && b.d !== fromFp) return null;
  if (S.personal && b.d === S.personal.fp) return null;
  return { k: b.k, d: b.d };
}
export async function contactsLoad() {
  if (contactsCache) return contactsCache;
  let rec = null;
  try {
    rec = await kvGet('identity', 'contacts');
  } catch {}
  contactsCache = rec && rec.items && typeof rec.items === 'object' ? rec : { v: 1, items: {} };
  const now = Date.now();
  let changed = false;
  for (const [fp, c] of Object.entries(contactsCache.items)) {
    if (!c || (!c.saved && now - (c.lastAt || c.addedAt || 0) > PEER_TTL_MS)) {
      delete contactsCache.items[fp];
      changed = true;
    }
  }
  if (changed) await contactsSave();
  return contactsCache;
}
export async function contactsSave() {
  if (!contactsCache) return;
  try {
    await kvPut('identity', 'contacts', contactsCache);
  } catch (e) {
    console.warn('contacts', e);
  }
  syncLocal();
}
// v39: локальное изменение того, что едет на другие устройства профиля.
export function syncLocal() {
  try {
    window.dispatchEvent(new CustomEvent('zv-sync-local'));
  } catch {}
}
/** Запомнить номер собеседника (save — сразу в контакты, с именем). */
export async function rememberPeer({ secret, fp, name = '', save = false }) {
  if (!validSecret(secret) || !validFp(fp)) return null;
  if (S.personal && fp === S.personal.fp) return null;
  const book = await contactsLoad();
  const prev = book.items[fp];
  const now = Date.now();
  const nm = String(name || '').trim().slice(0, 40);
  book.items[fp] = {
    fp,
    name: save && nm ? nm : prev?.saved ? prev.name : nm || prev?.name || '',
    secretEnc: await encryptWithVault(secret),
    saved: !!(prev?.saved || save),
    addedAt: prev?.addedAt || now,
    lastAt: now,
  };
  await contactsSave();
  renderContacts().catch(() => {});
  return book.items[fp];
}
export async function touchPeer(fp, name) {
  const book = await contactsLoad();
  const c = book.items[fp];
  if (!c) return;
  c.lastAt = Date.now();
  const nm = String(name || '').trim().slice(0, 40);
  if (!c.saved && nm) c.name = nm;
  await contactsSave();
  renderContacts().catch(() => {});
}
export async function peerName(fp) {
  if (!validFp(fp)) return '';
  const c = (await contactsLoad()).items[fp];
  return c?.saved ? c.name : '';
}
export async function peerSecret(fp) {
  const c = (await contactsLoad()).items[fp];
  if (!c?.secretEnc) return null;
  try {
    return await decryptWithVault(c.secretEnc);
  } catch {
    return null;
  }
}
export async function callPeer(fp) {
  if (!validFp(fp)) return;
  if (S.joined) return toast('Сначала завершите текущий звонок');
  const secret = await peerSecret(fp);
  if (!validSecret(secret)) return toast('Номер не найден — попросите ссылку заново');
  hideContactMenu();
  S.autoCallPending = true;
  const hash = 'k=' + secret + '&d=' + fp;
  if (location.hash.slice(1) === hash) route();
  else location.hash = hash;
}
export async function renderContacts() {
  const ul = $('#contactsList');
  if (!ul) return;
  const book = await contactsLoad();
  const list = Object.values(book.items)
    .filter((c) => c.saved)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || String(a.name).localeCompare(String(b.name), 'ru'));
  renderContactsList(ul, list, {
    onCall: (c) => callPeer(c.fp),
    onMenu: (c, el) => openContactMenu(c.fp, el, null),
  });
}

// Меню контакта / записи журнала. Удаление — в два нажатия (как в чатах).
export let contactMenuFp = null;
export function hideContactMenu() {
  $('#contactMenu')?.classList.add('hidden');
  contactMenuFp = null;
}
export async function openContactMenu(fp, anchor, entry) {
  const menu = $('#contactMenu');
  if (!menu || !validFp(fp)) return;
  if (contactMenuFp === fp && !menu.classList.contains('hidden')) return hideContactMenu();
  const c = (await contactsLoad()).items[fp];
  if (!c) return toast('Номер этого звонка не сохранился (истёк срок или звонивший его не передал)');
  contactMenuFp = fp;
  const del = $('#contactActDel');
  if (del) {
    delete del.dataset.armed;
    (del.querySelector('span') || del).textContent = c.saved ? 'Удалить контакт' : 'Забыть номер';
  }
  $('#contactActSave')?.classList.toggle('hidden', !!c.saved);
  $('#contactActRename')?.classList.toggle('hidden', !c.saved);
  menu.dataset.name = (entry && entry.name) || c.name || '';
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = r.bottom + mh + 8 > vh ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(vw - mw - 8, r.right - mw)) + 'px';
}

// Редактор контакта: добавить по ссылке, сохранить номер из журнала, переименовать.
export let contactEditFp = null;
export function openContactEditor(fp = null, name = '') {
  const box = $('#contactAddBox');
  if (!box) return;
  contactEditFp = fp;
  box.classList.remove('hidden');
  $('#contactAddLink')?.classList.toggle('hidden', !!fp);
  const nm = $('#contactAddName');
  if (nm) {
    nm.value = name || '';
    nm.focus();
  }
  if (!fp && $('#contactAddLink')) $('#contactAddLink').value = '';
  const note = $('#contactAddNote');
  if (note) note.textContent = '';
}
export function closeContactEditor() {
  $('#contactAddBox')?.classList.add('hidden');
  contactEditFp = null;
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initContacts() {
  // v39: контакты в синхронизации профиля (devices.js): секрет номера —
  // в зашифрованной комнате синхронизации, время последнего звонка — до дня
  // (чтобы каждый звонок не гонял синхронизацию).
  window.__zvAppSync = {
    async contactsView() {
      const book = await contactsLoad();
      const out = {};
      for (const [fp, c] of Object.entries(book.items)) {
        if (!c || !validFp(fp) || !c.secretEnc) continue;
        let secret;
        try {
          secret = await decryptWithVault(c.secretEnc);
        } catch {
          continue;
        }
        out['contact:' + fp] = {
          name: c.name || '',
          secret,
          saved: !!c.saved,
          addedAt: c.addedAt || 0,
          day: Math.floor((c.lastAt || c.addedAt || 0) / 864e5),
        };
      }
      return out;
    },
    async contactApply(fp, v) {
      if (!validFp(fp)) return true;
      const book = await contactsLoad();
      if (v === null) {
        if (book.items[fp]) {
          delete book.items[fp];
          await kvPut('identity', 'contacts', book).catch(() => {});
          renderContacts().catch(() => {});
        }
        return true;
      }
      if (!v || !validSecret(v.secret)) return true;
      if (S.personal && fp === S.personal.fp) return true;
      const prev = book.items[fp];
      let secretEnc = null;
      if (prev?.secretEnc) {
        try {
          if ((await decryptWithVault(prev.secretEnc)) === v.secret) secretEnc = prev.secretEnc;
        } catch {}
      }
      book.items[fp] = {
        fp,
        name: String(v.name || '').slice(0, 40),
        secretEnc: secretEnc || (await encryptWithVault(v.secret)),
        saved: !!v.saved,
        addedAt: Number(v.addedAt) || 0,
        lastAt: Math.max(prev?.lastAt || 0, (Number(v.day) || 0) * 864e5),
      };
      await kvPut('identity', 'contacts', book).catch(() => {});
      renderContacts().catch(() => {});
      return true;
    },
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      const menu = $('#contactMenu');
      if (!menu || menu.classList.contains('hidden')) return;
      if (menu.contains(e.target) || e.target.closest?.('.call-li')) return;
      hideContactMenu();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContactMenu();
  });
  $('#btnContactAdd') &&
    ($('#btnContactAdd').onclick = () => {
      if ($('#contactAddBox')?.classList.contains('hidden')) openContactEditor(null, '');
      else closeContactEditor();
    });
  $('#contactAddCancel') && ($('#contactAddCancel').onclick = closeContactEditor);
  $('#contactAddSave') &&
    ($('#contactAddSave').onclick = async () => {
      const note = $('#contactAddNote');
      const say = (t) => {
        if (note) note.textContent = t;
      };
      const name = ($('#contactAddName')?.value || '').trim().slice(0, 40);
      if (!name) return say('Введите имя — его видите только вы.');
      if (contactEditFp) {
        const book = await contactsLoad();
        const c = book.items[contactEditFp];
        if (!c) return say('Номер не найден.');
        c.name = name;
        c.saved = true;
        await contactsSave();
        closeContactEditor();
        renderCalls().catch(() => {});
        return;
      }
      const raw = ($('#contactAddLink')?.value || '').trim();
      const t = parseCallLink(raw);
      if (!t || !t.fp) return say('Нужна личная ссылка целиком (с частью «&d=…»): её копируют во вкладке «Мой номер».');
      if (S.personal && t.fp === S.personal.fp) return say('Это ваша собственная ссылка.');
      await rememberPeer({ secret: t.secret, fp: t.fp, name, save: true });
      closeContactEditor();
      toast('Контакт сохранён');
      renderCalls().catch(() => {});
    });
  $('#contactActCall') &&
    ($('#contactActCall').onclick = () => {
      const fp = contactMenuFp;
      hideContactMenu();
      callPeer(fp);
    });
  $('#contactActSave') &&
    ($('#contactActSave').onclick = () => {
      const fp = contactMenuFp;
      const name = $('#contactMenu')?.dataset.name || '';
      hideContactMenu();
      openContactEditor(fp, name);
    });
  $('#contactActRename') &&
    ($('#contactActRename').onclick = async () => {
      const fp = contactMenuFp;
      hideContactMenu();
      openContactEditor(fp, (await contactsLoad()).items[fp]?.name || '');
    });
  $('#contactActCopy') &&
    ($('#contactActCopy').onclick = async () => {
      const fp = contactMenuFp;
      hideContactMenu();
      const secret = await peerSecret(fp);
      if (!validSecret(secret)) return toast('Номер не найден');
      const link = `${location.origin}${location.pathname}#k=${secret}&d=${fp}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Ссылка скопирована');
      } catch {
        toast('Не удалось скопировать');
      }
    });
  $('#contactActDel') &&
    ($('#contactActDel').onclick = async () => {
      const btn = $('#contactActDel');
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1';
        (btn.querySelector('span') || btn).textContent = 'Точно удалить?';
        return;
      }
      const fp = contactMenuFp;
      hideContactMenu();
      const book = await contactsLoad();
      delete book.items[fp];
      await contactsSave();
      renderCalls().catch(() => {});
    });
}
