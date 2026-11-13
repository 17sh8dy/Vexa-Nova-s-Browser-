'use strict';
// Autocomplete for the search box. Keyboard: Up/Down to move, Enter to pick, Esc to close.
(() => {
  const form = document.querySelector('form.box');
  if (!form) return;
  const input = form.querySelector('input[name=q]');
  const list = form.querySelector('.suggest');
  let items = [];
  let active = -1;
  let timer = 0;
  let seq = 0;

  const close = () => { list.hidden = true; active = -1; };
  const render = () => {
    list.replaceChildren(...items.map((s, i) => {
      const li = document.createElement('li');
      li.textContent = s;
      li.setAttribute('role', 'option');
      if (i === active) li.className = 'on';
      li.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = s; form.submit(); });
      return li;
    }));
    list.hidden = items.length === 0;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await fetch('/api/suggest?q=' + encodeURIComponent(q));
        const data = await r.json();
        if (mine !== seq) return;
        items = data.suggestions.filter((s) => s !== q.toLowerCase());
        active = -1;
        render();
      } catch { close(); }
    }, 90);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1);
      if (active === items.length) active = -1;
      if (active >= 0) input.value = items[active];
      render();
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
})();
