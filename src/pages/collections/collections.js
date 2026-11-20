(() => {
  'use strict';
  const { call, esc, $, $$, toast, debounce, hostOf } = window.V;
  const I = window.VexaIcons;
  $('#side').innerHTML = window.V.sidebar('collections');
  $('#search-ico').innerHTML = I.search;
  $('#fsearch-ico').innerHTML = I.search;
  $('#link-ico').innerHTML = I.link;
  $('#back-ico').innerHTML = I.back;
  $('#col-more').innerHTML = I.menu;
  $('.dh-icon').innerHTML = I.upload;

  const ICON = { link: I.link, article: I.reader, image: I.image, screenshot: I.camera, video: I.video, note: I.note, file: I.file };
  const LABEL = { link: 'Page', article: 'Article', image: 'Image', screenshot: 'Screenshot', video: 'Video', note: 'Note', file: 'File' };
  const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const errToast = (e) => toast(clean(e.message || e));

  // A small in-page dialog (Electron doesn't implement window.prompt).
  function ask(title, value = '', { multiline = false, confirmOnly = false, okLabel = 'Save', danger = false } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'dlg-wrap';
      wrap.innerHTML = `<div class="dlg" role="dialog" aria-modal="true"><h3></h3>${confirmOnly ? '' : multiline ? '<textarea rows="6"></textarea>' : '<input type="text">'}<div class="dlg-actions"><button class="btn small" data-x="cancel">Cancel</button><button class="btn small ${danger ? 'danger' : 'primary'}" data-x="ok"></button></div></div>`;
      wrap.querySelector('h3').textContent = title;
      wrap.querySelector('[data-x="ok"]').textContent = okLabel;
      const field = wrap.querySelector('input, textarea');
      if (field) field.value = value;
      document.body.appendChild(wrap);
      const done = (v) => {
        wrap.remove();
        resolve(v);
      };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap || e.target.closest('[data-x="cancel"]')) done(null);
        else if (e.target.closest('[data-x="ok"]')) done(field ? field.value : true);
      });
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(null);
        else if (e.key === 'Enter' && (!multiline || e.ctrlKey)) {
          e.preventDefault();
          done(field ? field.value : true);
        }
      });
      setTimeout(() => (field ? (field.focus(), field.select()) : wrap.querySelector('[data-x="ok"]').focus()), 0);
    });
  }

  let list = []; // summaries
  let view = null; // the open collection
  let sort = 'custom';
  let typeFilter = '';

  // ------------------------------------------------------------------ routing (#c=<id>)
  function route() {
    const m = /#c=([a-f0-9]+)/.exec(location.hash);
    if (m) openCollection(m[1]);
    else showHome();
  }
  window.addEventListener('hashchange', route);
  $('#back').addEventListener('click', () => {
    history.pushState(null, '', 'vexa://collections/');
    showHome();
  });

  // ------------------------------------------------------------------ home: all collections
  function card(c) {
    const cover = c.cover ? `style="background-image:url(&quot;${esc(c.cover)}&quot;)"` : `style="--c:${esc(c.color)}"`;
    return `<a class="co-card" href="#c=${esc(c.id)}" draggable="true" data-id="${esc(c.id)}">
      <div class="co-cover ${c.cover ? 'img' : 'tint'}" ${cover}>${c.cover ? '' : `<span class="co-glyph">${I.collection}</span>`}
        <button class="co-star ${c.favorite ? 'on' : ''}" data-fav="${esc(c.id)}" title="${c.favorite ? 'Remove from favorites' : 'Add to favorites'}">${c.favorite ? I.starFilled : I.star}</button></div>
      <div class="co-body"><div class="co-name">${esc(c.name)}</div><div class="co-meta">${c.count} item${c.count === 1 ? '' : 's'}${c.description ? ' · ' + esc(c.description.slice(0, 80)) : ''}</div></div>
    </a>`;
  }

  async function loadList() {
    list = await call('collections.list');
  }

  function sorted(arr) {
    const a = arr.slice();
    if (sort === 'updated') a.sort((x, y) => y.updated - x.updated);
    else if (sort === 'name') a.sort((x, y) => x.name.localeCompare(y.name));
    return a;
  }

  async function showHome() {
    view = null;
    $('#home-view').hidden = false;
    $('#col-view').hidden = true;
    document.title = 'Collections';
    await loadList();
    renderHome();
  }

  function renderHome() {
    const q = $('#q').value.trim();
    const favs = sorted(list.filter((c) => c.favorite));
    $('#fav-head').hidden = !favs.length || !!q;
    $('#fav-grid').innerHTML = q ? '' : favs.map(card).join('');
    $('#all-head').hidden = !favs.length || !!q;
    $('#grid').innerHTML = q ? '' : sorted(list).map(card).join('');
    $('#empty').hidden = !!list.length || !!q;
    $('#results').hidden = !q;
    if (q) renderResults(q);
    for (const b of $$('#sort button')) b.classList.toggle('on', b.dataset.v === sort);
    $('#sort').hidden = list.length < 2;
  }

  async function renderResults(q) {
    const res = await call('collections.search', q);
    if ($('#q').value.trim() !== q) return;
    $('#results').innerHTML = res.length
      ? res
          .map((r) =>
            r.item
              ? `<a class="res" href="${r.item.url ? esc(r.item.url) : `#c=${esc(r.collection.id)}`}" data-url="${esc(r.item.url || '')}" data-col="${esc(r.collection.id)}"><span class="res-ic">${ICON[r.item.type] || I.link}</span><span class="res-t">${esc(r.item.title || r.item.url || 'Note')}</span><span class="res-c">${esc(r.collection.name)}</span></a>`
              : `<a class="res" href="#c=${esc(r.collection.id)}"><span class="res-ic">${I.collection}</span><span class="res-t">${esc(r.collection.name)}</span><span class="res-c">${r.collection.count} items</span></a>`
          )
          .join('')
      : `<div class="co-empty small"><p>Nothing saved matches “${esc(q)}”.</p></div>`;
  }
  $('#q').addEventListener('input', debounce(renderHome, 120));
  $('#results').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-url]');
    if (a && a.dataset.url) window.V.openFromEvent(e, a.dataset.url);
  });
  $('#sort').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    sort = b.dataset.v;
    renderHome();
  });

  for (const gridSel of ['#grid', '#fav-grid']) {
    const grid = $(gridSel);
    grid.addEventListener('click', async (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) {
        e.preventDefault();
        const c = list.find((x) => x.id === fav.dataset.fav);
        await call('collections.update', fav.dataset.fav, { favorite: !(c && c.favorite) });
      }
    });
    // Drag cards to reorder ("Your order"); drop files or links on a card to add them to it.
    grid.addEventListener('dragstart', (e) => {
      const c = e.target.closest('.co-card');
      if (!c) return;
      e.dataTransfer.setData('application/x-vexa-collection', c.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
    });
    grid.addEventListener('dragend', () => $$('.co-card.dragging, .co-card.over').forEach((x) => x.classList.remove('dragging', 'over')));
    grid.addEventListener('dragover', (e) => {
      const c = e.target.closest('.co-card');
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      $$('.co-card.over').forEach((x) => x !== c && x.classList.remove('over'));
      c.classList.add('over');
    });
    grid.addEventListener('drop', async (e) => {
      const c = e.target.closest('.co-card');
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      c.classList.remove('over');
      hideDrop();
      const moving = e.dataTransfer.getData('application/x-vexa-collection');
      if (moving) {
        if (moving === c.dataset.id) return;
        sort = 'custom';
        await call('collections.move', moving, list.findIndex((x) => x.id === c.dataset.id));
        return;
      }
      await dropInto(c.dataset.id, e.dataTransfer);
    });
  }

  async function newCollection() {
    const name = await ask('Name the new collection', '', { okLabel: 'Create' });
    if (name == null) return;
    try {
      const c = await call('collections.create', { name });
      location.hash = `c=${c.id}`;
    } catch (e) {
      errToast(e);
    }
  }
  $('#new-col').addEventListener('click', newCollection);
  $('#empty-new').addEventListener('click', newCollection);
  $('#import').addEventListener('click', async () => {
    try {
      const n = await call('collections.import');
      if (n != null) toast(`Imported ${n} collection${n === 1 ? '' : 's'}`);
    } catch (e) {
      errToast(e);
    }
  });
  $('#export-all').addEventListener('click', async () => {
    try {
      const f = await call('collections.export', []);
      if (f) toast('Exported to ' + f);
    } catch (e) {
      errToast(e);
    }
  });

  // ------------------------------------------------------------------ one collection
  async function openCollection(id) {
    const v = await call('collections.view', id);
    if (!v) {
      toast('That collection no longer exists');
      history.replaceState(null, '', 'vexa://collections/');
      return showHome();
    }
    view = v;
    $('#home-view').hidden = true;
    $('#col-view').hidden = false;
    document.title = `${v.name} — Collections`;
    renderCollection();
  }

  function autosize(t) {
    t.style.height = 'auto';
    t.style.height = Math.min(160, t.scrollHeight) + 'px';
  }

  function renderCollection() {
    const v = view;
    if (document.activeElement !== $('#col-name')) $('#col-name').value = v.name;
    if (document.activeElement !== $('#col-desc')) {
      $('#col-desc').value = v.description;
      autosize($('#col-desc'));
    }
    const hc = $('#hero-cover');
    hc.style.backgroundImage = v.cover ? `url("${v.cover.replace(/"/g, '%22')}")` : '';
    hc.style.setProperty('--c', v.color);
    hc.classList.toggle('tint', !v.cover);
    hc.innerHTML = v.cover ? '' : I.collection;
    const counts = {};
    for (const i of v.items) counts[i.type] = (counts[i.type] || 0) + 1;
    $('#hero-meta').textContent = `${v.items.length} item${v.items.length === 1 ? '' : 's'}${Object.keys(counts).length > 1 ? ' · ' + Object.entries(counts).map(([k, n]) => `${n} ${LABEL[k].toLowerCase()}${n === 1 ? '' : 's'}`).join(', ') : ''} · updated ${new Date(v.updated).toLocaleDateString()}`;
    $('#col-fav').innerHTML = v.favorite ? I.starFilled : I.star;
    $('#col-fav').classList.toggle('on', v.favorite);
    $('#col-fav').title = v.favorite ? 'Remove from favorites' : 'Add to favorites';
    renderItems();
  }

  function itemCard(i) {
    const host = i.url ? hostOf(i.url).replace(/^www\./, '') : '';
    let media = '';
    if ((i.type === 'image' || i.type === 'screenshot') && i.src) media = `<div class="it-media"><img src="${esc(i.src)}" alt="" loading="lazy" draggable="false"></div>`;
    else if (i.type === 'video' && i.src) media = `<div class="it-media"><video src="${esc(i.src)}" controls preload="metadata"></video></div>`;
    else if (i.type === 'note') media = `<div class="it-note ${i.quote ? 'quote' : ''}">${esc(i.note)}</div>`;
    const fav = i.url && /^https?:/.test(i.url) ? `<img class="it-fav" alt="" src="${esc(i.favicon || new URL(i.url).origin + '/favicon.ico')}">` : '';
    const title = i.type === 'note' && !i.url ? '' : `<div class="it-title">${esc(i.title || i.name || i.url)}</div>`;
    const sub = [i.url ? `<span class="it-host">${fav}${esc(host)}</span>` : '', i.type === 'file' && i.size ? window.V.fmtBytes(i.size) : '', i.type === 'file' && i.name ? esc(i.name) : '', i.note && i.type !== 'note' ? `<span class="it-n">${esc(i.note.slice(0, 140))}</span>` : ''].filter(Boolean).join(' · ');
    return `<article class="item ${i.type} ${i.favorite ? 'fav' : ''}" draggable="true" data-id="${esc(i.id)}">
      ${media}
      <div class="it-body">
        <div class="it-kind">${ICON[i.type] || I.link}<span>${LABEL[i.type] || ''}</span>${i.favorite ? `<span class="it-star">${I.starFilled}</span>` : ''}</div>
        ${title}
        ${sub ? `<div class="it-sub">${sub}</div>` : ''}
      </div>
      <div class="it-actions">
        ${i.url && /^https?:/.test(i.url) ? `<button class="ibtn" data-act="open" title="Open">${I.external}</button>` : ''}
        ${i.type === 'file' ? `<button class="ibtn" data-act="file" title="Open file">${I.folderOpen}</button>` : ''}
        <button class="ibtn" data-act="menu" title="More">${I.menu}</button>
      </div>
    </article>`;
  }

  function renderItems() {
    const q = $('#fq').value.trim().toLowerCase();
    let items = view.items;
    if (typeFilter) items = items.filter((i) => (typeFilter === 'link' ? i.type === 'link' || i.type === 'article' : typeFilter === 'image' ? i.type === 'image' || i.type === 'screenshot' : i.type === typeFilter));
    if (q) items = items.filter((i) => [i.title, i.url, i.note, i.name].some((x) => String(x || '').toLowerCase().includes(q)));
    $('#items').innerHTML = items.map(itemCard).join('');
    for (const img of $$('#items .it-fav')) img.onerror = () => img.remove();
    $('#items-empty').hidden = view.items.length > 0;
    for (const b of $$('#type-filter button')) b.classList.toggle('on', b.dataset.v === typeFilter);
  }
  $('#fq').addEventListener('input', debounce(renderItems, 100));
  $('#type-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    typeFilter = b.dataset.v;
    renderItems();
  });

  // Edit name / description in place.
  $('#col-name').addEventListener('change', () => view && call('collections.update', view.id, { name: $('#col-name').value }).catch(errToast));
  $('#col-name').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
  $('#col-desc').addEventListener('input', () => autosize($('#col-desc')));
  $('#col-desc').addEventListener('change', () => view && call('collections.update', view.id, { description: $('#col-desc').value }).catch(errToast));
  $('#col-fav').addEventListener('click', () => view && call('collections.update', view.id, { favorite: !view.favorite }));

  // The collection's "more" menu (a small in-page menu).
  const menu = document.createElement('div');
  menu.className = 'pop-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  function openMenu(anchor, entries) {
    menu.innerHTML = entries.map((e, i) => (e === '-' ? '<div class="pm-sep"></div>' : `<button data-i="${i}" class="${e.danger ? 'danger' : ''}" ${e.disabled ? 'disabled' : ''}>${esc(e.label)}</button>`)).join('');
    menu._entries = entries;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = 230;
    menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    menu.style.top = r.bottom + 6 + scrollY + 'px';
    setTimeout(() => menu.querySelector('button:not([disabled])')?.focus(), 0);
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    menu.hidden = true;
    menu._entries[Number(b.dataset.i)].run();
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.hidden = true;
  });

  $('#col-more').addEventListener('click', (e) => {
    const v = view;
    const links = v.items.filter((i) => i.url && /^https?:/.test(i.url));
    openMenu(e.currentTarget, [
      { label: `Open all pages (${links.length})`, disabled: !links.length, run: () => links.slice(0, 40).forEach((i) => call('nav.open', i.url, 'background')) },
      { label: 'Export this collection…', run: () => call('collections.export', [v.id]).then((f) => f && toast('Exported to ' + f)).catch(errToast) },
      { label: 'Remove the cover image', disabled: !v.cover, run: () => call('collections.update', v.id, { cover: null }) },
      '-',
      {
        label: 'Delete collection',
        danger: true,
        run: async () => {
          if (!(await ask(`Delete “${v.name}” and the ${v.items.length} item${v.items.length === 1 ? '' : 's'} in it? Files saved in it are removed from the profile too.`, '', { confirmOnly: true, okLabel: 'Delete', danger: true }))) return;
          await call('collections.remove', v.id);
          history.replaceState(null, '', 'vexa://collections/');
          showHome();
        }
      }
    ]);
  });

  $('#items').addEventListener('click', (e) => {
    const art = e.target.closest('.item');
    if (!art) return;
    const item = view.items.find((x) => x.id === art.dataset.id);
    if (!item) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') return window.V.openFromEvent(e, item.url);
    if (act === 'file') return call('collections.openItem', view.id, item.id, false).catch(errToast);
    if (act === 'menu') {
      const others = list.filter((c) => c.id !== view.id);
      return openMenu(e.target.closest('[data-act]'), [
        { label: item.favorite ? 'Remove from favorites' : 'Mark as favorite', run: () => call('collections.updateItem', view.id, item.id, { favorite: !item.favorite }) },
        {
          label: item.type === 'note' ? 'Edit note' : 'Rename',
          run: async () => {
            const next = await ask(item.type === 'note' ? 'Edit the note' : 'Title', item.type === 'note' ? item.note : item.title, { multiline: item.type === 'note' });
            if (next != null) call('collections.updateItem', view.id, item.id, item.type === 'note' ? { note: next, title: next.split('\n')[0].slice(0, 120) } : { title: next });
          }
        },
        {
          label: item.note && item.type !== 'note' ? 'Edit note' : 'Add a note',
          disabled: item.type === 'note',
          run: async () => {
            const next = await ask('Note', item.note || '', { multiline: true });
            if (next != null) call('collections.updateItem', view.id, item.id, { note: next });
          }
        },
        { label: 'Use as cover', disabled: !((item.type === 'image' || item.type === 'screenshot') && item.src), run: () => call('collections.update', view.id, { cover: { item: item.id } }) },
        { label: 'Copy link', disabled: !item.url, run: () => navigator.clipboard.writeText(item.url).then(() => toast('Link copied')) },
        { label: 'Show file in folder', disabled: !item.file, run: () => call('collections.openItem', view.id, item.id, true).catch(errToast) },
        '-',
        ...others.slice(0, 8).map((c) => ({ label: `Move to ${c.name}`, run: () => call('collections.moveItem', view.id, item.id, c.id, null) })),
        ...(others.length ? ['-'] : []),
        { label: 'Remove from collection', danger: true, run: () => call('collections.removeItem', view.id, item.id) }
      ]);
    }
    // Clicking a page card opens it; images open full size.
    if (!e.target.closest('video, button') && item.url && /^https?:/.test(item.url) && (item.type === 'link' || item.type === 'article' || item.type === 'video')) window.V.openFromEvent(e, item.url);
    else if (!e.target.closest('button') && item.src && (item.type === 'image' || item.type === 'screenshot')) window.V.openFromEvent(e, item.src);
  });

  // Reorder items by dragging.
  let dragItem = null;
  $('#items').addEventListener('dragstart', (e) => {
    const art = e.target.closest('.item');
    if (!art) return;
    dragItem = art.dataset.id;
    e.dataTransfer.setData('application/x-vexa-item', dragItem);
    e.dataTransfer.effectAllowed = 'move';
    art.classList.add('dragging');
  });
  $('#items').addEventListener('dragend', () => {
    dragItem = null;
    $$('.item.dragging, .item.over').forEach((x) => x.classList.remove('dragging', 'over'));
  });
  $('#items').addEventListener('dragover', (e) => {
    if (!dragItem) return;
    const art = e.target.closest('.item');
    e.preventDefault();
    e.stopPropagation();
    $$('.item.over').forEach((x) => x !== art && x.classList.remove('over'));
    if (art && art.dataset.id !== dragItem) art.classList.add('over');
  });
  $('#items').addEventListener('drop', async (e) => {
    if (!dragItem) return;
    e.preventDefault();
    e.stopPropagation();
    const art = e.target.closest('.item');
    const to = art ? view.items.findIndex((x) => x.id === art.dataset.id) : view.items.length;
    const id = dragItem;
    dragItem = null;
    await call('collections.moveItem', view.id, id, view.id, to);
  });

  // Add a link / note / files.
  $('#add-link').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('#link-url').value.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    try {
      await call('collections.addItem', view.id, { type: 'link', url, title: url.replace(/^https?:\/\/(www\.)?/, '') });
      $('#link-url').value = '';
    } catch (err) {
      errToast(err);
    }
  });
  $('#add-note').addEventListener('click', () => {
    $('#note-editor').hidden = false;
    $('#note-text').focus();
  });
  $('#note-cancel').addEventListener('click', () => {
    $('#note-editor').hidden = true;
    $('#note-text').value = '';
  });
  $('#note-save').addEventListener('click', async () => {
    const text = $('#note-text').value.trim();
    if (!text) return;
    await call('collections.addItem', view.id, { type: 'note', title: text.split('\n')[0].slice(0, 120), note: text });
    $('#note-text').value = '';
    $('#note-editor').hidden = true;
  });
  $('#note-text').addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && $('#note-save').click());
  $('#add-files').addEventListener('click', async () => {
    try {
      const n = await call('collections.addFiles', view.id);
      if (n) toast(`Added ${n} file${n === 1 ? '' : 's'}`);
    } catch (err) {
      errToast(err);
    }
  });

  // ------------------------------------------------------------------ drop anything onto the page
  const dropHint = $('#drop-hint');
  let depth = 0;
  const external = (e) => e.dataTransfer && !dragItem && ![...e.dataTransfer.types].some((t) => t.startsWith('application/x-vexa')) && [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
  function hideDrop() {
    depth = 0;
    dropHint.hidden = true;
  }
  document.addEventListener('dragenter', (e) => {
    if (!external(e)) return;
    e.preventDefault();
    depth++;
    $('#drop-text').textContent = view ? `Drop to add to “${view.name}”` : 'Drop on a collection to add to it';
    dropHint.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!external(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!external(e)) return;
    if (--depth <= 0) hideDrop();
  });
  document.addEventListener('drop', async (e) => {
    if (!external(e)) return;
    e.preventDefault(); // never navigate to a dropped file
    hideDrop();
    if (view) await dropInto(view.id, e.dataTransfer);
    else toast('Drop onto a collection card, or open a collection first');
  });

  async function dropInto(collectionId, dt) {
    let n = 0;
    try {
      const files = [...(dt.files || [])];
      for (const f of files.slice(0, 30)) {
        if (f.size > 50 * 1024 * 1024) {
          toast(`${f.name} is larger than 50 MB`);
          continue;
        }
        await call('collections.addFileData', collectionId, f.name, new Uint8Array(await f.arrayBuffer()));
        n++;
      }
      if (!files.length) {
        const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
        const text = dt.getData('text/plain') || '';
        if (uris.length) {
          for (const u of uris.slice(0, 30)) {
            if (/^https?:\/\//i.test(u)) {
              await call('collections.addItem', collectionId, { type: 'link', url: u, title: u.replace(/^https?:\/\/(www\.)?/, '') });
              n++;
            }
          }
        } else if (/^https?:\/\/\S+$/i.test(text.trim())) {
          await call('collections.addItem', collectionId, { type: 'link', url: text.trim(), title: text.trim().replace(/^https?:\/\/(www\.)?/, '') });
          n++;
        } else if (text.trim()) {
          await call('collections.addItem', collectionId, { type: 'note', title: text.trim().split('\n')[0].slice(0, 120), note: text.trim() });
          n++;
        }
      }
      if (n) toast(`Added ${n} item${n === 1 ? '' : 's'}`);
    } catch (err) {
      errToast(err);
    }
  }

  // ------------------------------------------------------------------ live updates
  const refresh = debounce(async () => {
    await loadList();
    if (view) {
      const v = await call('collections.view', view.id);
      if (!v) return showHome();
      view = v;
      renderCollection();
    } else renderHome();
  }, 60);
  window.V.on('collections', refresh);

  route();
})();
