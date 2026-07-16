'use strict';

const byId = (id) => document.getElementById(id);

function setMessage(message, type = 'error') {
  const element = byId('loginMessage');
  element.className = `login-message ${message ? type : ''}`.trim();
  element.textContent = message;
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
  if (!username || !password) {
    setMessage('Enter both your username and password.');
    byId(!username ? 'loginUsername' : 'loginPassword').focus();
    return;
  }
  const submit = byId('loginSubmit');
  const label = submit.querySelector('span');
  submit.disabled = true;
  label.textContent = 'Checking credentials...';
  setMessage('Connecting securely to the attendance server...', 'working');
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429) throw new Error('Too many attempts. Wait a few minutes, then try again.');
      if (response.status === 401) throw new Error('Wrong username or password.');
      throw new Error(result.message || `Login failed (${response.status}).`);
    }
    label.textContent = 'Login successful';
    if (byId('rememberLogin').checked) localStorage.setItem('gmsRememberedUsername', username);
    else localStorage.removeItem('gmsRememberedUsername');
    setMessage('Credentials accepted. Opening your workspace...', 'success');
    window.location.replace(result.redirectTo || '/dashboard');
  } catch (error) {
    label.textContent = 'Sign in securely';
    setMessage(error.message || 'Cannot reach the server. Check that it is running, then try again.');
    submit.disabled = false;
  }
}

byId('toggleLoginPassword').addEventListener('click', () => toggleSecret('loginPassword', 'toggleLoginPassword', 'password'));
byId('loginForm').addEventListener('submit', submitLogin);
const rememberedUsername = localStorage.getItem('gmsRememberedUsername') || '';
if (rememberedUsername) {
  byId('loginUsername').value = rememberedUsername;
  byId('rememberLogin').checked = true;
  byId('loginPassword').focus();
} else {
  byId('loginUsername').focus();
}
