(() => {
  'use strict';
  const { call, esc, $, fmtBytes, dayLabel, hostOf, debounce } = window.V;
  const I = window.VexaIcons;
  $('#side').innerHTML = window.V.sidebar('downloads');
  $('#search-ico').innerHTML = I.search;

  function status(r) {
    if (r.state === 'progressing' || r.state === 'paused') {
      const pct = r.totalBytes ? ` (${Math.round((r.receivedBytes / r.totalBytes) * 100)}%)` : '';
      return `${r.state === 'paused' ? 'Paused · ' : ''}${fmtBytes(r.receivedBytes)}${r.totalBytes ? ' of ' + fmtBytes(r.totalBytes) : ''}${pct}`;
    }
    if (r.state === 'completed') return r.exists === false ? 'File deleted or moved' : fmtBytes(r.totalBytes);
    if (r.state === 'cancelled') return 'Cancelled';
    return 'Failed';
  }

  async function render() {
    const q = $('#q').value.trim().toLowerCase();
    let list = await call('downloads.list');
    if (q) list = list.filter((r) => r.filename.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
    const box = $('#list');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = `<div class="empty"><img class="mark" src="vexa://shared/logo.svg" alt=""><div>${q ? 'No downloads match.' : 'Files you download will appear here.'}</div></div>`;
      return;
    }
    let lastDay = '';
    let card = null;
    for (const r of list) {
      const day = dayLabel(r.startTime);
      if (day !== lastDay) {
        lastDay = day;
        const g = document.createElement('section');
        g.className = 'group';
        g.innerHTML = `<h3 class="group-title">${esc(day)}</h3><div class="card"></div>`;
        box.appendChild(g);
        card = g.querySelector('.card');
      }
      const live = r.state === 'progressing' || r.state === 'paused';
      const failed = r.state === 'interrupted' || r.state === 'cancelled';
      const done = r.state === 'completed' && r.exists !== false;
      const acts = [];
      if (r.state === 'progressing') acts.push(['pause', 'Pause']);
      if (r.state === 'paused') acts.push(['resume', 'Resume']);
      if (live) acts.push(['cancel', 'Cancel']);
      if (failed) acts.push(['retry', 'Retry']);
      if (done) acts.push(['show', 'Show in folder']);
      const row = document.createElement('div');
      row.className = `dl ${failed ? 'failed' : ''} ${r.state === 'completed' && r.exists === false ? 'gone' : ''}`;
      row.dataset.id = r.id;
      row.innerHTML = `<div class="dl-ic">${failed ? I.warning : I.file}</div>
        <div class="dl-body">
          <div class="dl-name ${done ? 'link' : ''}" ${done ? 'data-act="open" title="Open"' : ''}>${esc(r.filename)}</div>
          <div class="dl-src" title="${esc(r.url)}">${esc(hostOf(r.url))}${r.private ? ' · private window' : ''}</div>
          <div class="dl-meta">${esc(status(r))}</div>
          ${live ? `<div class="dl-bar"><div style="width:${r.totalBytes ? Math.round((r.receivedBytes / r.totalBytes) * 100) : 0}%"></div></div>` : ''}
        </div>
        <div class="dl-actions">${acts.map(([a, l]) => `<button class="btn small" data-act="${a}">${l}</button>`).join('')}<button class="ibtn" data-act="remove" title="Remove from list">${I.close}</button></div>`;
      card.appendChild(row);
    }
  }

  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    const row = e.target.closest('.dl');
    if (!b || !row) return;
    await call('downloads.action', row.dataset.id, b.dataset.act);
    render();
  });
  $('#open-folder').addEventListener('click', () => call('downloads.openFolder'));
  $('#clear').addEventListener('click', async () => {
    await call('downloads.clear');
    render();
  });
  $('#q').addEventListener('input', debounce(render, 150));
  window.V.on('downloads', debounce(render, 150));
  render();
})();
