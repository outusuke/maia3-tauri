// Loaded from <head> as a file (the CSP blocks inline scripts) so the theme is set before first paint.
(function () {
  const KEY = "maia3.theme";
  const THEMES = ["minimal", "skeuo"];

  function get() {
    try {
      const saved = localStorage.getItem(KEY);
      if (THEMES.includes(saved)) return saved;
    } catch {}
    return "minimal";
  }

  function set(theme) {
    if (!THEMES.includes(theme)) return;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch {}
  }

  document.documentElement.dataset.theme = get();
  window.maiaTheme = { get, set };
})();
