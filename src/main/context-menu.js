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

  t.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(t).popup({ window: win.win });
}

/** "Move to new window" / "Move to window ▸" (normal windows only; private ones have their own session). */
function moveItems(win, tab) {
  if (win.isPrivate) return [];
  const others = [...require('./app-controller').windows].filter((w) => w !== win && !w.isPrivate && !w.closing && !w.win.isDestroyed());
  const items = [{ label: 'Move tab to new window', enabled: win.tabs.length > 1, click: () => win.moveTabToNewWindow(tab.id) }];
  if (others.length) {
    items.push({
      label: 'Move tab to window',
      submenu: others.map((w, i) => ({ label: truncate(`${i + 1}. ${w.activeTab ? w.activeTab.title || w.activeTab.url : 'Window'}`, 44), click: () => win.moveTabToWindow(tab.id, w) }))
    });
  }
  return items;
}

function showTabMenu(win, tab) {
  if (!tab) return;
  const idx = win.tabs.indexOf(tab);
  const muted = tab.wc.isAudioMuted();
  const template = [
    { label: 'New tab to the right', click: () => win.addTab({ index: idx + 1 }) },
    { type: 'separator' },
    { label: 'Reload', click: () => win.runAction('reload', { tab }) },
    { label: 'Duplicate', click: () => win.duplicateTab(tab.id) },
    { label: muted ? 'Unmute tab' : 'Mute tab', click: () => (tab.wc.setAudioMuted(!muted), tab.changed()) },
    { label: bookmarks.isBookmarked(tab.url) ? 'Remove bookmark' : 'Bookmark tab', enabled: /^(https?|file):/.test(tab.url), click: () => bookmarks.toggle(tab.url, tab.title) },
    { type: 'separator' },
    ...moveItems(win, tab),
    { type: 'separator' },
    { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => win.closeTab(tab.id) },
    { label: 'Close other tabs', enabled: win.tabs.length > 1, click: () => win.closeOtherTabs(tab.id) },
    { label: 'Close tabs to the right', enabled: idx < win.tabs.length - 1, click: () => win.closeTabsToRight(tab.id) },
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

module.exports = { showPageMenu, showTabMenu, showBookmarkFolderMenu, showBookmarkMenu };
