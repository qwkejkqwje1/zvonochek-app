// chat-files.js — Файлы и голосовые сообщения
// v44: вынесено из chat.js без изменения логики (строки 3395–3675 v43).
import { FILE_CHUNK_PT, FILE_MAX_BYTES, b64u, decryptFileChunk, encryptFileChunk, importFileKey } from './crypto.js?v=44';
import { $, api, cur, fileState, fmtSize, note, sendMsg, voiceAudio } from './chat.js?v=44';

// ---------- Файлы (v25) ----------
export function setFileProgress(pct, label) {
  const box = $('#chatFileProgress');
  const fill = $('#chatFileProgressFill');
  const text = $('#chatFileProgressText');
  if (!box || !fill || !text) return;
  if (pct === null) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  fill.style.width = Math.round(pct * 100) + '%';
  text.textContent = label || '';
}

// extra.voice = {durSec} — голосовое сообщение: тот же файловый канал и то
// же шифрование, отличается только тип сообщения ('voice') и метаданные.
export async function uploadFile(file, extra = {}) {
  if (!cur) return;
  if (!cur.rec.nick) return note('Сначала введите никнейм.');
  // v28 (D): файловый канал существует только у воркера.
  if (cur.transportMode === 'fallback') {
    return note('Файлы и голосовые недоступны на резервном канале: дождитесь возврата основного сервера.');
  }
  if (file.size > FILE_MAX_BYTES) {
    return note(`Файл больше ${fmtSize(FILE_MAX_BYTES)} — лимит для чата.`);
  }
  try {
    const raw = new Uint8Array(await file.arrayBuffer());
    const keyRaw = crypto.getRandomValues(new Uint8Array(32));
    const fileKey = await importFileKey(keyRaw);
    const salt = crypto.getRandomValues(new Uint8Array(4));
    const fileId = b64u.enc(crypto.getRandomValues(new Uint8Array(12)));
    const total = Math.max(1, Math.ceil(raw.length / FILE_CHUNK_PT));
    for (let idx = 0; idx < total; idx++) {
      const chunk = raw.subarray(idx * FILE_CHUNK_PT, (idx + 1) * FILE_CHUNK_PT);
      const ct = await encryptFileChunk(fileKey, salt, idx, chunk);
      const r = await api(cur.keys.roomId, cur.keys.accessToken, '/file', {
        method: 'POST',
        body: { fileId, idx, total, blob: b64u.enc(ct) },
      });
      if (r.status !== 200 && r.status !== 201) {
        throw new Error('Сервер отклонил чанк файла: ' + r.status);
      }
      setFileProgress((idx + 1) / total, `Отправка файла ${idx + 1}/${total}…`);
    }
    const meta = {
      fileId,
      name: file.name || 'файл',
      size: raw.length,
      mime: file.type || 'application/octet-stream',
      chunks: total,
      salt: b64u.enc(salt),
      fileKey: b64u.enc(keyRaw),
    };
    if (extra.voice) meta.durSec = extra.voice.durSec || 0;
    await sendMsg(extra.voice ? 'voice' : 'file', JSON.stringify(meta));
    note(extra.voice ? 'Голосовое сообщение отправлено.' : 'Файл отправлен.');
  } catch (e) {
    note('Не удалось отправить файл: ' + e.message);
  } finally {
    setFileProgress(null);
  }
}

// opts.auto — автозагрузка (картинки ≤3 МБ и голосовые): не дёргаем
// сохранение файла по завершении, только заполняем кэш и превью/плеер.
export async function downloadFile(meta, card, opts = {}) {
  const st = fileState.get(meta.fileId) || {};
  if (st.busy) return;
  if (st.url) {
    if (opts.auto) return;
    // Уже скачан: для картинок превью уже в ленте, кнопка сохраняет файл.
    const a = document.createElement('a');
    a.href = st.url;
    a.download = meta.name || 'файл';
    a.click();
    return;
  }
  st.busy = true;
  st.error = '';
  fileState.set(meta.fileId, st);
  renderFileCardState(meta, card, st);
  try {
    const fileKey = await importFileKey(b64u.dec(meta.fileKey));
    const salt = b64u.dec(meta.salt);
    const parts = [];
    for (let idx = 0; idx < meta.chunks; idx++) {
      const r = await api(
        cur.keys.roomId,
        cur.keys.accessToken,
        `/file?fileId=${encodeURIComponent(meta.fileId)}&idx=${idx}`
      );
      if (r.status !== 200 || !r.data.blob) throw new Error('чанк ' + idx + ' недоступен');
      parts.push(await decryptFileChunk(fileKey, salt, idx, b64u.dec(r.data.blob)));
      st.progress = (idx + 1) / meta.chunks;
      renderFileCardState(meta, card, st);
    }
    const blob = new Blob(parts, { type: meta.mime || 'application/octet-stream' });
    st.url = URL.createObjectURL(blob);
    st.busy = false;
    st.progress = 1;
    fileState.set(meta.fileId, st);
    renderFileCardState(meta, card, st);
    if (!opts.auto && !(meta.mime || '').startsWith('image/')) {
      const a = document.createElement('a');
      a.href = st.url;
      a.download = meta.name || 'файл';
      a.click();
    }
  } catch (e) {
    st.busy = false;
    st.error = 'Ошибка загрузки: ' + e.message;
    fileState.set(meta.fileId, st);
    renderFileCardState(meta, card, st);
  }
}

export function renderFileCardState(meta, card, st) {
  if (!card) return;
  const btn = card.querySelector('.chat-file-btn');
  const info = card.querySelector('.chat-file-state');
  const prev = card.querySelector('.chat-file-preview');
  const barFill = card.querySelector('.chat-file-bar-fill');
  if (barFill) {
    barFill.style.width = st.busy || st.progress ? Math.round((st.progress || 0) * 100) + '%' : '0%';
  }
  if (btn) {
    btn.disabled = !!st.busy;
    btn.textContent = st.busy
      ? `Загрузка ${Math.round((st.progress || 0) * 100)}%`
      : st.url
        ? 'Сохранить файл'
        : st.error
          ? 'Повторить'
          : 'Скачать';
  }
  if (info) info.textContent = st.error || '';
  if (prev && st.url && (meta.mime || '').startsWith('image/') && !prev.firstChild) {
    const img = document.createElement('img');
    img.className = 'chat-file-img';
    img.alt = meta.name || 'изображение';
    img.src = st.url;
    prev.append(img);
  }
}

// ---------- Голосовые сообщения (v26) ----------
export const VOICE_MAX_MS = 10 * 60000;
export let voiceRec = null; // {mr, chunks, stream, startedAt, timer, discard}

export const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export function voiceUiRecording(on) {
  $('#chatRecBar')?.classList.toggle('hidden', !on);
  const bar = $('#chatroom .chat-input-bar');
  if (bar) bar.classList.toggle('hidden', on);
}

export async function startVoiceRec() {
  if (!cur) return;
  if (!cur.rec.nick) return note('Сначала введите никнейм.');
  if (voiceRec) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return note('Нет доступа к микрофону: ' + (e?.message || e));
  }
  try {
    const mime =
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
        (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
      ) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const rec = { mr, chunks: [], stream, startedAt: Date.now(), timer: null, discard: false };
    voiceRec = rec;
    mr.ondataavailable = (e) => {
      if (e.data?.size) rec.chunks.push(e.data);
    };
    mr.onstop = () => finishVoiceRec(rec);
    mr.start(250);
    voiceUiRecording(true);
    const tick = () => {
      const el = $('#chatRecTime');
      if (el) el.textContent = fmtDur((Date.now() - rec.startedAt) / 1000);
      if (Date.now() - rec.startedAt >= VOICE_MAX_MS) stopVoiceRec(true); // автостоп 10 минут — отправить
    };
    tick();
    rec.timer = setInterval(tick, 250);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    voiceRec = null;
    note('Не удалось начать запись: ' + (e?.message || e));
  }
}

export function stopVoiceRec(send) {
  if (!voiceRec) return;
  voiceRec.discard = !send;
  try {
    voiceRec.mr.stop();
  } catch {
    finishVoiceRec(voiceRec);
  }
}

export async function finishVoiceRec(rec) {
  if (voiceRec !== rec) return;
  voiceRec = null;
  if (rec.timer) clearInterval(rec.timer);
  rec.stream?.getTracks().forEach((t) => t.stop());
  voiceUiRecording(false);
  if (rec.discard || !rec.chunks.length) return;
  const type = rec.mr.mimeType || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
  const durSec = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));
  const file = new File([blob], 'voice.' + ext, { type });
  await uploadFile(file, { voice: { durSec } }).catch(() => {});
}

// Плеер голосового: play/pause, прогресс по timeupdate, перемотка кликом.
export function wireVoicePlayer(wrap, meta) {
  const btn = wrap.querySelector('.chat-voice-play');
  const bar = wrap.querySelector('.chat-voice-bar');
  const fill = wrap.querySelector('.chat-voice-fill');
  const time = wrap.querySelector('.chat-voice-time');
  const total = meta.durSec || 0;
  if (time) time.textContent = fmtDur(total);
  const ensureAudio = () => {
    let a = voiceAudio.get(meta.fileId);
    if (!a) {
      const st = fileState.get(meta.fileId);
      if (!st?.url) return null;
      a = new Audio(st.url);
      voiceAudio.set(meta.fileId, a);
      a.addEventListener('timeupdate', () => {
        const dur = a.duration || total;
        if (fill && dur) fill.style.width = (a.currentTime / dur) * 100 + '%';
        if (time) time.textContent = fmtDur(a.currentTime) + ' / ' + fmtDur(dur);
      });
      a.addEventListener('ended', () => {
        if (btn) btn.textContent = '▶';
        if (fill) fill.style.width = '0%';
        if (time) time.textContent = fmtDur(total);
      });
    }
    return a;
  };
  if (btn) {
    btn.onclick = async () => {
      const st = fileState.get(meta.fileId);
      if (!st?.url && !st?.busy) {
        await downloadFile(meta, wrap.closest('.chat-file') || wrap, { auto: true }).catch(() => {});
      }
      const a = ensureAudio();
      if (!a) return;
      if (a.paused) {
        for (const other of voiceAudio.values()) if (other !== a) other.pause();
        await a.play().catch(() => {});
        btn.textContent = '⏸';
      } else {
        a.pause();
        btn.textContent = '▶';
      }
    };
  }
  if (bar) {
    bar.onclick = (e) => {
      const a = ensureAudio();
      if (!a || !a.duration) return;
      const r = bar.getBoundingClientRect();
      a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
    };
  }
}
