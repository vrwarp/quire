(function () {
  try {
    var mode = localStorage.getItem('quire-theme-mode') || 'system';
    var dark =
      mode === 'dark' ||
      (mode !== 'light' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var resolved = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    var meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', dark ? '#121418' : '#ebe6dc');
  } catch (e) {
    // Ignore restricted storage contexts
  }
})();
