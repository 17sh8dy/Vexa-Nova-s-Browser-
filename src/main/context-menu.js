'use strict';
// Native context menus: page, tab, and bookmarks bar.

const { Menu, clipboard, shell } = require('electron');
const { settings } = require('./settings');
const { bookmarks } = require('./bookmarks');
const { searchUrl, SEARCH_ENGINES, originOf } = require('./url');
const { passwords } = require('./passwords');
const { autofill } = require('./autofill');

function truncate(s, n = 28) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function showPageMenu(tab, params) {
  const win = tab.win;
  const wc = tab.wc;
  const app = require('./app-controller');
  const t = [];
  const sep = () => t.length && t[t.length - 1].type !== 'separator' && t.push({ type: 'separator' });

  if (params.linkURL) {
    const link = params.linkURL;
    const isWeb = /^(https?|file|vexa):/i.test(link);
    if (isWeb) {
      t.push({ label: 'Open link in new tab', click: () => win.openInNewTab(link, { background: true, opener: tab }) });
      if (!win.isPrivate) t.push({ label: 'Open link in new window', click: () => app.createWindow({ urls: [link] }) });
      t.push({ label: 'Open link in private window', click: () => app.createWindow({ isPrivate: true, urls: [link] }) });
      sep();
      t.push({ label: 'Save link as…', click: () => wc.downloadURL(link) });
    } else if (/^mailto:|^tel:/i.test(link)) {
      t.push({ label: 'Open with default app', click: () => shell.openExternal(link) });
    }
    t.push({ label: 'Copy link address', click: () => clipboard.writeText(link) });
    sep();
  }

  if (params.mediaType === 'image' && params.srcURL) {
    t.push({ label: 'Open image in new tab', click: () => win.openInNewTab(params.srcURL, { background: true, opener: tab }) });
    t.push({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
    t.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    t.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  } else if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL && !params.srcURL.startsWith('blob:')) {
    t.push({ label: `Open ${params.mediaType} in new tab`, click: () => win.openInNewTab(params.srcURL, { background: true, opener: tab }) });
    t.push({ label: `Save ${params.mediaType} as…`, click: () => wc.downloadURL(params.srcURL) });
    t.push({ label: `Copy ${params.mediaType} address`, click: () => clipboard.writeText(params.srcURL) });
    sep();
  }

  if (params.isEditable) {
    if (params.misspelledWord) {
      const sugg = params.dictionarySuggestions.slice(0, 5);
      for (const s of sugg) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (!sugg.length) t.push({ label: 'No spelling suggestions', enabled: false });
      t.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    const f = params.editFlags;
    t.push({ label: 'Undo', role: 'undo', enabled: f.canUndo });
    t.push({ label: 'Redo', role: 'redo', enabled: f.canRedo });
    sep();
    t.push({ label: 'Cut', role: 'cut', enabled: f.canCut });
    t.push({ label: 'Copy', role: 'copy', enabled: f.canCopy });
    t.push({ label: 'Paste', role: 'paste', enabled: f.canPaste });
    t.push({ label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste });
    t.push({ label: 'Select all', role: 'selectAll', enabled: f.canSelectAll });
    sep();
    // Password manager and autofill.
    const origin = originOf(tab.url);
    const logins = /^https?:/.test(origin) && passwords.available() ? passwords.forOrigin(origin) : [];
    if (logins.length) {
      t.push({
        label: 'Fill saved password',
        submenu: logins.map((l) => ({
          label: truncate(l.username || '(no username)', 40),
          click: () => {
            wc.send('vexa:pm-fill', { username: l.username, password: l.password });
            passwords.markUsed(l.id);
          }
        }))
      });
    }
    if (!autofill.isEmpty()) t.push({ label: 'Autofill contact details', click: () => wc.send('vexa:af-fill', autofill.get()) });
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    const text = params.selectionText.trim();
    t.push({ label: 'Copy', role: 'copy' });
    const engine = SEARCH_ENGINES[settings.get('searchEngine')].name;
    t.push({ label: `Search ${engine} for “${truncate(text)}”`, click: () => win.openInNewTab(searchUrl(text, settings.get('searchEngine')), { opener: tab }) });
    sep();
  }

  if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    const nav = wc.navigationHistory;
    t.push({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() });
    t.push({ label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() });
    t.push({ label: 'Reload', click: () => wc.reload() });
    sep();
    if (/^(https?|file):/.test(tab.url)) {
      t.push({ label: 'Save page as…', click: () => wc.downloadURL(tab.url) });
      t.push({ label: 'Print…', click: () => wc.print({}, () => {}) });
      t.push({ label: 'View page source', click: () => win.openInNewTab('view-source:' + tab.url, { opener: tab }) });
      sep();
    }
  }

  // Collections: save the page, a link, an image, or the selected text.
  if (!win.isPrivate) {
    const save = collectItems(win, tab, params);
    if (save.length) {
      sep();
      t.push({ label: 'Save to collection', submenu: save });
    }
  }
  if (/^https?:/.test(tab.url) && !params.isEditable) t.push({ label: 'Reader view', accelerator: 'F9', click: () => require('./reader').reader.toggle(tab) });
  sep();
  t.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

/** "Save to collection ▸ <collection>" for whatever was right-clicked. */
function collectItems(win, tab, params) {
  const { collections } = require('./collections');
  const list = collections.summaries().slice(0, 12);
  let what = null;
  if (params.mediaType === 'image' && /^https?:/i.test(params.srcURL || '')) what = { kind: 'image', label: 'image' };
  else if (params.mediaType === 'video' && /^https?:/i.test(params.srcURL || '')) what = { kind: 'video', label: 'video' };
  else if (params.linkURL && /^https?:/i.test(params.linkURL)) what = { kind: 'link', label: 'link' };
  else if (params.selectionText && params.selectionText.trim()) what = { kind: 'note', label: 'selection as a note' };
  else if (/^https?:/i.test(tab.url)) what = { kind: 'page', label: 'page' };
  if (!what) return [];
  const add = async (cid) => {
    try {
      if (what.kind === 'image') {
        // Saved as a copy (the image bytes come from Chromium's cache via a fresh fetch in the page's session).
        const res = await tab.wc.session.fetch(params.srcURL);
        const buf = Buffer.from(await res.arrayBuffer());
        collections.addFileBytes(cid, params.srcURL.split('/').pop().split('?')[0] || 'image', buf, { title: params.titleText || params.altText || tab.title, url: params.srcURL });
      } else if (what.kind === 'video') collections.addItem(cid, { type: 'video', title: params.titleText || `Video on ${tab.title}`, url: params.srcURL });
      else if (what.kind === 'link') collections.addItem(cid, { type: 'link', title: (params.linkText || params.linkURL).trim().slice(0, 300), url: params.linkURL });
      else if (what.kind === 'note') collections.addItem(cid, { type: 'note', title: `“${params.selectionText.trim().slice(0, 100)}”`, note: params.selectionText.trim(), url: tab.url, quote: true });
      else collections.addItem(cid, { type: 'link', title: tab.title, url: tab.url, favicon: tab.favicon });
      win.toast(`Saved ${what.label} to ${collections.get(cid)?.name || 'collection'}`);
    } catch (err) {
      win.toast(`Couldn’t save: ${err.message}`);
    }
  };
  const items = list.map((c) => ({ label: truncate(c.name, 40), click: () => add(c.id) }));
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'New collection…', click: () => add(collections.create({ name: what.kind === 'page' ? truncate(tab.title || 'New collection', 60) : 'New collection' }).id) });
  if (what.kind === 'page') items.push({ label: 'Screenshot this page', click: () => win.runAction('screenshot') });
  return items;
}

/** Right-click on a Space in the sidebar. */
function showSpaceMenu(win, spaceId) {
  const { spaces } = require('./spaces');
  const s = spaces.get(spaceId);
  if (!s || win.isPrivate) return;
  const list = spaces.list();
  const i = list.findIndex((x) => x.id === s.id);
  const t = [
    { label: s.id === win.spaceId ? 'Current Space' : `Switch to ${truncate(s.name, 30)}`, enabled: s.id !== win.spaceId, click: () => win.switchSpace(s.id) },
    { type: 'separator' },
    { label: 'Edit Space…', click: () => win.runAction('edit-space', { payload: { spaceId: s.id } }) },
    { label: 'Save tabs as a session', enabled: s.id === win.spaceId && win.tabs.some((x) => /^https?:/.test(x.url)), click: () => win.runAction('save-space-session') },
    { label: 'Move up', enabled: i > 0, click: () => spaces.move(s.id, i - 1) },
    { label: 'Move down', enabled: i < list.length - 1, click: () => spaces.move(s.id, i + 1) },
    { type: 'separator' },
    { label: 'Manage Spaces…', click: () => win.openInternal('vexa://settings/#spaces') },
    { label: 'Delete Space', enabled: list.length > 1, click: () => spaces.remove(s.id) }
  ];
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

/** Right-click on empty sidebar space: sidebar customization. */
function showSidebarMenu(win) {
  const sb = settings.get('sidebar');
  const set = (patch) => settings.set('sidebar', patch);
  const item = (key, label) => ({ label, type: 'checkbox', checked: sb.items[key] !== false, click: () => set({ items: { [key]: sb.items[key] === false } }) });
  const t = [
    { label: 'Position', submenu: [{ label: 'Left', type: 'radio', checked: sb.side === 'left', click: () => set({ side: 'left' }) }, { label: 'Right', type: 'radio', checked: sb.side === 'right', click: () => set({ side: 'right' }) }] },
    { label: 'Size', submenu: [{ label: 'Compact (icons)', type: 'radio', checked: sb.size === 'compact', click: () => set({ size: 'compact' }) }, { label: 'Wide (icons and names)', type: 'radio', checked: sb.size === 'wide', click: () => set({ size: 'wide' }) }] },
    { type: 'separator' },
    item('spaces', 'Spaces'),
    item('pinned', 'Pinned sites'),
    item('collections', 'Collections'),
    item('focus', 'Focus'),
    item('command', 'Command Center'),
    { type: 'separator' },
    { label: 'Hide sidebar', accelerator: 'CmdOrCtrl+Shift+E', click: () => set({ show: false }) },
    { label: 'Customize Vexa…', click: () => win.runAction('customize') }
  ];
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

/** Right-click on a pinned site in the sidebar. */
function showPinnedMenu(win, url) {
  const { spaces } = require('./spaces');
  if (win.isPrivate) return;
  const t = [
    { label: 'Open', click: () => win.command('open-pinned', { url }) },
    { label: 'Open in new tab', click: () => win.addTab({ url }) },
    { type: 'separator' },
    { label: 'Copy link', click: () => clipboard.writeText(url) },
    { label: 'Unpin from this Space', click: () => spaces.removePinned(win.spaceId, url) }
  ];
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

/** "Move to new window" / "Move to window ▸" (normal windows only; private ones have their own session). */
function moveItems(win, tab) {
  if (win.isPrivate) return [];
  const others = [...require('./app-controller').windows].filter((w) => w !== win && !w.isPrivate && !w.closing && !w.win.isDestroyed());
  const items = [{ label: 'Move tab to new window', enabled: win.allTabs().length > 1, click: () => win.moveTabToNewWindow(tab.id) }];
  if (others.length) {
    items.push({
      label: 'Move tab to window',
      submenu: others.map((w, i) => ({ label: truncate(`${i + 1}. ${w.activeTab ? w.activeTab.title || w.activeTab.url : 'Window'}`, 44), click: () => win.moveTabToWindow(tab.id, w) }))
    });
  }
  return items;
}

/** "Move tab to Space ▸" and "Pin to this Space" (Spaces that share a session only). */
function spaceItems(win, tab) {
  if (win.isPrivate) return [];
  const { spaces } = require('./spaces');
  const here = spaces.get(tab.spaceId);
  const out = [];
  if (/^https?:/.test(tab.url) && here) out.push({ label: `Pin site to ${truncate(here.name, 24)}`, click: () => spaces.addPinned(here.id, { url: tab.url, title: tab.title }) });
  const others = spaces.list().filter((s) => s.id !== tab.spaceId);
  if (others.length) {
    out.push({
      label: 'Move tab to Space',
      submenu: others.map((s) => ({
        label: truncate(s.name, 40) + (s.isolated ? ' (isolated)' : ''),
        enabled: !s.isolated && !(here && here.isolated),
        click: () => {
          try {
            win.moveTabToSpace(tab.id, s.id);
          } catch (e) {
            win.toast(e.message);
          }
        }
      }))
    });
  }
  return out;
}

function showTabMenu(win, tab) {
  if (!tab) return;
  const idx = win.tabs.indexOf(tab);
  const muted = tab.wc.isAudioMuted();
  const template = [
    { label: 'New tab to the right', click: () => win.addTab({ index: idx + 1 }) },
    { type: 'separator' },
    { label: tab.pinned ? 'Unpin tab' : 'Pin tab', click: () => win.setPinned(tab.id, !tab.pinned) },
    { label: 'Reload', click: () => win.runAction('reload', { tab }) },
    { label: 'Duplicate', click: () => win.duplicateTab(tab.id) },
    { label: muted ? 'Unmute tab' : 'Mute tab', click: () => (tab.wc.setAudioMuted(!muted), tab.changed()) },
    { label: bookmarks.isBookmarked(tab.url) ? 'Remove bookmark' : 'Bookmark tab', enabled: /^(https?|file):/.test(tab.url), click: () => bookmarks.toggle(tab.url, tab.title) },
    ...spaceItems(win, tab),
    { type: 'separator' },
    ...moveItems(win, tab),
    { type: 'separator' },
    { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => win.closeTab(tab.id) },
    { label: 'Close other tabs', enabled: win.tabs.some((t) => t !== tab && !t.pinned), click: () => win.closeOtherTabs(tab.id) },
    { label: 'Close tabs to the right', enabled: win.tabs.slice(idx + 1).some((t) => !t.pinned), click: () => win.closeTabsToRight(tab.id) },
    { type: 'separator' },
    { label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', enabled: win.closedTabs.length > 0, click: () => win.reopenClosedTab() }
  ];
  Menu.buildFromTemplate(template).popup({ window: win.win });
}

function folderItems(win, folderId) {
  const kids = bookmarks.children(folderId);
  if (!kids.length) return [{ label: '(empty)', enabled: false }];
  return kids.map((n) =>
    n.type === 'folder'
      ? { label: truncate(n.title, 48), submenu: folderItems(win, n.id) }
      : { label: truncate(n.title || n.url, 48), click: (_mi, _bw, ev) => win.navigate(n.url, { disposition: ev && (ev.ctrlKey || ev.metaKey) ? 'background' : 'current' }) }
  );
}

function showBookmarkFolderMenu(win, folderId) {
  const items = folderItems(win, folderId);
  const urls = bookmarks.children(folderId).filter((n) => n.type === 'bookmark');
  if (urls.length) {
    items.push({ type: 'separator' }, { label: `Open all (${urls.length})`, click: () => urls.forEach((n) => win.openInNewTab(n.url, { background: true })) });
  }
  Menu.buildFromTemplate(items).popup({ window: win.win });
}

function showBookmarkMenu(win, id) {
  const node = bookmarks.get(id);
  if (!node) return;
  const app = require('./app-controller');
  const t = [];
  if (node.type === 'bookmark') {
    t.push({ label: 'Open', click: () => win.navigate(node.url) });
    t.push({ label: 'Open in new tab', click: () => win.openInNewTab(node.url, { background: true }) });
    t.push({ label: 'Open in private window', click: () => app.createWindow({ isPrivate: true, urls: [node.url] }) });
    t.push({ type: 'separator' });
    t.push({ label: 'Copy link', click: () => clipboard.writeText(node.url) });
  }
  t.push({ label: 'Edit…', click: () => win.openInternal(`vexa://bookmarks/#edit=${encodeURIComponent(id)}`) });
  t.push({ label: 'Delete', click: () => bookmarks.remove(id) });
  t.push({ type: 'separator' });
  t.push({ label: 'Manage bookmarks', click: () => win.openInternal('vexa://bookmarks/') });
  t.push({ label: settings.get('showBookmarksBar') ? 'Hide bookmarks bar' : 'Show bookmarks bar', click: () => settings.set('showBookmarksBar', !settings.get('showBookmarksBar')) });
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

module.exports = { showPageMenu, showTabMenu, showBookmarkFolderMenu, showBookmarkMenu, showSpaceMenu, showSidebarMenu, showPinnedMenu };
