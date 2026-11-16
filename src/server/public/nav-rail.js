(function () {
  var mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function systemTheme() {
    if (mqLight && mqLight.matches) return 'light';
    if (mqDark && mqDark.matches) return 'dark';
    return 'dark';
  }

  function readExplicitCookie() {
    var match = document.cookie.match(/(?:^|;\s*)ob_theme=(light|dark)(?:;|$)/);
    return match ? match[1] : null;
  }

  function applyTheme(theme, explicitCookie) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    if (document.documentElement.style) document.documentElement.style.colorScheme = t;
    var meta = document.querySelector && document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = explicitCookie || 'light dark';
    document.querySelectorAll('#obSideRail .rt-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-theme-set') === t;
      btn.classList.toggle('on', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateThemePreference(theme) {
    var next = theme === 'light' ? 'light' : 'dark';
    var current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    if (next === current) return;
    var sys = systemTheme();
    if (next !== sys) {
      document.cookie = 'ob_theme=' + next + '; path=/; max-age=31536000; SameSite=Lax';
      applyTheme(next, next);
    } else {
      document.cookie = 'ob_theme=; path=/; max-age=0; SameSite=Lax';
      applyTheme(next, null);
    }
  }

  // First default follows the browser preference; cookie only exists when explicitly modified
  var initialOverride = readExplicitCookie();
  applyTheme(initialOverride || systemTheme(), initialOverride);

  var onSystemChange = function () {
    if (!readExplicitCookie()) applyTheme(systemTheme(), null);
  };
  [mqDark, mqLight].forEach(function (mq) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
    else if (mq.addListener) mq.addListener(onSystemChange);
  });

  function mountNavRail() {
    if (!document.body || !document.body.classList.contains('has-ob-rail')) return;
    if (document.getElementById('obSideRail')) return;

    // Never auto-expand on navigation; only toggle when #obRailToggle is clicked
    try {
      localStorage.removeItem('ob_rail_expanded');
    } catch (_e) {
      // Ignore storage errors
    }

    const path = (location.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    const isOrderBlock = path === '/' || path === '/app' || path === '/app/orderblock';
    const isSettings = path === '/settings' || path === '/app/settings';

    const curTheme =
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

    const aside = document.createElement('aside');
    aside.className = 'ob-side-rail';
    aside.id = 'obSideRail';
    aside.setAttribute('aria-label', 'Primary Navigation');
    aside.innerHTML =
      '<div class="rail-top">' +
        '<a href="/app/orderblock" class="rail-logo" title="Order Block">' +
          '<span class="logo-bars" aria-hidden="true">' +
            '<i class="b1"></i>' +
            '<i class="b2"></i>' +
            '<i class="b3"></i>' +
          '</span>' +
          '<span class="rail-lbl rail-brand-lbl">Terminal</span>' +
        '</a>' +
        '<button type="button" class="rail-collapse" id="obRailToggle" title="Expand / Collapse sidebar" aria-label="Toggle sidebar">»</button>' +
        '<div class="rail-divider"></div>' +
        '<a href="/app/orderblock" class="rail-item' + (isOrderBlock ? ' active' : '') + '" title="Order Block Terminal (/app/orderblock)" data-tip="Order Block"' + (isOrderBlock ? ' aria-current="page"' : '') + '>' +
          '<span class="rail-ic">⟁</span>' +
          '<span class="rail-lbl">Order Block</span>' +
        '</a>' +
      '</div>' +
      '<div class="rail-bottom">' +
        '<div class="rail-live" title="Live 218 NSE F&amp;O Feed" data-tip="Live 218 F&O">' +
          '<span class="rail-live-dot"></span>' +
          '<span class="rail-lbl">218 Live</span>' +
        '</div>' +
        '<div class="rail-theme-pill" role="group" aria-label="Theme toggle">' +
          '<button type="button" class="rt-btn' + (curTheme === 'light' ? ' on' : '') + '" data-theme-set="light" title="Light theme" aria-label="Light theme">☀</button>' +
          '<button type="button" class="rt-btn' + (curTheme === 'dark' ? ' on' : '') + '" data-theme-set="dark" title="Dark theme" aria-label="Dark theme">☾</button>' +
        '</div>' +
        '<a href="/app/settings" class="rail-item' + (isSettings ? ' active' : '') + '" id="obSettingsBtn" title="Settings · Upstox API &amp; Rules (/app/settings)" data-tip="Settings"' + (isSettings ? ' aria-current="page"' : '') + '>' +
          '<span class="rail-ic" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<circle cx="12" cy="12" r="3"></circle>' +
              '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
            '</svg>' +
          '</span>' +
          '<span class="rail-lbl">Settings</span>' +
        '</a>' +
      '</div>';

    document.body.insertBefore(aside, document.body.firstChild);

    const syncRailWidthVar = function () {
      document.documentElement.style.setProperty('--rail-w', aside.offsetWidth + 'px');
    };
    syncRailWidthVar();

    const toggleBtn = document.getElementById('obRailToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        const exp = document.body.classList.toggle('rail-expanded');
        toggleBtn.textContent = exp ? '«' : '»';
        requestAnimationFrame(syncRailWidthVar);
      });
    }

    aside.querySelectorAll('.rt-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const next = btn.getAttribute('data-theme-set') || 'dark';
        updateThemePreference(next);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountNavRail);
  } else {
    mountNavRail();
  }
})();
