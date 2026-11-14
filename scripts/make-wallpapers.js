'use strict';
// Generates Vexa's New Tab wallpaper gallery (original SVG artwork) into
// src/pages/newtab/wallpapers. Deterministic: same output every run.
//   node scripts/make-wallpapers.js

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'pages', 'newtab', 'wallpapers');
const W = 1920;
const H = 1080;

function prng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => Math.round(n * 10) / 10;

function svg(body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">
<defs>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter>
<filter id="softer" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .07 0"/></filter>
${defs}
</defs>
${body}
<rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>
`;
}

function stars(rand, n, { yMax = H, color = '#fff', max = 1.6, minOpacity = 0.25 } = {}) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const r = rand() < 0.94 ? 0.4 + rand() * 0.8 : 1 + rand() * (max - 1);
    out += `<circle cx="${f(rand() * W)}" cy="${f(rand() * yMax)}" r="${f(r)}" fill="${color}" opacity="${f((minOpacity + rand() * (1 - minOpacity)) * 100) / 100}"/>`;
  }
  return out;
}

function blob(cx, cy, r, color, opacity = 1, filter = 'soft') {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${opacity}" filter="url(#${filter})"/>`;
}

/** A ridge line across the image: smooth random hills. */
function ridge(rand, baseY, amp, steps, fill, opacity = 1) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push([(i / steps) * W, baseY - rand() * amp]);
  let d = `M0 ${H} L0 ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${f(mx)} ${f(y0)} ${f(mx)} ${f(y1)} ${f(x1)} ${f(y1)}`;
  }
  d += ` L${W} ${H} Z`;
  return `<path d="${d}" fill="${fill}" opacity="${opacity}"/>`;
}

/** Jagged mountain range. */
function range(rand, baseY, amp, peaks, fill, opacity = 1) {
  let d = `M0 ${H} L0 ${f(baseY - rand() * amp * 0.4)}`;
  const n = peaks * 2;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * W + (rand() - 0.5) * (W / n) * 0.6;
    const y = i % 2 ? baseY - amp * (0.55 + rand() * 0.45) : baseY - amp * rand() * 0.35;
    d += ` L${f(x)} ${f(y)}`;
  }
  d += ` L${W} ${H} Z`;
  return `<path d="${d}" fill="${fill}" opacity="${opacity}" stroke-linejoin="round"/>`;
}

const WALLPAPERS = {
  nebula() {
    const r = prng(11);
    return svg(
      `<rect width="${W}" height="${H}" fill="#0a0716"/>
${blob(560, 380, 420, '#6d28d9', 0.85)}
${blob(1320, 300, 360, '#c026d3', 0.55)}
${blob(1180, 760, 460, '#4338ca', 0.7)}
${blob(380, 860, 300, '#9333ea', 0.45)}
${blob(940, 520, 220, '#f0abfc', 0.35)}
<ellipse cx="960" cy="540" rx="900" ry="140" fill="#c4b5fd" opacity=".10" transform="rotate(-18 960 540)" filter="url(#softer)"/>
${stars(r, 520, { max: 1.8 })}
${stars(r, 14, { color: '#ede9fe', max: 2.6, minOpacity: 0.7 })}`
    );
  },

  aurora() {
    const r = prng(23);
    const band = (y, c1, c2, op, sw) =>
      `<path d="M-100 ${y} C 400 ${y - 260}, 800 ${y + 120}, 1200 ${y - 140} S 1800 ${y - 60}, 2050 ${y - 240}" stroke="url(#${c1})" stroke-width="${sw}" fill="none" opacity="${op}" filter="url(#softer)"/>${c2}`;
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#aurSky)"/>
${stars(r, 380, { yMax: 760 })}
${band(560, 'aurA', '', 0.85, 120)}
${band(470, 'aurB', '', 0.6, 70)}
${band(640, 'aurA', '', 0.35, 200)}
${ridge(r, 900, 120, 9, '#05131c')}
${ridge(r, 985, 90, 12, '#020a10')}`,
      `<linearGradient id="aurSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#020617"/><stop offset=".6" stop-color="#062033"/><stop offset="1" stop-color="#0a2e3a"/></linearGradient>
<linearGradient id="aurA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#22d3ee" stop-opacity="0"/><stop offset=".25" stop-color="#34d399"/><stop offset=".6" stop-color="#22d3ee"/><stop offset=".85" stop-color="#a78bfa"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></linearGradient>
<linearGradient id="aurB" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#86efac" stop-opacity="0"/><stop offset=".4" stop-color="#86efac"/><stop offset=".75" stop-color="#5eead4"/><stop offset="1" stop-color="#5eead4" stop-opacity="0"/></linearGradient>`
    );
  },

  dusk() {
    const r = prng(37);
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#duskSky)"/>
${blob(1240, 690, 260, '#fdba74', 0.9, 'softer')}
<circle cx="1240" cy="700" r="92" fill="#fff1e0" opacity=".95"/>
${stars(r, 120, { yMax: 380, minOpacity: 0.15 })}
${ridge(r, 760, 90, 6, '#7c2d6b', 0.75)}
${ridge(r, 830, 110, 5, '#4c1d5f', 0.9)}
${ridge(r, 920, 120, 4, '#2a1040')}
${ridge(r, 1010, 80, 5, '#160822')}`,
      `<linearGradient id="duskSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset=".38" stop-color="#5b21b6"/><stop offset=".62" stop-color="#db2777"/><stop offset=".78" stop-color="#fb923c"/><stop offset="1" stop-color="#fed7aa"/></linearGradient>`
    );
  },

  peaks() {
    const r = prng(41);
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#pkSky)"/>
${stars(r, 300, { yMax: 600 })}
${blob(1460, 250, 140, '#c7d2fe', 0.35, 'softer')}
<circle cx="1460" cy="250" r="54" fill="#eef2ff"/>
${range(r, 640, 260, 5, '#3b3f8f', 0.55)}
${range(r, 740, 280, 6, '#2b2d6e', 0.75)}
${range(r, 860, 260, 7, '#1b1b4a', 0.92)}
${range(r, 980, 200, 9, '#0d0c28')}
<rect y="560" width="${W}" height="200" fill="#a5b4fc" opacity=".06" filter="url(#softer)"/>`,
      `<linearGradient id="pkSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1026"/><stop offset=".55" stop-color="#26275f"/><stop offset="1" stop-color="#5b5bb0"/></linearGradient>`
    );
  },

  tide() {
    const r = prng(53);
    const wave = (y, amp, color, op) => {
      let d = `M0 ${H} L0 ${y}`;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const x0 = (i / n) * W;
        const x1 = ((i + 1) / n) * W;
        const dy = (r() - 0.5) * amp;
        d += ` Q${f((x0 + x1) / 2)} ${f(y + dy * 2)} ${f(x1)} ${f(y + (r() - 0.5) * amp * 0.4)}`;
      }
      return `<path d="${d} L${W} ${H} Z" fill="${color}" opacity="${op}"/>`;
    };
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#tdSky)"/>
${blob(960, 420, 420, '#38bdf8', 0.35)}
${blob(500, 300, 260, '#818cf8', 0.3)}
${wave(560, 120, '#0e7490', 0.55)}
${wave(650, 140, '#155e75', 0.75)}
${wave(760, 150, '#0c4a6e', 0.9)}
${wave(880, 130, '#082f49', 1)}
${wave(990, 90, '#041a2c', 1)}
${stars(r, 60, { yMax: 520, color: '#e0f2fe', minOpacity: 0.2 })}`,
      `<linearGradient id="tdSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1a3a"/><stop offset=".55" stop-color="#1d4e89"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>`
    );
  },

  ember() {
    const r = prng(67);
    let sparks = '';
    for (let i = 0; i < 90; i++) sparks += `<circle cx="${f(r() * W)}" cy="${f(380 + r() * 700)}" r="${f(0.8 + r() * 2.2)}" fill="#fed7aa" opacity="${f(0.2 + r() * 0.7)}" filter="url(#glow)"/>`;
    return svg(
      `<rect width="${W}" height="${H}" fill="#120604"/>
${blob(420, 760, 420, '#b91c1c', 0.75)}
${blob(1100, 820, 480, '#ea580c', 0.7)}
${blob(1580, 520, 340, '#9f1239', 0.6)}
${blob(820, 420, 260, '#f59e0b', 0.4)}
${blob(1300, 980, 260, '#fbbf24', 0.5)}
${sparks}`
    );
  },

  midnight() {
    const r = prng(79);
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#mnSky)"/>
<ellipse cx="960" cy="420" rx="1100" ry="170" fill="#818cf8" opacity=".16" transform="rotate(24 960 420)" filter="url(#soft)"/>
<ellipse cx="960" cy="420" rx="900" ry="60" fill="#e0e7ff" opacity=".10" transform="rotate(24 960 420)" filter="url(#softer)"/>
${stars(r, 900, { max: 1.5, minOpacity: 0.15 })}
${stars(r, 24, { color: '#c7d2fe', max: 2.4, minOpacity: 0.8 })}
${blob(960, 1180, 520, '#7c3aed', 0.5)}
${ridge(r, 1020, 40, 14, '#05040d')}`,
      `<linearGradient id="mnSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03030b"/><stop offset=".7" stop-color="#0b0b24"/><stop offset="1" stop-color="#1a1240"/></linearGradient>`
    );
  },

  glacier() {
    const r = prng(83);
    return svg(
      `<rect width="${W}" height="${H}" fill="url(#glSky)"/>
${blob(420, 300, 380, '#bae6fd', 0.9)}
${blob(1400, 260, 420, '#c7d2fe', 0.8)}
${blob(1000, 700, 420, '#a5f3fc', 0.55)}
${blob(260, 900, 300, '#e0e7ff', 0.9)}
${range(r, 820, 220, 6, '#dbeafe', 0.75)}
${range(r, 930, 200, 8, '#c3d7f5', 0.7)}
${ridge(r, 1010, 60, 8, '#eef4ff', 0.95)}`,
      `<linearGradient id="glSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0f7ff"/><stop offset="1" stop-color="#e3ecfb"/></linearGradient>`
    );
  },

  bloom() {
    return svg(
      `<rect width="${W}" height="${H}" fill="#fdf6f0"/>
${blob(420, 360, 420, '#fecdd3', 0.95)}
${blob(1380, 300, 400, '#e9d5ff', 0.95)}
${blob(1100, 820, 460, '#fed7aa', 0.8)}
${blob(380, 900, 320, '#fbcfe8', 0.8)}
${blob(900, 520, 260, '#ddd6fe', 0.7)}`
    );
  }
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(WALLPAPERS)) {
  const file = path.join(OUT, name + '.svg');
  fs.writeFileSync(file, make());
  console.log(`${name}.svg  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
