// Applied before first paint to avoid a theme flash.
(function () {
  try {
    var t = localStorage.getItem('zv.theme') || 'system';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
