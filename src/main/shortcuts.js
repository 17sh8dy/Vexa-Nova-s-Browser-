'use strict';
// Keyboard shortcuts. We intercept them with `before-input-event` on every
// webContents we own (tabs, browser UI, popups) so they work no matter which
// part of the window has focus — no hidden application menu required.

const isMac = process.platform === 'darwin';

// [modifiers, key, action]. "Mod" = Ctrl on Windows/Linux, Cmd on macOS.
const BINDINGS = [
  ['Mod', 't', 'new-tab'],
  ['Mod', 'n', 'new-window'],
  ['Mod+Shift', 'n', 'new-private-window'],
  ['Mod', 'w', 'close-tab'],
  ['Mod', 'F4', 'close-tab'],
  ['Mod+Shift', 'w', 'close-window'],
  ['Mod+Shift', 't', 'reopen-tab'],
  ['Ctrl', 'Tab', 'next-tab'],
  ['Ctrl+Shift', 'Tab', 'prev-tab'],
  ['Mod', 'PageDown', 'next-tab'],
  ['Mod', 'PageUp', 'prev-tab'],
  ['Mod', 'l', 'focus-address'],
  ['Alt', 'd', 'focus-address'],
  ['', 'F6', 'focus-address'],
  ['Mod', 'r', 'reload'],
  ['', 'F5', 'reload'],
  ['Mod+Shift', 'r', 'hard-reload'],
  ['Mod', 'F5', 'hard-reload'],
  ['Shift', 'F5', 'hard-reload'],
  ['Alt', 'ArrowLeft', 'back'],
  ['Alt', 'ArrowRight', 'forward'],
  ['Alt', 'Home', 'home'],
  ['Mod', 'd', 'bookmark'],
  ['Mod', 'h', 'history'],
  ['Mod', 'j', 'downloads'],
  ['Mod+Shift', 'b', 'toggle-bookmarks-bar'],
  ['Mod+Shift', 'o', 'bookmarks'],
  ['Mod', ',', 'settings'],
  ['Mod+Shift', 'Delete', 'clear-data'],
  ['Mod', 'f', 'find'],
  ['', 'F3', 'find-next'],
  ['Mod', 'g', 'find-next'],
  ['Shift', 'F3', 'find-prev'],
  ['Mod+Shift', 'g', 'find-prev'],
  ['Mod', '=', 'zoom-in'],
  ['Mod', '+', 'zoom-in'],
  ['Mod+Shift', '+', 'zoom-in'],
  ['Mod+Shift', '=', 'zoom-in'],
  ['Mod', '-', 'zoom-out'],
  ['Mod', '0', 'zoom-reset'],
  ['Mod', 'p', 'print'],
  ['Mod', 'u', 'view-source'],
  ['', 'F11', 'fullscreen'],
  ['', 'F12', 'devtools'],
  ['Mod+Shift', 'i', 'devtools'],
  ['Mod+Shift', 'j', 'devtools'],
  ['Mod', '1', 'tab-1'],
  ['Mod', '2', 'tab-2'],
  ['Mod', '3', 'tab-3'],
  ['Mod', '4', 'tab-4'],
  ['Mod', '5', 'tab-5'],
  ['Mod', '6', 'tab-6'],
  ['Mod', '7', 'tab-7'],
  ['Mod', '8', 'tab-8'],
  ['Mod', '9', 'tab-last'],
  // 0.90
  ['', 'F9', 'reader'],
  ['Mod+Shift', 'f', 'focus-mode'],
  ['Mod+Shift', 's', 'collect'],
  ['Mod+Shift', 'e', 'toggle-sidebar'],
  // Spaces by position: Ctrl+Shift+1 … 9 (matched on the physical key, so it works on any layout)
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ['Mod+Shift', `Digit${n}`, `space-${n}`])
];
if (isMac) {
  BINDINGS.push(['Mod', '[', 'back'], ['Mod', ']', 'forward'], ['Mod', 'ArrowLeft', 'back'], ['Mod', 'ArrowRight', 'forward'], ['Mod', 'q', 'quit']);
}

function normalizeKey(key) {
  return key.length === 1 ? key.toLowerCase() : key;
}

function matches(input, mods, key) {
  const want = new Set(mods ? mods.split('+') : []);
  const ctrl = want.has('Ctrl') || (!isMac && want.has('Mod'));
  const meta = isMac && want.has('Mod');
  if (!!input.control !== ctrl) return false;
  if (!!input.meta !== meta) return false;
  if (!!input.alt !== want.has('Alt')) return false;
  // Shift is ignored for keys that need Shift to type (e.g. "+").
  if (key !== '+' && !!input.shift !== want.has('Shift')) return false;
  // Physical keys (Digit1, Space…) are compared by code, so Shift+1 still matches on any layout.
  if (/^(Digit\d|Space)$/.test(key)) return input.code === key;
  return normalizeKey(input.key) === normalizeKey(key);
}

// The Command Center key is a setting (Settings → General).
const COMMAND_KEYS = {
  'ctrl+space': ['Ctrl', 'Space'],
  'ctrl+shift+space': ['Ctrl+Shift', 'Space'],
  'ctrl+shift+k': ['Mod+Shift', 'k'],
  off: null
};
let commandBinding = COMMAND_KEYS['ctrl+space'];
function setCommandKey(id) {
  commandBinding = Object.hasOwn(COMMAND_KEYS, id) ? COMMAND_KEYS[id] : COMMAND_KEYS['ctrl+space'];
}

/** Returns the action for a before-input-event `input`, or null. */
function actionFor(input) {
  if (input.type !== 'keyDown') return null;
  if (commandBinding && matches(input, commandBinding[0], commandBinding[1])) return 'command-center';
  for (const [mods, key, action] of BINDINGS) if (matches(input, mods, key)) return action;
  return null;
}

module.exports = { actionFor, BINDINGS, setCommandKey, COMMAND_KEYS };
