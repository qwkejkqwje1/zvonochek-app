// ZVONochek v38 — выбор оформления до первой отрисовки (без мигания).
// «ZVON» — новое фирменное оформление (графит + сигнальный красный),
// «classic» — прежний вид в духе Telegram Night: откат одним переключателем
// в настройках (localStorage zvSkin). Классический скрипт без модулей — CSP
// script-src 'self' разрешает его, а атрибут ставится раньше CSS-отрисовки.
(function () {
  var THEME = { zvon: '#121216', classic: '#17212b' };
  var ICON = { zvon: 'icon.svg', classic: 'icons/icon-classic.svg' };
  function apply(skin) {
    var s = skin === 'classic' ? 'classic' : 'zvon';
    var d = document.documentElement;
    d.setAttribute('data-skin', s);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', THEME[s]);
    var l = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    if (l) l.setAttribute('href', ICON[s]);
    return s;
  }
  var cur = 'zvon';
  try {
    if (localStorage.getItem('zvSkin') === 'classic') cur = 'classic';
  } catch (e) {}
  apply(cur);
  window.__zvSkin = {
    get: function () {
      return document.documentElement.getAttribute('data-skin') || 'zvon';
    },
    set: function (s) {
      var v = apply(s);
      try {
        localStorage.setItem('zvSkin', v);
      } catch (e) {}
      return v;
    },
  };
})();
