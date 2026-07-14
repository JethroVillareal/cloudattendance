'use strict';

const byId = (id) => document.getElementById(id);
let loginMode = 'key';

function setMessage(message, type = 'error') {
  const element = byId('loginMessage');
  element.className = `login-message ${message ? type : ''}`.trim();
  element.textContent = message;
}

function setMode(mode) {
  loginMode = mode === 'account' ? 'account' : 'key';
  document.querySelectorAll('[data-login-mode]').forEach((button) => {
    const active = button.dataset.loginMode === loginMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  byId('accountLoginFields').classList.toggle('hidden', loginMode !== 'account');
  byId('keyLoginFields').classList.toggle('hidden', loginMode !== 'key');
  setMessage('');
  byId(loginMode === 'key' ? 'loginApiKey' : 'loginUsername').focus();
}

function toggleSecret(inputId, buttonId, label) {
  const input = byId(inputId);
  const button = byId(buttonId);
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  button.textContent = reveal ? 'Hide' : 'Show';
  button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} ${label}`);
}

async function submitLogin(event) {
  event.preventDefault();
  const username = byId('loginUsername').value.trim();
  const password = byId('loginPassword').value;
  const apiKey = byId('loginApiKey').value.trim();

  if (loginMode === 'key' && !apiKey) {
    setMessage('Enter your server access key before signing in.');
    byId('loginApiKey').focus();
    return;
  }
  if (loginMode === 'account' && (!username || !password)) {
    setMessage('Enter both your username and password.');
    byId(!username ? 'loginUsername' : 'loginPassword').focus();
    return;
  }

  const submit = byId('loginSubmit');
  const label = submit.querySelector('span');
  submit.disabled = true;
  label.textContent = 'Checking credentials...';
  setMessage('Connecting securely to the attendance server…', 'working');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginMode === 'key' ? { apiKey } : { username, password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429) throw new Error('Too many attempts. Wait a few minutes, then try again.');
      if (response.status === 401) {
        throw new Error(loginMode === 'key'
          ? 'Wrong server key. Use the exact API_KEY value from this server’s .env.'
          : 'Wrong username or password. Check the account values in this server’s .env.');
      }
      throw new Error(result.message || `Login failed (${response.status}).`);
    }
    label.textContent = 'Login successful';
    setMessage('Credentials accepted. Opening your dashboard…', 'success');
    window.location.replace('/dashboard');
  } catch (error) {
    label.textContent = 'Sign in securely';
    setMessage(error.message || 'Cannot reach the server. Check that it is running, then try again.');
    submit.disabled = false;
  }
}

document.querySelectorAll('[data-login-mode]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.loginMode));
});
byId('toggleLoginPassword').addEventListener('click', () => toggleSecret('loginPassword', 'toggleLoginPassword', 'password'));
byId('toggleLoginApiKey').addEventListener('click', () => toggleSecret('loginApiKey', 'toggleLoginApiKey', 'server key'));
byId('loginForm').addEventListener('submit', submitLogin);
byId('loginApiKey').focus();
