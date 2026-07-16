'use strict';

document.querySelectorAll('[data-link-provider]').forEach((button) => {
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Connecting...';
    window.location.assign(`/api/auth/oauth/${button.dataset.linkProvider}`);
  });
});
