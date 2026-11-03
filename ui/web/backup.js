// ZVONochek v27 — резервная копия личности и восстановление по фразе
// (этап 4 техплана v15 в серверном варианте хранения).
//
// Фраза восстановления: 17 слов (seed 128 бит + контрольная сумма), по ней
// детерминированно выводятся И ключ шифрования бэкапа, И recovery-пара
// ECDSA. Recovery-ключ заранее удостоверен master-ключом (сертификат с
// label 'recovery'), поэтому после потери устройства цепочка доверия
// master → recovery → новое устройство позволяет Inbox принять новое
// устройство как устройство ТОЙ ЖЕ личности.
//
// Серверный бэкап (PairingDO, режим backup): blob = AES-GCM(HKDF(seed))
// от {v, nickname, masterPub, rooms:[{seed, name, pinProtected, pin, ts}],
// deletedRooms:[{roomId, ts}]} — история сообщений в бэкап НЕ входит
// (докачивается с сервера в пределах retention). Запись на сервер
// подписывается recovery-ключом; адрес — SHA-256(recoveryPub). Личная
// ссылка при восстановлении перевыпускается: секрет ссылки создаётся
// заново (старый остался на потерянном устройстве), topic и ссылка
// меняются, master-личность — та же.
//
// v29: deletedRooms — tombstones удалённых чатов. Восстановление не
// воскрешает комнату, чей tombstone новее её записи в бэкапе; локальный
// источник tombstones — тот же localStorage-ключ 'zvDeletedRooms',
// который ведёт chat.js при удалении.
import { CONFIG, getWorkerBase } from './config.js?v=41';
import {
  b64u,
  newSecret,
  genP256KeyPair,
  deriveChatKeys,
  derivePinIkm,
  mnemonicEncode,
  mnemonicDecode,
  deriveRecoveryPair,
  sealBackup,
  openBackup,
  backupIdHash,
} from './crypto.js?v=41';
import { kvGet, kvPut, kvAll, normalizeRoomRecord } from './store.js?v=41';
import { isRoomTombstoned } from './chat-transport.js?v=41';
import {
  getPersonal,
  ensurePersonal,
  encryptWithVault,
  decryptWithVault,
  signDeviceCert,
  deviceCertText,
  verifyChatSig,
  fpOfPubRaw,
  getRecoveryState,
  saveRecoveryState,
} from './identity.js?v=41';

const $ = (s, r = document) => r.querySelector(s);
const te = new TextEncoder();
const workerBase = () => getWorkerBase().replace(/\/$/, '');
const CERT_TTL_MS = 10 * 365 * 24 * 3600000;

let pendingSeed = null; // seed только что сгенерированной фразы (память, до активации)
let updateTimer = null;

function bkNote(text) {
  const a = $('#backupNote');
  if (a) a.textContent = text || '';
  const b = $('#restoreNote');
  if (b) b.textContent = text || '';
}

// ---------- Данные бэкапа ----------
// v29: локальные tombstones удалённых комнат (ключ ведёт chat.js).
function loadLocalTombstones() {
  try {
    const arr = JSON.parse(localStorage.getItem('zvDeletedRooms') || '[]');
    return Array.isArray(arr)
      ? arr.filter((t) => t && typeof t.roomId === 'string' && Number.isFinite(t.ts))
      : [];
  } catch {
    return [];
  }
}

async function collectBackupData() {
  const personal = await getPersonal();
  const rooms = [];
  for (const { value: rec } of await kvAll('rooms')) {
    if (!rec?.seedEnc) continue;
    try {
      const seed = await decryptWithVault(rec.seedEnc);
      let pin = null;
      if (rec.pinEnc) {
        try {
          pin = await decryptWithVault(rec.pinEnc);
        } catch {}
      }
      rooms.push({
        seed,
        name: `Чат ${String(rec.roomId || '').slice(0, 8)}`,
        pinProtected: !!rec.pinProtected,
        pin,
        // v29: метка записи для сравнения с tombstone при восстановлении.
        ts: rec.createdAt || 0,
      });
    } catch {}
  }
  return {
    v: 35,
    nickname: personal?.label || '',
    masterPub: personal?.masterPub || '',
    rooms,
    // v29: tombstones — чтобы восстановление не воскрешало удалённые чаты.
    deletedRooms: loadLocalTombstones(),
  };
}

async function signBackupBlob(pair, blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(blob)));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    digest
  );
  return b64u.enc(sig);
}

async function uploadBackup(seedBytes, pair, cert) {
  const data = await collectBackupData();
  const blob = await sealBackup(seedBytes, data);
  const idHash = await backupIdHash(pair.pubRaw);
  const sig = await signBackupBlob(pair, blob);
  const res = await fetch(workerBase() + '/pair/backup', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idHash, pub: pair.pubB64, blob, sig, cert }),
  });
  if (!res.ok) throw new Error('сервер бэкапа: ' + res.status + ' — воркер v27 задеплоен?');
  return data;
}

async function downloadBackup(idHash) {
  const res = await fetch(workerBase() + '/pair/backup?idHash=' + encodeURIComponent(idHash));
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// Перезаливка бэкапа из сохранённого на устройстве состояния (seed — из
// vault, фраза повторно не нужна).
async function refreshBackup() {
  const state = await getRecoveryState();
  if (!state?.enabled || !state.seedEnc) return false;
  const seed = b64u.dec(await decryptWithVault(state.seedEnc));
  const pair = await deriveRecoveryPair(seed);
  await uploadBackup(seed, pair, state.cert);
  state.updatedAt = Date.now();
  await saveRecoveryState(state);
  renderBackupStatus().catch(() => {});
  return true;
}

// v38: удалить серверный бэкап («Сменить номер» / «Стереть всё»). Подпись
// recovery-ключом, seed — из vault, поэтому вызывать ДО смены/стирания
// личности. Без включённого бэкапа — ничего не делает.
async function deleteServerBackup() {
  const state = await getRecoveryState();
  if (!state?.seedEnc) return { ok: true, had: false };
  const seed = b64u.dec(await decryptWithVault(state.seedEnc));
  const pair = await deriveRecoveryPair(seed);
  const idHash = await backupIdHash(pair.pubRaw);
  const ts = Date.now();
  const sig = await signBackupBlob(pair, `zv-backup-delete-v1|${idHash}|${ts}`);
  const res = await fetch(workerBase() + '/pair/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idHash, del: true, pub: pair.pubB64, ts, sig }),
  });
  return { ok: res.ok, had: true };
}

// ---------- UI: настройка бэкапа ----------
async function renderBackupStatus() {
  const state = await getRecoveryState();
  const statusEl = $('#backupStatus');
  const setupEl = $('#backupSetup');
  if (state?.enabled) {
    if (setupEl) setupEl.classList.add('hidden');
    if (statusEl) {
      statusEl.classList.remove('hidden');
      const when = state.updatedAt
        ? new Date(state.updatedAt).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '—';
      statusEl.textContent = `Бэкап включён · обновлён ${when}. Фраза восстановления — единственный ключ: храните её офлайн.`;
    }
  } else {
    // v39: на привязанном устройстве нет master-ключа — фразу создают на
    // основном (она восстанавливает весь профиль, включая это устройство).
    const p = await getPersonal().catch(() => null);
    if (p?.linked) {
      if (setupEl) setupEl.classList.add('hidden');
      if (statusEl) {
        statusEl.classList.remove('hidden');
        statusEl.textContent =
          'Это привязанное устройство профиля. Фразу восстановления включают на основном устройстве (где номер создан или восстановлен) — она восстанавливает весь профиль.';
      }
      return;
    }
    if (statusEl) statusEl.classList.add('hidden');
    if (setupEl) setupEl.classList.remove('hidden');
  }
}

function renderPhrase(phrase) {
  const box = $('#backupWords');
  if (!box) return;
  box.replaceChildren();
  for (const w of phrase.split(' ')) {
    const li = document.createElement('li');
    li.textContent = w;
    box.append(li);
  }
  $('#backupPhraseBox')?.classList.remove('hidden');
}

async function genPhrase() {
  pendingSeed = crypto.getRandomValues(new Uint8Array(16));
  const phrase = await mnemonicEncode(pendingSeed);
  renderPhrase(phrase);
  const chk = $('#backupConfirmCheck');
  if (chk) chk.checked = false;
  const btn = $('#btnActivateBackup');
  if (btn) btn.disabled = true;
  bkNote('Запишите все 17 слов по порядку на бумагу. Это единственный способ восстановить личность и чаты при потере устройства.');
}

async function activateBackup() {
  if (!pendingSeed) return bkNote('Сначала сгенерируйте фразу.');
  if (!$('#backupConfirmCheck')?.checked) return bkNote('Подтвердите, что записали фразу.');
  try {
    const personal = await ensurePersonal();
    if (!personal.masterPriv) {
      throw new Error(
        personal.linked
          ? 'фразу восстановления создают на основном устройстве профиля (там, где номер создан или восстановлен) — это устройство привязанное'
          : 'master-ключ недоступен на этом устройстве'
      );
    }
    const pair = await deriveRecoveryPair(pendingSeed);
    // Recovery-сертификат: master удостоверяет recovery-публичный ключ.
    const cert = await signDeviceCert(
      personal.masterPriv,
      pair.pubB64,
      'recovery',
      Date.now() + CERT_TTL_MS
    );
    await saveRecoveryState({
      seedEnc: await encryptWithVault(b64u.enc(pendingSeed)),
      pub: pair.pubB64,
      cert,
      enabled: true,
      updatedAt: Date.now(),
    });
    await uploadBackup(pendingSeed, pair, cert);
    pendingSeed = null;
    $('#backupPhraseBox')?.classList.add('hidden');
    bkNote('Бэкап включён и загружен на сервер (в зашифрованном виде).');
    renderBackupStatus().catch(() => {});
  } catch (e) {
    bkNote('Не удалось включить бэкап: ' + (e?.message || e));
  }
}

async function showPhraseAgain() {
  const state = await getRecoveryState();
  if (!state?.seedEnc) return bkNote('Бэкап на этом устройстве не настроен.');
  try {
    const seed = b64u.dec(await decryptWithVault(state.seedEnc));
    renderPhrase(await mnemonicEncode(seed));
    bkNote('Ваша фраза восстановления. Не фотографируйте и не отправляйте её никому.');
  } catch (e) {
    bkNote('Не удалось показать фразу: ' + (e?.message || e));
  }
}

// ---------- Восстановление на новом устройстве ----------
async function restoreFromPhrase() {
  const raw = ($('#restorePhrase')?.value || '').trim();
  if (!raw) return bkNote('Введите фразу восстановления (17 слов).');
  let seed;
  try {
    seed = await mnemonicDecode(raw);
  } catch (e) {
    return bkNote(e.message);
  }
  try {
    bkNote('Ищу бэкап на сервере…');
    const pair = await deriveRecoveryPair(seed);
    const idHash = await backupIdHash(pair.pubRaw);
    const { status, data } = await downloadBackup(idHash);
    if (status === 404) {
      return bkNote('Бэкап с такой фразой на сервере не найден. Проверьте слова и порядок.');
    }
    if (status !== 200 || !data.blob) {
      return bkNote('Сервер бэкапа недоступен (' + status + ') — воркер v27 задеплоен?');
    }
    const backup = await openBackup(seed, data.blob);
    if (!backup?.masterPub || !Array.isArray(backup.rooms)) {
      return bkNote('Бэкап не расшифровался этой фразой.');
    }
    const cert = data.cert;
    if (!cert?.sig) {
      return bkNote('В бэкапе нет сертификата восстановления — восстановить личность нельзя, только создать новую.');
    }
    // Цепочка доверия начинается с master: проверяем его подпись на
    // recovery-сертификате до того, как что-либо создавать.
    const certOk = await verifyChatSig(
      backup.masterPub,
      cert.sig,
      deviceCertText(pair.pubB64, cert.label, cert.exp)
    );
    if (!certOk || cert.label !== 'recovery') {
      return bkNote('Сертификат восстановления не подтвердился подписью вашей личности. Бэкап отклонён.');
    }
    // Новое устройство этой личности: пара устройства + её сертификат,
    // подписанный recovery-ключом (второй уровень цепочки).
    const label = backup.nickname || 'Владелец';
    const devPair = await genP256KeyPair();
    const devicePub = b64u.enc(await crypto.subtle.exportKey('raw', devPair.publicKey));
    const devCert = await signDeviceCert(
      pair.privateKey,
      devicePub,
      label,
      Date.now() + CERT_TTL_MS
    );
    await kvPut('devices', 'self', {
      devicePub,
      devicePriv: devPair.privateKey,
      cert: devCert,
      label,
      chain: { recoveryPub: pair.pubB64, recoveryCert: cert },
    });
    // Личность: master тот же, master-приватника на этом устройстве нет;
    // секрет личной ссылки — НОВЫЙ (перевыпуск: старый topic мёртв).
    const secret = newSecret();
    await kvPut('identity', 'personal', {
      masterPub: backup.masterPub,
      masterPriv: null,
      secretEnc: await encryptWithVault(secret),
      restored: true,
      createdAt: Date.now(),
    });
    await saveRecoveryState({
      seedEnc: await encryptWithVault(b64u.enc(seed)),
      pub: pair.pubB64,
      cert,
      enabled: true,
      updatedAt: Date.now(),
    });
    // v29: tombstones из бэкапа + локальные объединяются (по комнате —
    // новейший) и сохраняются локально: удалённые чаты не воскресают ни
    // при этом восстановлении, ни при следующих.
    const tombByRoom = new Map();
    for (const t of [...loadLocalTombstones(), ...(backup.deletedRooms || [])]) {
      if (!t || typeof t.roomId !== 'string' || !Number.isFinite(t.ts)) continue;
      if (!tombByRoom.has(t.roomId) || tombByRoom.get(t.roomId) < t.ts) {
        tombByRoom.set(t.roomId, t.ts);
      }
    }
    const mergedTombstones = [...tombByRoom.entries()].map(([roomId, ts]) => ({ roomId, ts }));
    try {
      localStorage.setItem('zvDeletedRooms', JSON.stringify(mergedTombstones.slice(-200)));
    } catch {}
    // Комнаты: записи восстанавливаются локально; история докачается с
    // сервера в пределах retention при первом открытии каждой комнаты.
    let restoredRooms = 0;
    let skippedDeleted = 0;
    for (const room of backup.rooms) {
      try {
        const seedBytes = b64u.dec(room.seed);
        if (seedBytes.length !== 32) continue;
        const pinIkm = room.pin ? await derivePinIkm(room.pin, seedBytes) : null;
        const keys = await deriveChatKeys(seedBytes, { pinIkm });
        // v29: tombstone новее записи комнаты — комната была удалена.
        if (isRoomTombstoned(keys.roomId, room.ts || 0, mergedTombstones)) {
          skippedDeleted++;
          continue;
        }
        if (await kvGet('rooms', keys.roomId)) continue; // уже есть локально — не затираем
        const rec = normalizeRoomRecord({
          roomId: keys.roomId,
          seedEnc: await encryptWithVault(room.seed),
          nick: backup.nickname || '',
          epoch: 0,
          lastSeq: 0,
          lastReadSeq: 0,
          members: {},
          introSent: false,
          createdAt: Date.now(),
          pinProtected: !!room.pinProtected,
          pinEnc: room.pin ? await encryptWithVault(room.pin) : null,
        });
        await kvPut('rooms', keys.roomId, rec);
        restoredRooms++;
      } catch {}
    }
    const fp = await fpOfPubRaw(b64u.dec(backup.masterPub));
    const link = `${location.origin}${location.pathname}#k=${secret}&d=${fp}`;
    const linkEl = $('#restoreNewLink');
    if (linkEl) linkEl.value = link;
    $('#restoreDone')?.classList.remove('hidden');
    bkNote(
      `Личность восстановлена, комнат восстановлено: ${restoredRooms}` +
        (skippedDeleted ? `, удалённых ранее пропущено: ${skippedDeleted}` : '') +
        `. Ваша личная ссылка — НОВАЯ (выше): старая осталась на потерянном устройстве, раздайте эту заново. Обновите страницу, чтобы коммуникатор подхватил личность.`
    );
  } catch (e) {
    bkNote('Не удалось восстановить: ' + (e?.message || e));
  }
}

// ---------- Проводка ----------
function initBackupUI() {
  const toggle = $('#btnBackupToggle');
  if (toggle) {
    toggle.onclick = () => {
      const box = $('#backupBox');
      if (!box) return;
      const willShow = box.classList.contains('hidden');
      box.classList.toggle('hidden');
      if (willShow) renderBackupStatus().catch(() => {});
    };
  }
  const gen = $('#btnGenPhrase');
  if (gen) gen.onclick = () => genPhrase().catch((e) => bkNote(e.message));
  const chk = $('#backupConfirmCheck');
  if (chk) {
    chk.onchange = () => {
      const btn = $('#btnActivateBackup');
      if (btn) btn.disabled = !chk.checked;
    };
  }
  const act = $('#btnActivateBackup');
  if (act) act.onclick = () => activateBackup().catch(() => {});
  const show = $('#btnShowPhrase');
  if (show) show.onclick = () => showPhraseAgain().catch(() => {});
  const now = $('#btnBackupNow');
  if (now) {
    now.onclick = async () => {
      try {
        if (await refreshBackup()) bkNote('Бэкап обновлён.');
        else bkNote('Бэкап не включён.');
      } catch (e) {
        bkNote('Не удалось обновить бэкап: ' + (e?.message || e));
      }
    };
  }
  const restore = $('#btnRestore');
  if (restore) restore.onclick = () => restoreFromPhrase().catch(() => {});
  // Автообновление бэкапа при изменении списка комнат (дебаунс 2 с).
  window.addEventListener('zv-rooms-changed', () => {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      refreshBackup().catch(() => {});
    }, 2000);
  });
  // v38: сервер хранит бэкап 180 дней с последней заливки — освежаем раз
  // в неделю при запуске (бэкап брошенной личности со временем исчезнет сам).
  setTimeout(async () => {
    try {
      const st = await getRecoveryState();
      if (st?.enabled && Date.now() - (st.updatedAt || 0) > 7 * 24 * 3600000) await refreshBackup();
    } catch {}
  }, 15000);
  // Для тестов и отладки.
  window.ZVBackup = { refreshBackup, restoreFromPhrase };
  // v38: хуки для app.js («Сменить номер», «Стереть всё»).
  window.__zvBackup = {
    deleteServer: deleteServerBackup,
    render: () => {
      $('#backupPhraseBox')?.classList.add('hidden');
      return renderBackupStatus();
    },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBackupUI);
} else {
  initBackupUI();
}
