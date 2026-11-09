(async () => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const info = await window.vexaAuth.info();
  if (!info) return window.vexaAuth.submit(null);
  if (info.isPrivate) document.documentElement.classList.add('private');

  $('#who').textContent = info.isProxy
    ? `The proxy ${info.host} requires a username and password.`
    : `${info.host} requires a username and password.${info.realm ? ` (“${info.realm}”)` : ''}`;
  $('#user').value = info.username;
  $('#pass').value = info.password;
  $('#remember-row').hidden = !info.canRemember;
  (info.username ? $('#pass') : $('#user')).focus();

  const ok = () => window.vexaAuth.submit({ username: $('#user').value, password: $('#pass').value, remember: $('#remember').checked });
  $('#ok').addEventListener('click', ok);
  $('#cancel').addEventListener('click', () => window.vexaAuth.submit(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok();
    else if (e.key === 'Escape') window.vexaAuth.submit(null);
  });
})();
