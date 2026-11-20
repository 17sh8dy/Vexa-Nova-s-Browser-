// Vexa Atmosphere palettes — the browser UI's colour themes. Plain script that works both
// in renderers (window.VexaPalettes) and in the main process (module.exports), so the title
// bar overlay, the browser UI, popups and vexa:// pages all agree.
(function (root) {
  'use strict';

  // Each palette overrides theme.css tokens. `dark`/`light` are applied for the matching
  // colour scheme; `forceDark` palettes are always dark (their identity is a dark look).
  const PALETTES = {
    vexa: { name: 'Vexa', desc: 'The Nova violet look', dark: {}, light: {} },
    midnight: {
      name: 'Midnight',
      desc: 'Subtle, dark and elegant',
      forceDark: true,
      dark: {
        '--strip': '#07080f', '--toolbar': '#0e1020', '--surface': '#171a2e', '--surface-hover': '#1f2340', '--surface-active': '#282d50',
        '--raised': '#121528', '--border': 'rgba(150,170,255,0.08)', '--border-strong': 'rgba(150,170,255,0.15)',
        '--text': '#e6e9f8', '--text-dim': '#9aa1c4', '--text-faint': '#626a91',
        '--accent': '#6d7cff', '--accent-2': '#a5b4fc'
      }
    },
    cyber: {
      name: 'Cyber',
      desc: 'Futuristic neon',
      forceDark: true,
      dark: {
        '--strip': '#05060a', '--toolbar': '#0a0d14', '--surface': '#111723', '--surface-hover': '#172133', '--surface-active': '#1d2a42',
        '--raised': '#0d121c', '--border': 'rgba(0,255,224,0.10)', '--border-strong': 'rgba(0,255,224,0.20)',
        '--text': '#e8fbff', '--text-dim': '#8fb3c2', '--text-faint': '#557584',
        '--accent': '#00e5d4', '--accent-2': '#ff2bd6'
      }
    },
    aurora: {
      name: 'Aurora',
      desc: 'Gradients and ambient light',
      forceDark: true,
      dark: {
        '--strip': '#061214', '--toolbar': '#0b1a1f', '--surface': '#12262c', '--surface-hover': '#183139', '--surface-active': '#1f3d47',
        '--raised': '#0f2126', '--border': 'rgba(120,255,214,0.08)', '--border-strong': 'rgba(120,255,214,0.16)',
        '--text': '#e7fbf6', '--text-dim': '#97c4ba', '--text-faint': '#5d8a80',
        '--accent': '#34d399', '--accent-2': '#a78bfa'
      }
    },
    arcade: {
      name: 'Arcade',
      desc: 'Playful colour and bounce',
      forceDark: true,
      dark: {
        '--strip': '#140a26', '--toolbar': '#1e1038', '--surface': '#2a1850', '--surface-hover': '#35205f', '--surface-active': '#40286f',
        '--raised': '#241444', '--border': 'rgba(255,214,102,0.10)', '--border-strong': 'rgba(255,214,102,0.20)',
        '--text': '#fff6e8', '--text-dim': '#cdb8e8', '--text-faint': '#8a74ad',
        '--accent': '#ff4fa3', '--accent-2': '#ffd23f'
      }
    },
    minimal: {
      name: 'Minimal',
      desc: 'Clean, quiet, distraction-free',
      dark: {
        '--strip': '#111111', '--toolbar': '#171717', '--surface': '#1f1f1f', '--surface-hover': '#272727', '--surface-active': '#303030',
        '--raised': '#1b1b1b', '--border': 'rgba(255,255,255,0.07)', '--border-strong': 'rgba(255,255,255,0.12)',
        '--text': '#ededed', '--text-dim': '#a3a3a3', '--text-faint': '#6b6b6b',
        '--accent': '#a3a3a3', '--accent-2': '#d4d4d4'
      },
      light: {
        '--strip': '#f1f1f1', '--toolbar': '#fbfbfb', '--surface': '#f0f0f0', '--surface-hover': '#e7e7e7', '--surface-active': '#dddddd',
        '--raised': '#ffffff', '--border': 'rgba(0,0,0,0.08)', '--border-strong': 'rgba(0,0,0,0.14)',
        '--text': '#171717', '--text-dim': '#5c5c5c', '--text-faint': '#9a9a9a',
        '--accent': '#525252', '--accent-2': '#737373'
      }
    }
  };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return rgbToHex(l * 255, l * 255, l * 255);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return rgbToHex(f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255);
  }

  /** Tokens derived from one accent colour: a second hue for gradients, readable text, soft fills. */
  function accentTokens(hex, dark) {
    const rgb = hexToRgb(hex);
    if (!rgb) return {};
    const [h, s, l] = rgbToHsl(...rgb);
    const text = dark ? hslToHex(h, Math.min(1, s * 0.9 + 0.05), Math.max(0.72, Math.min(0.86, l + 0.25))) : hslToHex(h, s, Math.min(0.42, l * 0.8));
    return {
      '--accent': hex,
      '--accent-2': hslToHex(h + 28, Math.min(1, s + 0.05), Math.min(0.78, l + 0.08)),
      '--accent-text': text,
      '--accent-soft': `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${dark ? 0.18 : 0.13})`,
      '--accent-ring': `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${dark ? 0.45 : 0.35})`
    };
  }

  /**
   * Resolve a look into CSS custom properties.
   * look = { palette, accent } ; systemDark = the OS / theme setting's dark flag.
   */
  function resolve(look, systemDark) {
    const p = PALETTES[(look && look.palette) || 'vexa'] || PALETTES.vexa;
    const dark = p.forceDark ? true : !!systemDark;
    const vars = { ...(dark ? p.dark : p.light) };
    const accent = (look && look.accent) || (p !== PALETTES.vexa ? vars['--accent'] : '');
    if (accent) Object.assign(vars, accentTokens(accent, dark));
    return { vars, dark, forceDark: !!p.forceDark };
  }

  /** Apply a look to a document (renderer side). Removes the variables a previous look set. */
  function apply(doc, look, systemDark) {
    const el = doc.documentElement;
    const { vars, dark } = resolve(look, systemDark);
    for (const k of el._vexaVars || []) if (!(k in vars)) el.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    el._vexaVars = Object.keys(vars);
    el.dataset.palette = (look && look.palette) || 'vexa';
    el.classList.toggle('palette-dark', dark);
    el.style.colorScheme = Object.keys(vars).length && dark ? 'dark' : '';
    return dark;
  }

  const api = { PALETTES, resolve, apply, accentTokens, hexToRgb };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VexaPalettes = api;
})(typeof window !== 'undefined' ? window : globalThis);
