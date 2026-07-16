const isEmployeePortal = document.body.dataset.workspace === 'employee';

function showMessage(text, type = 'error') {
  const box = document.getElementById(isEmployeePortal ? 'portalMessage' : 'loginMessage') || document.getElementById('message') || document.getElementById('toastMessage');
  if (!box) return;
  box.textContent = text; box.dataset.type = type;
  if (box.id === 'toastMessage') box.closest('#toast')?.classList.add('show');
  box.classList.toggle('show', Boolean(text));
  if (!isEmployeePortal) box.className = `login-message ${type === 'error' ? '' : type}`.trim();
}

document.querySelectorAll('[data-social-provider], [data-link-provider]').forEach((button) => {
  const provider = String(button.dataset.socialProvider || button.dataset.linkProvider || '').toLowerCase();
  button.addEventListener('click', () => {
    if (!['google', 'facebook'].includes(provider)) return;
    button.disabled = true;
    button.textContent = 'Connecting...';
    showMessage(`Opening ${provider[0].toUpperCase() + provider.slice(1)}...`, 'working');
    location.assign(`/api/auth/oauth/${provider}`);
  });
});

const result = new URLSearchParams(location.search);
const message = result.get('authError') || result.get('authSuccess');
if (message) {
  showMessage(message, result.has('authError') ? 'error' : 'success');
  history.replaceState({}, '', `${location.pathname}${location.hash}`);
}
