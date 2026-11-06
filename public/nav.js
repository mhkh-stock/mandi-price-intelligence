'use strict';
// Shared kebab-menu behaviour for every page: toggle on click, close on
// selection, outside tap, and Escape. Also marks the current page's link
// inside the menu with aria-current="page".
(function () {
  const btn = document.getElementById('menuBtn');
  const menu = document.getElementById('siteMenu');
  if (!btn || !menu) return;
  function closeMenu() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function openMenu() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); btn.focus(); } });
  const here = window.location.pathname.split('/').pop() || 'index.html';
  menu.querySelectorAll('a[role="menuitem"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const page = href.split('#')[0].split('/').pop();
    if (page && page === here && href.indexOf('#') === -1) a.setAttribute('aria-current', 'page');
  });
})();
