'use strict';
// New Tab defaults across versions. Pure (no Electron), so it's unit-tested directly.
//
// 0.91 made the New Tab page about exploring: the search box leads, and the Spaces and
// Collections boxes are no longer shown by default (both are always in the sidebar, and
// Collections is in the page footer too). The widgets still exist under Customize → Layout.
//
// Existing profiles are only moved to the new defaults when their widget choices are still
// exactly what 0.90 shipped with — i.e. the user never customized them. Anyone who changed
// a widget, the order or the arrangement keeps their layout untouched.

const NTP_DEFAULTS_VERSION = 2;

const WIDGET_ORDER_090 = ['search', 'favorites', 'shortcuts', 'recent', 'collections', 'spaces', 'weather'];
const WIDGETS_090 = { favorites: true, recent: false, collections: true, spaces: true, weather: false, layout: 'centered' };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Did this saved New Tab config still have 0.90's default widget choices? Missing keys count as default. */
function hasUntouched090Widgets(saved) {
  if (!isObj(saved)) return true;
  for (const [k, def] of Object.entries(WIDGETS_090)) {
    if (Object.hasOwn(saved, k) && saved[k] !== def) return false;
  }
  if (Object.hasOwn(saved, 'order') && (!Array.isArray(saved.order) || saved.order.join() !== WIDGET_ORDER_090.join())) return false;
  return true;
}

/**
 * Bring a profile's New Tab config up to the current defaults.
 * @param {object|undefined} saved     newTab exactly as it was in settings.json (undefined = none saved)
 * @param {number|undefined} version   ntpDefaultsVersion from settings.json (undefined = before 0.91)
 * @returns {{ patch: object, changed: boolean }}  keys to apply on top of the saved config
 */
function migrateNewTab(saved, version) {
  if (Number(version) >= NTP_DEFAULTS_VERSION) return { patch: {}, changed: false };
  // Nothing saved yet: the current defaults apply as they are.
  if (!isObj(saved)) return { patch: {}, changed: false };
  if (!hasUntouched090Widgets(saved)) return { patch: {}, changed: false };
  return { patch: { collections: false, spaces: false }, changed: true };
}

module.exports = { NTP_DEFAULTS_VERSION, WIDGETS_090, WIDGET_ORDER_090, hasUntouched090Widgets, migrateNewTab };
