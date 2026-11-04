// chat-invite.js — Код приветствия, постоянная короткая ссылка и кодовое слово
// v44: вынесено из chat.js без изменения логики (строки 3675–4039 v43).
import { b64u, codeAccess, codeAddrForScheme, newGreetCode, newJoinCode, normalizeWordPhrase, openCodeBlob, sealCodeBlob, sha256hex } from './crypto.js?v=44';
import { decryptWithVault, encryptWithVault } from './identity.js?v=44';
import { $, cur, fmtDayTime, greetLinkOf, joinLinkOf, note, openRoomBySeed, saveRoom, workerBase } from './chat.js?v=44';

// ---------- Код приветствия (v25) ----------
export async function pairApi(path, body) {
  const res = await fetch(workerBase() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// v36: claim по адресу схемы 2 (адрес из медленного KDF, см. codeAccess в
// crypto.js); при 404 — по адресу ≤ v35, чтобы коды и короткие ссылки,
// выданные старыми клиентами, продолжали работать до своего срока.
export async function claimCode(acc) {
  const r = await pairApi('/pair/claim', { codeHash: acc.addr });
  if (r.status === 404) {
    const legacy = await pairApi('/pair/claim', { codeHash: acc.legacy.addr });
    if (legacy.status !== 404) return { r: legacy, key: acc.legacy.key };
  }
  return { r, key: acc.key };
}

export async function createInvite() {
  if (!cur) return;
  try {
    const seed = await decryptWithVault(cur.rec.seedEnc);
    const code = newGreetCode();
    const acc = await codeAccess('greet', code);
    const blob = await sealCodeBlob(acc.key, { seed, roomId: cur.rec.roomId });
    const codeHash = acc.addr;
    const r = await pairApi('/pair/create', {
      codeHash,
      blob,
      exp: Date.now() + 15 * 60000,
    });
    if (r.status !== 200 && r.status !== 201) {
      throw new Error('сервер пар недоступен (' + r.status + ') — воркер v25 задеплоен?');
    }
    const box = $('#chatGreetBox');
    if (!box) return;
    $('#greetCode').textContent = code;
    const linkInput = $('#greetLink');
    if (linkInput) linkInput.value = greetLinkOf(code);
    const qr = $('#greetQr');
    if (qr && typeof qrcode !== 'undefined') {
      try {
        const q = qrcode(0, 'M');
        q.addData(greetLinkOf(code));
        q.make();
        // v43: поле вокруг QR — 4 модуля (стандарт); на тёмном фоне 2 px не хватало.
        qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      } catch {
        qr.textContent = '';
      }
    }
    box.classList.remove('hidden');
    note('Покажите код собеседнику или отправьте короткую ссылку. Код одноразовый, действует 15 минут.');
  } catch (e) {
    note('Не удалось создать код приглашения: ' + e.message);
  }
}

// Возвращает true, если комната открыта; false — если код не подошёл
// (чтобы redeemCode мог попробовать второе пространство кодов).
export async function redeemGreet(codeRaw, opts = {}) {
  const code = String(codeRaw || '').trim();
  if (!/^[A-Za-z0-9_-]{9}$/.test(code)) {
    note('Код подключения — 9 символов.');
    return false;
  }
  try {
    note('Проверяю код подключения…');
    const { r, key } = await claimCode(await codeAccess('greet', code));
    if (r.status === 404) {
      if (!opts.quiet) note('Код не найден или уже использован.');
      return false;
    }
    if (r.status === 410) {
      note('Код истёк (15 минут) или лимит попыток исчерпан. Попросите новый.');
      return false;
    }
    if (r.status !== 200 || !r.data.blob) {
      note('Сервер пар отклонил запрос: ' + r.status);
      return false;
    }
    const payload = await openCodeBlob(key, r.data.blob);
    if (!payload?.seed) {
      note('Не удалось расшифровать приглашение этим кодом.');
      return false;
    }
    note('');
    await openRoomBySeed(payload.seed);
    return true;
  } catch (e) {
    note('Не удалось подключиться по коду: ' + e.message);
    return false;
  }
}

// ---------- Постоянная короткая ссылка (v26, алиас PairingDO) ----------
export async function aliasCreate() {
  if (!cur) return false;
  try {
    const seed = await decryptWithVault(cur.rec.seedEnc);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newJoinCode();
      const acc = await codeAccess('alias', code);
      const codeHash = acc.addr;
      const blob = await sealCodeBlob(acc.key, { seed, roomId: cur.rec.roomId });
      const admin = b64u.enc(crypto.getRandomValues(new Uint8Array(16))); // 128 бит
      const adminHash = await sha256hex(admin);
      const r = await pairApi('/pair/alias', { codeHash, blob, adminHash });
      if (r.status === 409) continue; // код занят — берём другой
      if (r.status !== 200 && r.status !== 201) {
        throw new Error('сервер пар недоступен (' + r.status + ') — воркер v26 задеплоен?');
      }
      cur.rec.alias = { code, adminEnc: await encryptWithVault(admin), scheme: 2, createdAt: Date.now() };
      await saveRoom(cur.rec);
      return true;
    }
    throw new Error('не удалось подобрать свободный код');
  } catch (e) {
    note('Не удалось создать короткую ссылку: ' + e.message);
    return false;
  }
}

export async function aliasRevokeCurrent() {
  if (!cur?.rec.alias) return true;
  try {
    const admin = await decryptWithVault(cur.rec.alias.adminEnc);
    const codeHash = await codeAddrForScheme('alias', cur.rec.alias.code, cur.rec.alias.scheme);
    const r = await pairApi('/pair/revoke', { codeHash, admin });
    if (r.status !== 200 && r.status !== 404) {
      throw new Error('сервер пар отклонил отзыв (' + r.status + ')');
    }
    cur.rec.alias = null;
    await saveRoom(cur.rec);
    return true;
  } catch (e) {
    note('Не удалось отозвать короткую ссылку: ' + e.message);
    return false;
  }
}

export async function renderAliasBox() {
  const box = $('#chatAliasBox');
  if (!box || !cur) return;
  box.classList.remove('hidden');
  // Создание — автоматически при первом открытии блока.
  if (!cur.rec.alias) await aliasCreate();
  const input = $('#aliasLink');
  const state = $('#aliasState');
  if (cur.rec.alias) {
    if (input) input.value = joinLinkOf(cur.rec.alias.code);
    if (state) {
      state.textContent =
        'Постоянная короткая ссылка этой комнаты. Работает, пока вы её не отзовёте; длинная ссылка при этом остаётся главным ключом.' +
        (cur.rec.alias.scheme === 2
          ? ''
          : ' Ссылка выпущена старой версией (адрес на сервере без медленного KDF) — нажмите «Перевыпустить», чтобы перейти на усиленную схему.');
    }
  } else if (state) {
    state.textContent = 'Короткая ссылка не создана.';
  }
}

// Подключение по постоянной ссылке. Возвращает true при успехе.
export async function redeemJoin(codeRaw) {
  const code = String(codeRaw || '').trim();
  if (!/^[A-Za-z0-9_-]{9}$/.test(code)) {
    note('Код подключения — 9 символов.');
    return false;
  }
  try {
    note('Проверяю короткую ссылку…');
    const { r, key } = await claimCode(await codeAccess('alias', code));
    if (r.status === 404) return false;
    if (r.status === 429) {
      note('Слишком много подключений по этому коду за час — подождите или попросите длинную ссылку.');
      return false;
    }
    if (r.status !== 200 || !r.data.blob) {
      note('Сервер пар отклонил запрос: ' + r.status);
      return false;
    }
    const payload = await openCodeBlob(key, r.data.blob);
    if (!payload?.seed) {
      note('Не удалось расшифровать приглашение этим кодом.');
      return false;
    }
    note('');
    await openRoomBySeed(payload.seed);
    return true;
  } catch (e) {
    note('Не удалось подключиться по короткой ссылке: ' + e.message);
    return false;
  }
}

// Единая точка входа для кода из 9 символов (поле на главном экране).
// Пространства разные: greet — одноразовый, join — постоянный. Порядок
// важен: СНАЧАЛА пробуем алиас (его claim ничего не сжигает), при 404 —
// greet (его claim одноразовый, поэтому он второй, а не первый).
export async function redeemCode(code) {
  if (await redeemJoin(code)) return;
  await redeemGreet(code);
}

// ---------- Кодовое слово (v30, rendezvous — режим 'word' PairingDO) ----------
// Владелец задаёт фразу из 3+ слов; blob {seed, roomId} запечатан ключом
// PBKDF2(фраза, 'zv-word-v1', 600k). Встреча одноразовая, TTL 24 часа,
// отзыв — тем же /pair/revoke по admin, что и алиас. Фраза на сервере не
// бывает: только SHA-256 её нормализованной формы как адрес DO.
export const WORD_TTL_MS_CLIENT = 24 * 3600000;

export const wordParts = (phraseRaw) => {
  const norm = normalizeWordPhrase(phraseRaw);
  return { norm, words: norm ? norm.split(' ') : [] };
};

// Отзыв встречи из записи комнаты (общий путь для «Отключить», смены
// фразы, удаления чата). 404 = встречи уже нет (истекла/использована) — ок.
export async function wordRevokeCurrent(rec) {
  if (!rec?.word) return true;
  const admin = await decryptWithVault(rec.word.adminEnc);
  const phrase = await decryptWithVault(rec.word.phraseEnc);
  const codeHash = await codeAddrForScheme('word', phrase, rec.word.scheme);
  const r = await pairApi('/pair/revoke', { codeHash, admin });
  if (r.status !== 200 && r.status !== 404) {
    throw new Error('сервер пар отклонил отзыв (' + r.status + ')');
  }
  rec.word = null;
  await saveRoom(rec);
  return true;
}

export async function wordEnable() {
  if (!cur) return;
  const { norm, words } = wordParts($('#wordPhraseInput')?.value || '');
  if (words.length < 3) {
    renderWordHint(words.length);
    note('Кодовая фраза — минимум 3 слова: одно-два слова перебираются слишком быстро.');
    return;
  }
  try {
    // Прежняя встреча гасится, чтобы живых фраз у комнаты было не две.
    if (cur.rec.word) await wordRevokeCurrent(cur.rec).catch(() => {});
    const seed = await decryptWithVault(cur.rec.seedEnc);
    const acc = await codeAccess('word', norm);
    const blob = await sealCodeBlob(acc.key, { seed, roomId: cur.rec.roomId });
    const codeHash = acc.addr;
    const admin = b64u.enc(crypto.getRandomValues(new Uint8Array(16))); // 128 бит
    const adminHash = await sha256hex(admin);
    const exp = Date.now() + WORD_TTL_MS_CLIENT;
    const r = await pairApi('/pair/word', { codeHash, blob, exp, adminHash });
    if (r.status === 409) {
      note('Эта фраза уже занята другой встречей — придумайте другую: адрес фразы один на всех.');
      return;
    }
    if (r.status !== 200 && r.status !== 201) {
      throw new Error('сервер пар недоступен (' + r.status + ') — воркер v30 задеплоен?');
    }
    cur.rec.word = {
      phraseEnc: await encryptWithVault(norm),
      adminEnc: await encryptWithVault(admin),
      exp,
      scheme: 2,
    };
    await saveRoom(cur.rec);
    await renderWordBox();
    note('Доступ по кодовому слову включён на 24 часа. Продиктуйте фразу собеседнику голосом: встреча одноразовая, после его входа фраза сгорит.');
  } catch (e) {
    note('Не удалось включить доступ по слову: ' + e.message);
  }
}

export async function wordDisable() {
  if (!cur) return;
  try {
    await wordRevokeCurrent(cur.rec);
    await renderWordBox();
    note('Доступ по кодовому слову отключён.');
  } catch (e) {
    note('Не удалось отключить доступ по слову: ' + e.message);
  }
}

export function renderWordHint(count) {
  const hint = $('#wordPhraseHint');
  if (!hint) return;
  hint.textContent =
    count < 3
      ? `Слов: ${count} из минимум 3. Регистр, лишние пробелы и буква ё не важны.`
      : `Слов: ${count}. Фразу такой длины подобрать практически невозможно.`;
}

export async function renderWordBox() {
  const box = $('#chatWordBox');
  if (!box || !cur) return;
  box.classList.remove('hidden');
  const state = $('#wordState');
  const input = $('#wordPhraseInput');
  let w = cur.rec.word;
  if (w && w.exp <= Date.now()) {
    // Срок вышел — сервер встречу уже не отдаст; локально просто забываем.
    cur.rec.word = null;
    await saveRoom(cur.rec);
    w = null;
  }
  if (w) {
    try {
      const phrase = await decryptWithVault(w.phraseEnc);
      if (input && document.activeElement !== input) {
        input.value = phrase;
        renderWordHint(wordParts(phrase).words.length);
      }
    } catch {}
    if (state) {
      state.textContent =
        'Активно до ' + fmtDayTime(w.exp) + '. Встреча одноразовая: после первого входа собеседника фраза сгорит.';
    }
  } else if (state) {
    state.textContent = 'Сейчас доступ по слову выключен.';
  }
  const disableBtn = $('#wordDisable');
  if (disableBtn) disableBtn.disabled = !w;
}

// Поиск чата по фразе с главного экрана. Возвращает true при успехе.
// Любая неудача (нет встречи, истекла, сожжена попытками, blob не
// открылся этой фразой) — одним понятным текстом, без деталей сервера.
export async function redeemWord(phraseRaw) {
  const { norm, words } = wordParts(phraseRaw);
  const fail = () =>
    note('Чат по этой фразе не найден: проверьте фразу или срок (встреча живёт сутки и одноразовая).');
  if (!norm || words.length < 2) {
    fail();
    return false;
  }
  try {
    note('Ищу чат по кодовой фразе…');
    const { r, key } = await claimCode(await codeAccess('word', norm));
    if (r.status !== 200 || !r.data.blob) {
      fail();
      return false;
    }
    const payload = await openCodeBlob(key, r.data.blob);
    if (!payload?.seed) {
      fail();
      return false;
    }
    note('');
    await openRoomBySeed(payload.seed);
    return true;
  } catch (e) {
    note('Не удалось найти чат по фразе: ' + e.message);
    return false;
  }
}
