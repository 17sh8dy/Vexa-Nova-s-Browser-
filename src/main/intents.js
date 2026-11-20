'use strict';
// Natural-language commands for the Command Center, without AI: a small set of rules that
// turn phrases like "switch to gaming", "focus on thesis for 50 minutes" or "save this page
// to Recipes" into actions. Pure (no Electron), unit tested.
//
// A future Nova AI provider can sit next to this (commandCenter.registerProvider) and
// return the same `run` descriptors; basic commands never depend on it.

const DURATION = /(?:\s+for\s+(\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours))?\s*$/i;

function minutesOf(n, unit) {
  if (!n) return null;
  const v = Number(n);
  return /^h/i.test(unit) ? v * 60 : v;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * @param {string} text
 * @param {{ spaces?: {id,name}[], collections?: {id,name}[], presets?: {id,name}[], sections?: {hash,name}[] }} ctx
 * @returns {{ title: string, subtitle?: string, icon: string, run: object, score: number }[]}
 */
function parse(text, ctx = {}) {
  // Patterns match case-insensitively on the original text, so names keep their capitals.
  const orig = String(text || '').replace(/\s+/g, ' ').trim();
  const t = orig.toLowerCase();
  const out = [];
  if (t.length < 2) return out;
  const spaces = ctx.spaces || [];
  const collections = ctx.collections || [];
  const presets = ctx.presets || [];
  const findByName = (list, name) => {
    const n = norm(name).replace(/^the\s+/, '').replace(/\s+(space|collection|preset|theme)$/, '');
    return list.find((x) => norm(x.name) === n) || list.find((x) => norm(x.name).startsWith(n) && n.length > 1) || list.find((x) => norm(x.name).replace(/^focus: /, '') === n) || null;
  };

  let m;
  // ---- Spaces
  if ((m = /^(?:switch|go|change|jump|move)(?: over)?(?: to)?(?: (?:my|the))? (.+?)$/i.exec(orig))) {
    const s = findByName(spaces, m[1]);
    if (s) out.push({ title: `Switch to ${s.name}`, subtitle: 'Space', icon: 'spaces', run: { kind: 'space', id: s.id }, score: 990 });
  }
  if ((m = /^(?:new|create|add|make)(?: a)?(?: new)? space(?: (?:called|named|for))? (.+)$/i.exec(orig)) || (m = /^(?:new|create|make) (.+?) space$/i.exec(orig))) {
    const name = m[1].replace(/^["'“]|["'”]$/g, '').trim();
    if (name) out.push({ title: `Create a Space called “${name.slice(0, 40)}”`, subtitle: 'Spaces', icon: 'plus', run: { kind: 'create-space', name: name.slice(0, 40) }, score: 985 });
  }

  // ---- Focus
  if ((m = /^(?:start (?:a )?)?focus(?:ing)?(?: session)?(?: on)?(?: (.+?))?$/i.exec(orig)) && !/^focus (mode|off|end|stop)$/.test(t)) {
    const rest = m[1] || '';
    const d = DURATION.exec(rest);
    const name = d ? rest.slice(0, d.index).trim() : rest.trim();
    const minutes = d ? minutesOf(d[1], d[2]) : null;
    out.push({ title: `Start a focus session${name ? `: ${name}` : ''}${minutes ? ` · ${minutes} min` : ''}`, subtitle: 'Focus', icon: 'target', run: { kind: 'focus', name: name.slice(0, 60), minutes }, score: 980 });
  }
  if (/^(?:stop|end|finish|quit)(?: the)?(?: focus)?(?: session)?$/.test(t) && /focus|session/.test(t)) {
    out.push({ title: 'End the focus session', subtitle: 'Focus', icon: 'target', run: { kind: 'action', action: 'focus-end' }, score: 980 });
  }

  // ---- Atmosphere presets / themes
  for (const p of presets) {
    const n = norm(p.name);
    if (new RegExp(`^(?:(?:apply|use|switch to|set|change to|go)\\s+)?(?:the\\s+)?${n}(?:\\s+(?:theme|preset|atmosphere|look|mode))?$`).test(t)) {
      out.push({ title: `Apply the ${p.name} atmosphere`, subtitle: 'Atmosphere preset', icon: 'palette', run: { kind: 'preset', id: p.id }, score: 975 });
    }
  }
  if ((m = /^(?:(?:switch to|use|turn on|enable|go)\s+)?(dark|light|system)(?: mode| theme)?$/i.exec(orig))) {
    const v = m[1].toLowerCase();
    out.push({ title: `Use the ${v} theme`, subtitle: 'Appearance', icon: 'palette', run: { kind: 'setting', key: 'theme', value: v }, score: 970 });
  }

  // ---- Collections
  if ((m = /^(?:save|add|put|clip)(?: this)?(?: (?:page|tab|site|link))? (?:to|in|into) (?:my |the )?(.+?)(?: collection)?$/i.exec(orig))) {
    const c = findByName(collections, m[1]);
    if (c) out.push({ title: `Save this page to ${c.name}`, subtitle: 'Collections', icon: 'collection', run: { kind: 'collect', collectionId: c.id }, score: 975 });
    else out.push({ title: `Save this page to a new collection “${m[1].slice(0, 40)}”`, subtitle: 'Collections', icon: 'collection', run: { kind: 'collect-new', name: m[1].slice(0, 60) }, score: 940 });
  }
  if (/^(?:take (?:a )?)?screenshot(?: (?:this|the) (?:page|tab))?$/.test(t)) {
    out.push({ title: 'Screenshot this page to a collection', subtitle: 'Collections', icon: 'camera', run: { kind: 'action', action: 'screenshot' }, score: 960 });
  }

  // ---- Tab actions
  const TAB = { close: 'close-tab', reload: 'reload', refresh: 'reload', duplicate: 'duplicate-tab', mute: 'mute-tab', unmute: 'mute-tab', pin: 'pin-tab', unpin: 'pin-tab', bookmark: 'bookmark' };
  if ((m = /^(close|reload|refresh|duplicate|mute|unmute|pin|unpin|bookmark)(?: (?:this|the|current))?(?: tab| page)?$/i.exec(orig))) {
    out.push({ title: `${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} this tab`, subtitle: 'Tab', icon: 'tab', run: { kind: 'action', action: TAB[m[1].toLowerCase()] }, score: 960 });
  }
  if (/^(?:open |turn on |enter |switch to )?reader(?: mode| view)?$|^read (?:mode|view|this)$/.test(t)) {
    out.push({ title: 'Reader view', subtitle: 'Focus', icon: 'book', run: { kind: 'action', action: 'reader' }, score: 960 });
  }

  // ---- Search / open
  if ((m = /^(?:search|find|look up|google|lookup)(?: for)? (.+?)(?: (?:on|with|in|using) (google|bing|duckduckgo|ddg|youtube|wikipedia|github|vexa|vexa search|nova))?$/i.exec(orig))) {
    const engine = { google: 'g', bing: 'b', duckduckgo: 'ddg', ddg: 'ddg', youtube: 'yt', wikipedia: 'w', github: 'gh', vexa: 'vexa', 'vexa search': 'vexa', nova: 'nova' }[(m[2] || '').toLowerCase()] || (t.startsWith('google ') ? 'g' : '');
    out.push({ title: `Search${engine ? ` ${m[2] || 'Google'}` : ''} for “${m[1].slice(0, 80)}”`, subtitle: 'Search', icon: 'search', run: { kind: 'search', query: m[1].slice(0, 300), engine }, score: 950 });
  }
  if ((m = /^(?:open|go to|visit|load|navigate to) (\S+\.\S+|localhost(?::\d+)?\S*)$/i.exec(orig))) {
    out.push({ title: `Open ${m[1]}`, subtitle: 'Website', icon: 'globe', run: { kind: 'open', input: m[1] }, score: 955 });
  }

  // ---- Settings
  if ((m = /^(?:open )?settings?(?: (?:for|about|on))? ?(.*)$/i.exec(orig)) && ctx.sections) {
    const q = m[1].trim().toLowerCase();
    const sec = q ? ctx.sections.find((s) => norm(s.name).startsWith(q) || norm(s.name).includes(q)) : null;
    if (q && sec) out.push({ title: `Open ${sec.name} settings`, subtitle: 'Settings', icon: 'settings', run: { kind: 'settings', hash: sec.hash }, score: 950 });
  }
  return out;
}

module.exports = { parse, minutesOf };
