(() => {
  'use strict';
  const { call, esc, $, hostOf, favicon, toast, debounce } = window.V;
  const I = window.VexaIcons;
  $('#side').innerHTML = window.V.sidebar('bookmarks');
  $('#search-ico').innerHTML = I.search;
  $('#more').innerHTML = I.menu;

  let folderId = 'bar';
  let folders = [];
  let editing = null; // { id } or { create: 'bookmark'|'folder' }

  async function refresh() {
    folders = await call('bookmarks.folders');
    if (!folders.some((f) => f.id === folderId)) folderId = 'bar';
    renderTree();
    await renderItems();
  }

  function renderTree() {
    $('#tree').innerHTML = folders
      .map((f) => `<div class="tnode ${f.id === folderId && !$('#q').value ? 'on' : ''}" data-folder="${esc(f.id)}" style="padding-left:${10 + f.depth * 16}px"><span class="ico">${I.folder}</span><span>${esc(f.title)}</span></div>`)
      .join('');
  }

  async function renderItems() {
    const q = $('#q').value.trim();
    const items = q ? await call('bookmarks.search', q) : await call('bookmarks.children', folderId);
    const folder = folders.find((f) => f.id === folderId);
    $('#crumb').textContent = q ? `Results for “${q}”` : folder ? folder.title : '';
    $('#add-bm').hidden = $('#add-folder').hidden = !!q;
    const box = $('#items');
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = `<div class="empty">${q ? 'No bookmarks match your search.' : 'This folder is empty. Press Ctrl+D on any page to bookmark it.'}</div>`;
      return;
    }
    for (const n of items) {
      const row = document.createElement('div');
      row.className = 'item' + (n.type === 'folder' ? ' folder' : '');
      row.dataset.id = n.id;
      row.draggable = !q;
      if (n.type === 'folder') {
        row.innerHTML = `<span class="favicon">${I.folder}</span><div class="title"><span class="t">${esc(n.title)}</span><span class="host">${n.children.length} item${n.children.length === 1 ? '' : 's'}</span></div>`;
      } else {
        row.innerHTML = `<span class="fav"></span><div class="title"><a href="${esc(n.url)}" title="${esc(n.url)}">${esc(n.title || n.url)}</a><span class="url">${esc(hostOf(n.url))}</span></div>`;
        row.querySelector('.fav').replaceWith(favicon(n.url));
      }
      row.insertAdjacentHTML('beforeend', `<div class="acts"><button class="ibtn" data-act="edit" title="Edit">${I.settings}</button><button class="ibtn" data-act="delete" title="Delete">${I.close}</button></div>`);
      box.appendChild(row);
    }
  }

  // ---- navigation
  $('#tree').addEventListener('click', (e) => {
    const n = e.target.closest('[data-folder]');
    if (!n) return;
    $('#q').value = '';
    folderId = n.dataset.folder;
    renderTree();
    renderItems();
  });
  $('#items').addEventListener('click', async (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'delete') {
      const node = await call('bookmarks.get', id);
      await call('bookmarks.remove', id);
      toast(`Deleted “${node ? node.title : 'bookmark'}”`);
      return refresh();
    }
    if (act === 'edit') return openEditor({ id });
    const link = e.target.closest('a');
    if (link) return window.V.openFromEvent(e, link.getAttribute('href'));
    if (row.classList.contains('folder')) {
      $('#q').value = '';
      folderId = id;
      renderTree();
      renderItems();
    }
  });
  $('#items').addEventListener('auxclick', (e) => {
    const link = e.target.closest('a');
    if (link && e.button === 1) window.V.openFromEvent(e, link.getAttribute('href'));
  });
  $('#q').addEventListener('input', debounce(() => (renderTree(), renderItems()), 150));

  // ---- drag & drop: reorder within a folder, or drop onto a folder in the tree
  let dragId = null;
  $('#items').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.item');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  $('#items').addEventListener('dragover', (e) => {
    const row = e.target.closest('.item');
    if (!dragId || !row) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    row.classList.add('drop-before');
  });
  $('#items').addEventListener('drop', async (e) => {
    e.preventDefault();
    const row = e.target.closest('.item');
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    if (!dragId || !row || row.dataset.id === dragId) return;
    const index = [...$('#items').children].indexOf(row);
    try {
      await call('bookmarks.move', dragId, folderId, index);
    } catch (err) {
      toast(err.message);
    }
    dragId = null;
    refresh();
  });
  $('#tree').addEventListener('dragover', (e) => {
    const n = e.target.closest('[data-folder]');
    if (!dragId || !n) return;
    e.preventDefault();
    document.querySelectorAll('.tnode.drop').forEach((x) => x.classList.remove('drop'));
    n.classList.add('drop');
  });
  $('#tree').addEventListener('dragleave', (e) => e.target.closest?.('[data-folder]')?.classList.remove('drop'));
  $('#tree').addEventListener('drop', async (e) => {
    e.preventDefault();
    const n = e.target.closest('[data-folder]');
    document.querySelectorAll('.tnode.drop').forEach((x) => x.classList.remove('drop'));
    if (!dragId || !n) return;
    try {
      await call('bookmarks.move', dragId, n.dataset.folder);
      toast('Moved');
    } catch (err) {
      toast(err.message);
    }
    dragId = null;
    refresh();
  });
  document.addEventListener('dragend', () => (dragId = null));

  // ---- editor dialog
  const dlg = $('#edit');
  async function openEditor(spec) {
    editing = spec;
    const node = spec.id ? await call('bookmarks.get', spec.id) : null;
    const isFolder = node ? node.type === 'folder' : spec.create === 'folder';
    $('#edit-title').textContent = node ? (isFolder ? 'Edit folder' : 'Edit bookmark') : isFolder ? 'New folder' : 'Add bookmark';
    $('#f-url-wrap').hidden = isFolder;
    $('#f-title').value = node ? node.title : '';
    $('#f-url').value = node && node.url ? node.url : '';
    const current = node ? node.parentId : folderId;
    $('#f-folder').innerHTML = folders
      .filter((f) => !(node && isFolder && (f.id === node.id)))
      .map((f) => `<option value="${esc(f.id)}" ${f.id === current ? 'selected' : ''}>${' '.repeat(f.depth)}${esc(f.title)}</option>`)
      .join('');
    $('#f-folder').parentElement.querySelector('label[for="f-folder"]').hidden = $('#f-folder').hidden = !!(node && node.parentId === null);
    dlg.showModal();
    $('#f-title').focus();
  }
  $('#edit-cancel').addEventListener('click', () => dlg.close());
  $('#edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#f-title').value.trim();
    let url = $('#f-url').value.trim();
    const parent = $('#f-folder').value;
    try {
      if (editing.id) {
        const node = await call('bookmarks.get', editing.id);
        if (node.type === 'bookmark' && url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        await call('bookmarks.update', editing.id, { title, url: node.type === 'bookmark' ? url : undefined });
        if (node.parentId && parent && parent !== node.parentId) await call('bookmarks.move', editing.id, parent);
      } else if (editing.create === 'folder') {
        await call('bookmarks.addFolder', { title: title || 'New folder', parentId: parent });
      } else {
        if (!url) return toast('Enter a URL');
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
        await call('bookmarks.add', { title: title || url, url, parentId: parent });
      }
      dlg.close();
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#add-bm').addEventListener('click', () => openEditor({ create: 'bookmark' }));
  $('#add-folder').addEventListener('click', () => openEditor({ create: 'folder' }));

  // ---- import / export
  const menu = $('#more-menu');
  $('#more').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = $('#more').getBoundingClientRect();
    menu.style.top = r.bottom + 6 + 'px';
    menu.style.right = window.innerWidth - r.right + 'px';
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => (menu.hidden = true));
  menu.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'export') {
      const p = await call('bookmarks.export');
      if (p) toast('Exported to ' + p);
    } else if (m === 'import') {
      const n = await call('bookmarks.import');
      if (n != null) {
        toast(`Imported ${n} bookmark${n === 1 ? '' : 's'} into “Other bookmarks”`);
        folderId = 'other';
        refresh();
      }
    }
  });

  window.V.on('bookmarks', debounce(refresh, 100));

  // vexa://bookmarks/#edit=<id> (from the bookmarks bar context menu)
  async function handleHash() {
    const m = /edit=([^&]+)/.exec(location.hash);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    const node = await call('bookmarks.get', id);
    if (node) {
      if (node.parentId) folderId = node.parentId;
      await refresh();
      openEditor({ id });
    }
    history.replaceState(null, '', location.pathname);
  }
  window.addEventListener('hashchange', handleHash);
  refresh().then(handleHash);
})();
