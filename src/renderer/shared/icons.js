// Vexa icon set — 24px grid, 1.75 stroke, rounded joins. Plain script (no modules)
// so it works from file:// in every renderer.
(function () {
  const s = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  window.VexaIcons = {
    back: s('<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>'),
    forward: s('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
    reload: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    stop: s('<path d="M6 6l12 12M18 6 6 18"/>'),
    home: s('<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/><path d="M10 19v-5h4v5"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    close: s('<path d="M7 7l10 10M17 7 7 17"/>', 'width="14" height="14"'),
    menu: s('<circle cx="12" cy="5.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor"/>'),
    star: s('<path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/>'),
    starFilled: s('<path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z" fill="currentColor"/>'),
    download: s('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
    lock: s('<rect x="5.5" y="10.5" width="13" height="9" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', 'width="14" height="14"'),
    warning: s('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.8" r=".6" fill="currentColor"/>', 'width="14" height="14"'),
    info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>', 'width="14" height="14"'),
    file: s('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4"/>'),
    globe: s('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>', 'width="16" height="16"'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>', 'width="16" height="16"'),
    clock: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 'width="16" height="16"'),
    bookmark: s('<path d="M7 4h10v16l-5-3.5L7 20z"/>', 'width="16" height="16"'),
    folder: s('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>', 'width="16" height="16"'),
    volume: s('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/>', 'width="14" height="14"'),
    muted: s('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>', 'width="14" height="14"'),
    chevronUp: s('<path d="m6 15 6-6 6 6"/>', 'width="16" height="16"'),
    chevronDown: s('<path d="m6 9 6 6 6-6"/>', 'width="16" height="16"'),
    minus: s('<path d="M5 12h14"/>', 'width="16" height="16"'),
    fullscreen: s('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'width="16" height="16"'),
    pause: s('<path d="M9 6v12M15 6v12"/>', 'width="16" height="16"'),
    play: s('<path d="M8 5.5v13l10-6.5z"/>', 'width="16" height="16"'),
    folderOpen: s('<path d="M3.5 18V6.5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2V10"/><path d="M3.5 18 6 11h15l-2.5 7z"/>', 'width="16" height="16"'),
    retry: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', 'width="16" height="16"'),
    mask: s('<path d="M3 9.5c3-1.5 15-1.5 18 0-.3 4-2.6 6-5.2 6-1.8 0-2.6-1.6-3.8-1.6S10 15.5 8.2 15.5C5.6 15.5 3.3 13.5 3 9.5z"/><circle cx="8.3" cy="11" r="1" fill="currentColor"/><circle cx="15.7" cy="11" r="1" fill="currentColor"/>', 'width="16" height="16"'),
    camera: s('<rect x="3" y="6.5" width="13" height="11" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>', 'width="16" height="16"'),
    mic: s('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>', 'width="16" height="16"'),
    pin: s('<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>', 'width="16" height="16"'),
    bell: s('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>', 'width="16" height="16"'),
    external: s('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>', 'width="16" height="16"'),
    shield: s('<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/>', 'width="16" height="16"'),
    settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 'width="16" height="16"')
  };
  // Brand mark (used in the browser UI).
  window.VexaMark = (size = 18) =>
    `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><defs><linearGradient id="vxl${size}" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#ede9fe"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient><linearGradient id="vxr${size}" x1="1" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#5b21b6"/></linearGradient></defs><path d="M46 14 L32 48" stroke="url(#vxr${size})" stroke-width="10" stroke-linecap="round" fill="none"/><path d="M18 14 L32 48" stroke="url(#vxl${size})" stroke-width="10" stroke-linecap="round" fill="none"/><path d="M52 2 Q53 8 58 9 Q53 10 52 16 Q51 10 46 9 Q51 8 52 2 Z" fill="#c4b5fd"/></svg>`;
})();
