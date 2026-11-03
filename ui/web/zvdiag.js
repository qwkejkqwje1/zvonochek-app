// ZVONochek v36 — ранняя диагностика загрузки (классический скрипт, НЕ модуль, ES5).
// Подключается в index.html ПЕРЕД модульными скриптами, чтобы перехватить и их
// ошибки загрузки. Отдельным файлом, а не inline: CSP страницы
// (script-src 'self') запрещает inline-скрипты — inline-вариант молча не
// выполнился бы, то есть повторил бы ровно тот класс бага, который чинит v22.
// Собирает window.__zvErrors (события error + unhandledrejection), дублирует
// в localStorage 'zvLastErrors' (макс. 10) и показывает видимый баннер
// #zvDiag при сбое загрузки модулей (watchdog, 9 с после DOMContentLoaded).
// v23: проба окружения window.__zvProbe() — WebCrypto присутствует не всегда
// полностью: у владельца v22 баннер показал «crypto.subtle.generateKeyPair
// is not a function» при живом importKey/deriveKey (звонки работали, а
// генерация ключей — нет). Поэтому окружение проверяется СРАЗУ при загрузке,
// а не по нажатию кнопки, и его сводка дописывается к каждому баннеру.
// v36: «ворота» старого браузера. Если браузер не умеет модули/ES2020,
// WebRTC или IndexedDB, вместо молчаливо пустого экрана (так выглядел сбой
// на старом телефоне) сразу показываем понятный экран «обновите браузер».
(function () {
  var MAX = 10;
  var gateShown = false;
  window.__zvErrors = [];
  function pushErr(msg, src) {
    try {
      window.__zvErrors.push({ msg: String(msg || 'unknown error'), src: String(src || ''), ts: Date.now() });
      if (window.__zvErrors.length > MAX) window.__zvErrors.splice(0, window.__zvErrors.length - MAX);
      try {
        localStorage.setItem('zvLastErrors', JSON.stringify(window.__zvErrors));
      } catch (x) {}
    } catch (x) {}
  }
  window.addEventListener('error', function (ev) {
    var msg = ev.message || (ev.error && ev.error.message) || 'error';
    pushErr(msg, ev.filename || '');
    // Синтаксис модулей не разобрался — браузер старше ES2020 (обычно Chrome < 80).
    if (/SyntaxError|Unexpected token|expected expression|Invalid character/i.test(String(msg))) {
      showGate(['этот браузер не понимает современный JavaScript (ES2020)']);
    }
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    pushErr('unhandledrejection: ' + ((r && r.message) || r || 'unknown'), '');
  });
  // ---------- v36: экран «обновите браузер» ----------
  function missingFeatures() {
    var out = [];
    try {
      if (!('noModule' in document.createElement('script'))) out.push('нет поддержки JS-модулей');
    } catch (x) {}
    if (typeof window.BigInt !== 'function' || typeof Promise === 'undefined' || typeof Promise.allSettled !== 'function') {
      out.push('устаревший движок JavaScript (нужен уровень ES2020)');
    }
    if (typeof window.RTCPeerConnection !== 'function') out.push('нет WebRTC — звонки невозможны');
    if (!window.indexedDB) out.push('нет IndexedDB — ключи и чаты негде хранить');
    return out;
  }
  function el(tag, css, text) {
    var n = document.createElement(tag);
    n.setAttribute('style', css);
    if (text) n.appendChild(document.createTextNode(text));
    return n;
  }
  function showGate(reasons) {
    if (gateShown || !document.body) return;
    gateShown = true;
    try {
      var wrap = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;background:#0e1621;color:#f5f7fa;' +
        'font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow:auto;padding:24px 18px;box-sizing:border-box');
      wrap.id = 'zvGate';
      wrap.setAttribute('role', 'alertdialog');
      var card = el('div', 'max-width:460px;margin:8vh auto 0;background:#17212b;border-radius:18px;padding:26px 22px;' +
        'box-shadow:0 10px 40px rgba(0,0,0,.4)');
      card.appendChild(el('div', 'font-size:44px;line-height:1;margin-bottom:14px', '\u23F3'));
      card.appendChild(el('div', 'font-size:20px;font-weight:700;margin-bottom:8px', 'Браузер устарел'));
      card.appendChild(el('div', 'color:#aab8c5;margin-bottom:14px',
        'ZVONochek шифрует звонки и сообщения прямо в браузере, а этот браузер не умеет нужного:'));
      var ul = el('ul', 'margin:0 0 16px;padding-left:20px;color:#f5f7fa');
      for (var i = 0; i < reasons.length; i++) ul.appendChild(el('li', 'margin:2px 0', reasons[i]));
      card.appendChild(ul);
      card.appendChild(el('div', 'font-weight:600;margin-bottom:6px', 'Что сделать (2 минуты):'));
      var ol = el('ol', 'margin:0 0 18px;padding-left:20px;color:#d6e0ea');
      ol.appendChild(el('li', 'margin:3px 0', 'Обновите Chrome через Google Play / App Store.'));
      ol.appendChild(el('li', 'margin:3px 0', 'Или установите Firefox либо Яндекс Браузер и откройте эту же ссылку в нём.'));
      ol.appendChild(el('li', 'margin:3px 0', 'На iPhone обновите iOS до 14 или новее (Safari обновляется вместе с ней).'));
      card.appendChild(ol);
      var btn = el('button', 'width:100%;border:0;border-radius:12px;padding:12px 14px;background:#2b5278;color:#fff;' +
        'font:inherit;font-weight:600;cursor:pointer', 'Всё равно попробовать');
      btn.type = 'button';
      btn.onclick = function () {
        try { wrap.parentNode.removeChild(wrap); } catch (x) {}
      };
      card.appendChild(btn);
      card.appendChild(el('div', 'color:#6d7f8f;font-size:12px;margin-top:12px;word-break:break-word',
        'Для разработчика: ' + (window.__zvEnvText ? window.__zvEnvText() : '')));
      wrap.appendChild(card);
      document.body.appendChild(wrap);
    } catch (x) {}
  }
  window.__zvShowGate = showGate;
  // ---------- Проба окружения (v23) ----------
  window.__zvProbe = function () {
    var s = null;
    try {
      s = window.crypto && window.crypto.subtle ? window.crypto.subtle : null;
    } catch (x) {}
    var ua = '';
    try {
      ua = String(navigator.userAgent || '').slice(0, 80);
    } catch (x) {}
    return {
      ua: ua,
      secure: !!window.isSecureContext,
      subtle: typeof (window.crypto && window.crypto.subtle),
      gen: s ? typeof s.generateKeyPair : 'undefined',
      sign: s ? typeof s.sign : 'undefined',
      imp: s ? typeof s.importKey : 'undefined',
      enc: s ? typeof s.encrypt : 'undefined',
    };
  };
  window.__zvEnvText = function () {
    var p = window.__zvProbe();
    return (
      'secure=' + p.secure +
      ', subtle=' + p.subtle +
      ', generateKeyPair=' + p.gen +
      ', sign=' + p.sign +
      ', importKey=' + p.imp +
      ', encrypt=' + p.enc +
      ', UA: ' + p.ua
    );
  };
  window.__zvShowDiag = function (text) {
    try {
      text = String(text);
      if (text.indexOf('[окружение:') === -1) {
        try {
          text += ' [окружение: ' + window.__zvEnvText() + ']';
        } catch (x) {}
      }
      var d = document.getElementById('zvDiag');
      if (!d) {
        d = document.createElement('div');
        d.id = 'zvDiag';
        d.className = 'zv-diag';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = text + ' ✕';
      // Закрытие по клику на баннер (обработчик вешается один раз на элемент).
      if (!d.__zvCloseBound) {
        d.__zvCloseBound = true;
        d.addEventListener('click', function () {
          try {
            d.classList.add('hidden');
            d.style.display = 'none';
          } catch (x) {}
        });
      }
      d.classList.remove('hidden');
      d.style.display = 'block';
    } catch (x) {}
  };
  function errorsText() {
    if (!window.__zvErrors.length) return 'ошибок не зафиксировано — сообщите разработчику';
    return window.__zvErrors
      .map(function (e) {
        return e.msg + (e.src ? ' (' + e.src + ')' : '');
      })
      .join(' | ');
  }
  function watchdog() {
    if (gateShown) return; // причина уже объяснена экраном «обновите браузер»
    var missing = [];
    if (!window.__zvAppBooted) missing.push('приложения');
    if (!window.__zvChatBooted) missing.push('чата');
    if (!missing.length) return; // оба модуля живы; ошибки остаются в __zvErrors/localStorage, баннер не показываем
    var what =
      missing.length === 2 ? 'Модули приложения и чата не загрузились' : 'Модуль ' + missing[0] + ' не загрузился';
    window.__zvShowDiag('ZVONochek: ' + what + '. Ошибки: ' + errorsText() + '. Пришлите этот текст разработчику.');
  }
  // v23: проверка окружения при загрузке. Если WebCrypto нет совсем,
  // ничего не заработает — предупреждаем сразу, а не по нажатию.
  // v24: отсутствие только generateKeyPair больше НЕ фатально — у
  // identity.js/app.js есть fallback генерации пары P-256 (crypto.js:
  // genP256KeyPair считает публичную точку на BigInt и импортирует пару
  // через importKey, который в таких окружениях жив). Поэтому при живом
  // subtle и мёртвом generateKeyPair баннер не показываем; проба
  // (__zvProbe/__zvEnvText) по-прежнему дописывается к любому баннеру.
  function envCheck() {
    var lacks = missingFeatures();
    if (lacks.length) {
      showGate(lacks);
      return;
    }
    var p = window.__zvProbe();
    if (p.subtle !== 'object') {
      window.__zvShowDiag(
        'Этот браузер не даёт работать с шифрованием (нет crypto.subtle) — ' +
          'звонки, личная ссылка и чаты здесь не заработают. ' +
          'Откройте сайт в актуальном Chrome/Firefox/Safari по https.'
      );
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      envCheck();
      setTimeout(watchdog, 9000);
    });
  } else {
    envCheck();
    setTimeout(watchdog, 9000);
  }
})();
