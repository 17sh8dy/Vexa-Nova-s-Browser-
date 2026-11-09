(() => {
  'use strict';
  const { call, esc, $, $$, fmtTime, dayLabel, hostOf, favicon, toast, debounce } = window.V;
  const I = window.VexaIcons;
  $('#side').innerHTML = window.V.sidebar('history');
  $('#search-ico').innerHTML = I.search;

  const PAGE = 150;
  let entries = [];
  let exhausted = false;
  const selected = new Set();

  async function load(reset = true) {
    const text = $('#q').value;
    const before = reset || !entries.length ? Infinity : entries[entries.length - 1].time;
    const batch = await call('history.query', { text, limit: PAGE, before: before === Infinity ? undefined : before });
    entries = reset ? batch : entries.concat(batch);
    exhausted = batch.length < PAGE;
    if (reset) selected.clear();
    render();
  }

  function render() {
    const list = $('#list');
    list.innerHTML = '';
    $('#more').hidden = exhausted;
    if (!entries.length) {
      list.innerHTML = `<div class="empty"><img class="mark" src="vexa://shared/logo.svg" alt=""><div>${$('#q').value ? 'No history matches your search.' : 'Pages you visit will show up here.'}</div></div>`;
      updateSelbar();
      return;
    }
    let group = null;
    let lastDay = '';
    for (const e of entries) {
      const day = dayLabel(e.time);
      if (day !== lastDay) {
        lastDay = day;
        group = document.createElement('section');
        group.className = 'group';
        group.innerHTML = `<h3 class="group-title">${esc(day)}</h3><div class="card"></div>`;
        list.appendChild(group);
      }
      const row = document.createElement('div');
      row.className = 'item' + (selected.has(e.id) ? ' selected' : '');
      row.dataset.id = e.id;
      row.innerHTML = `<input type="checkbox" ${selected.has(e.id) ? 'checked' : ''} aria-label="Select"><span class="time">${esc(fmtTime(e.time))}</span><span class="fav"></span><div class="title"><a href="${esc(e.url)}" title="${esc(e.url)}">${esc(e.title || e.url)}</a><span class="host">${esc(hostOf(e.url))}</span></div><div class="acts"><button class="ibtn" data-act="delete" title="Remove from history">${I.close}</button></div>`;
      row.querySelector('.fav').replaceWith(favicon(e.url, e.favicon));
      group.querySelector('.card').appendChild(row);
    }
    updateSelbar();
  }

  $('#list').addEventListener('click', async (ev) => {
    const row = ev.target.closest('.item');
    if (!row) return;
    const id = Number(row.dataset.id);
    const link = ev.target.closest('a');
    if (link) return window.V.openFromEvent(ev, link.getAttribute('href'));
    if (ev.target.closest('[data-act="delete"]')) {
      await call('history.remove', [id]);
      entries = entries.filter((e) => e.id !== id);
      selected.delete(id);
      render();
      return;
    }
    if (ev.target.matches('input[type="checkbox"]')) {
      if (ev.target.checked) selected.add(id);
      else selected.delete(id);
      row.classList.toggle('selected', ev.target.checked);
      updateSelbar();
    }
  });
  $('#list').addEventListener('auxclick', (ev) => {
    const link = ev.target.closest('a');
    if (link && ev.button === 1) window.V.openFromEvent(ev, link.getAttribute('href'));
  });

  function updateSelbar() {
    $('#selbar').hidden = selected.size === 0;
    $('#selcount').textContent = `${selected.size} selected`;
  }
  $('#sel-cancel').addEventListener('click', () => {
    selected.clear();
    render();
  });
  $('#sel-delete').addEventListener('click', async () => {
    const ids = [...selected];
    await call('history.remove', ids);
    entries = entries.filter((e) => !selected.has(e.id));
    selected.clear();
    render();
    toast(`Removed ${ids.length} item${ids.length > 1 ? 's' : ''}`);
  });
  $('#more-btn').addEventListener('click', () => load(false));
  $('#q').addEventListener('input', debounce(() => load(true), 180));

  window.V.on(
    'history',
    debounce(() => {
      if (!selected.size && entries.length <= PAGE) load(true);
    }, 300)
  );
  load(true);
})();
