// @excellent-so/kit: the little behaviour the parts need, no dependencies. Load it with `defer`.
//
//   Theme   light by default whatever the OS says; a [data-ex-theme-toggle] button flips it, and the choice
//           is kept (localStorage "ex-theme"). Put the one-line snippet from the README in <head> to restore
//           it before the first paint.
//   Copy    a [data-ex-copy] button copies its value (or the text of the element its value names, "#id"),
//           shows "Copied" in the kit's amber for 1.6 s, then goes back.
//   Nav     a [data-ex-nav-toggle] button opens the shell's sidebar on a phone. A tap on the scrim, Escape,
//           or a link in the sidebar closes it again (the open sidebar covers the button).
//   Sort    a table with [data-ex-sort] sorts by a header click (numbers as numbers).
(function () {
  var root = document.documentElement;
  var KEY = 'ex-theme';

  function setTheme(t) {
    root.classList.toggle('theme-dark', t === 'dark');
    try { localStorage.setItem(KEY, t); } catch (e) {}
    document.querySelectorAll('[data-ex-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(t === 'dark'));
    });
  }
  function theme() { return root.classList.contains('theme-dark') ? 'dark' : 'light'; }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } finally { t.remove(); }
    return Promise.resolve();
  }

  function setNav(shell, open) {
    shell.toggleAttribute('data-nav-open', open);
    document.querySelectorAll('[data-ex-nav-toggle]').forEach(function (b) { b.setAttribute('aria-expanded', String(open)); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var openShell = t.closest('.ex-shell[data-nav-open]');
    if (openShell) {
      if (t === openShell) { setNav(openShell, false); return; } // the scrim is the shell's ::after
      if (t.closest('.ex-sidebar a[href]')) setNav(openShell, false); // a choice was made; the link still works
    }
    var toggle = t.closest('[data-ex-theme-toggle]');
    if (toggle) { setTheme(theme() === 'dark' ? 'light' : 'dark'); return; }
    var nav = t.closest('[data-ex-nav-toggle]');
    if (nav) {
      var shell = nav.closest('.ex-shell') || document.querySelector('.ex-shell');
      if (shell) setNav(shell, !shell.hasAttribute('data-nav-open'));
      return;
    }
    var c = t.closest('[data-ex-copy]');
    if (c) {
      var v = c.getAttribute('data-ex-copy');
      var src = v && v.charAt(0) === '#' ? document.querySelector(v) : null;
      var text = src ? src.textContent.trim() : v;
      copyText(text).then(function () {
        var label = c.dataset.exLabel || c.textContent;
        c.dataset.exLabel = label;
        c.classList.add('is-copied');
        c.textContent = 'Copied';
        clearTimeout(c._exT);
        c._exT = setTimeout(function () { c.classList.remove('is-copied'); c.textContent = label; }, 1600);
      });
      return;
    }
    var th = t.closest('table[data-ex-sort] th');
    if (th) sortBy(th);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var shell = document.querySelector('.ex-shell[data-nav-open]');
    if (!shell) return;
    setNav(shell, false);
    var b = document.querySelector('[data-ex-nav-toggle]');
    if (b) b.focus();
  });

  function sortBy(th) {
    var table = th.closest('table'), body = table.tBodies[0];
    if (!body) return;
    var i = Array.prototype.indexOf.call(th.parentNode.children, th);
    var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
    th.parentNode.querySelectorAll('th').forEach(function (h) { h.removeAttribute('aria-sort'); });
    th.setAttribute('aria-sort', dir);
    var rows = Array.prototype.slice.call(body.rows);
    var val = function (r) { var c = r.cells[i]; return c ? (c.getAttribute('data-sort') || c.textContent.trim()) : ''; };
    rows.sort(function (a, b) {
      var x = val(a), y = val(b), nx = parseFloat(x.replace(/[^0-9.-]/g, '')), ny = parseFloat(y.replace(/[^0-9.-]/g, ''));
      var r = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
      return dir === 'ascending' ? r : -r;
    });
    rows.forEach(function (r) { body.appendChild(r); });
  }

  // Restore a choice made before (without saving one nobody made), and label the toggles.
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === 'dark') root.classList.add('theme-dark');
  document.querySelectorAll('[data-ex-theme-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', String(theme() === 'dark')); });
  window.ExKit = { setTheme: setTheme, theme: theme, copy: copyText };
})();
