(() => {
  'use strict';
  const { call, esc, $ } = window.V;
  const I = window.VexaIcons;

  const h = new Date().getHours();
  $('#greeting').textContent = h < 5 ? 'Up late? The web never sleeps.' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#search-icon').innerHTML = I.search;

  async function setPlaceholder() {
    const [s, engines] = await Promise.all([call('settings.get'), call('settings.engines')]);
    const engine = engines.find((e) => e.id === s.searchEngine);
    $('#q').placeholder = `Search ${engine ? engine.name : 'the web'} or type a URL`;
  }

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#q').value.trim();
    if (v) call('nav.open', v, 'current');
  });

  async function renderTiles() {
    const [sites, s] = await Promise.all([call('history.topSites', 8), call('settings.get')]);
    const box = $('#tiles');
    box.innerHTML = '';
    $('#tiles-empty').hidden = sites.length > 0;
    $('#restore').hidden = !s.hiddenTopSites.length;
    for (const site of sites) {
      const a = document.createElement('a');
      a.className = 'tile';
      a.href = site.url;
      let host = site.origin;
      try {
        host = new URL(site.url).hostname.replace(/^www\./, '');
      } catch {
        /* keep */
      }
      const title = site.title && site.title.length < 40 ? site.title : host;
      const letter = esc((host[0] || '?').toUpperCase());
      a.innerHTML = `<div class="tile-icon"></div><div class="tile-title">${esc(title)}</div><button class="tile-x" title="Remove from this page">${I.close}</button>`;
      const icon = a.querySelector('.tile-icon');
      const src = site.favicon || site.origin + '/favicon.ico';
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      img.onerror = () => (icon.innerHTML = letter);
      icon.appendChild(img);
      a.title = `${site.title || host}\n${site.url}`;
      a.addEventListener('click', (e) => {
        if (e.target.closest('.tile-x')) return;
        window.V.openFromEvent(e, site.url);
      });
      a.addEventListener('auxclick', (e) => {
        if (e.button === 1) window.V.openFromEvent(e, site.url);
      });
      a.querySelector('.tile-x').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await call('history.hideTopSite', site.origin);
        renderTiles();
      });
      box.appendChild(a);
    }
  }

  $('#restore-btn').addEventListener('click', async () => {
    await call('history.restoreTopSites');
    renderTiles();
  });

  window.V.on('settings', (p) => {
    if (p && p.key === 'searchEngine') setPlaceholder();
  });

  setPlaceholder();
  renderTiles();
})();
