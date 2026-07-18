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

const phoneButton = document.getElementById('phoneLoginButton');
const phoneForm = document.getElementById('phoneLoginForm');
if (phoneButton && phoneForm) {
  const phoneModal = document.getElementById('phoneLoginModal');
  const phoneMessage = document.getElementById('phoneModalMessage');
  let confirmationResult;
  let recaptchaVerifier;
  const showPhoneMessage = (text, type = 'error') => { phoneMessage.textContent = text; phoneMessage.dataset.type = type; };
  const closePhoneModal = () => {
    if (phoneModal.hidden || phoneModal.classList.contains('is-closing')) return;
    phoneModal.classList.add('is-closing');
    setTimeout(() => { phoneModal.hidden = true; phoneModal.classList.remove('is-closing'); document.body.classList.remove('phone-modal-open'); phoneButton.focus(); }, 180);
  };
  const phoneAuthErrorMessage = (error) => {
    const code = String(error?.code || '');
    if (code === 'auth/internal-error') {
      return ['localhost', '127.0.0.1'].includes(location.hostname)
        ? 'Firebase cannot send real phone verification SMS from localhost. Use a Firebase test phone number or open the app through an authorized HTTPS domain.'
        : 'Firebase rejected the SMS request. Enable Phone sign-in, allow the Philippines in SMS region policy, and link a billing account in Firebase Console.';
    }
    if (code === 'auth/operation-not-allowed') return 'Phone sign-in is disabled in Firebase Console.';
    if (code === 'auth/unauthorized-domain') return `${location.hostname} is not listed in Firebase Authentication authorized domains.`;
    if (code === 'auth/billing-not-enabled') return 'Firebase Phone Authentication requires a linked Cloud Billing account.';
    if (code === 'auth/invalid-phone-number') return 'Enter a valid phone number in international format, for example +639171234567.';
    if (code === 'auth/too-many-requests' || code === 'auth/quota-exceeded') return 'Firebase temporarily blocked SMS requests or the SMS quota was reached. Try again later.';
    if (code === 'auth/code-expired') return 'The verification code expired. Request a new code.';
    if (code === 'auth/invalid-verification-code') return 'The verification code is incorrect.';
    return error?.message || 'Phone authentication failed.';
  };

  async function firebasePhoneAuth() {
    const [{ initializeApp, getApp, getApps }, { getAuth, RecaptchaVerifier, signInWithPhoneNumber }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js')
    ]);
    const response = await fetch('/api/auth/firebase-config');
    const config = await response.json();
    if (!response.ok) throw new Error(config.message || 'Phone login is not configured.');
    const auth = getAuth(getApps().length ? getApp() : initializeApp(config));
    if (!recaptchaVerifier) recaptchaVerifier = new RecaptchaVerifier(auth, 'phoneRecaptcha', { size: 'invisible' });
    return { auth, signInWithPhoneNumber };
  }

  phoneButton.addEventListener('click', () => {
    phoneModal.classList.remove('is-closing');
    phoneModal.hidden = false;
    document.body.classList.add('phone-modal-open');
    document.getElementById('firebasePhone').focus();
    showPhoneMessage('Enter the number in international format.', 'working');
  });

  phoneModal.querySelectorAll('[data-close-phone-modal]').forEach((button) => button.addEventListener('click', closePhoneModal));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !phoneModal.hidden) closePhoneModal(); });

  document.getElementById('sendPhoneCode').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const phone = document.getElementById('firebasePhone').value.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone.replace(/[ ()-]/g, ''))) return showPhoneMessage('Use international format, for example +639171234567.');
    button.disabled = true; button.textContent = 'Sending...';
    try {
      const { auth, signInWithPhoneNumber } = await firebasePhoneAuth();
      confirmationResult = await signInWithPhoneNumber(auth, phone.replace(/[ ()-]/g, ''), recaptchaVerifier);
      document.getElementById('phoneCodeStep').hidden = false;
      document.getElementById('verifyPhoneCode').hidden = false;
      document.getElementById('firebasePhoneCode').focus();
      showPhoneMessage('Verification code sent. Enter the 6-digit code.', 'success');
      button.textContent = 'Resend code';
    } catch (error) {
      recaptchaVerifier?.clear(); recaptchaVerifier = null;
      showPhoneMessage(phoneAuthErrorMessage(error));
      button.textContent = 'Send code';
    } finally { button.disabled = false; }
  });

  phoneForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('verifyPhoneCode');
    const code = document.getElementById('firebasePhoneCode').value.trim();
    if (!confirmationResult || !/^\d{6}$/.test(code)) return showPhoneMessage('Enter the complete 6-digit verification code.');
    button.disabled = true; button.textContent = 'Verifying...';
    try {
      const credential = await confirmationResult.confirm(code);
      const idToken = await credential.user.getIdToken();
      const response = await fetch('/api/auth/firebase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, provider: 'phone', mode: 'login' }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Phone sign-in failed.');
      showPhoneMessage('Phone verified. Opening your workspace...', 'success');
      location.replace(result.redirectTo || '/dashboard');
    } catch (error) {
      showPhoneMessage(phoneAuthErrorMessage(error));
      button.disabled = false; button.textContent = 'Verify and sign in';
    }
  });
}

const resetModal = document.getElementById('passwordResetModal');
const resetForm = document.getElementById('passwordResetForm');
if (resetModal && resetForm) {
  const resetMessage = document.getElementById('resetModalMessage');
  let resetConfirmation;
  let resetRecaptchaVerifier;
  let resetIdToken = '';
  let socialResetToken = new URLSearchParams(location.search).get('resetToken') || '';
  const socialProvider = new URLSearchParams(location.search).get('resetProvider') || '';
  const resetStatus = (text, type = 'error') => { resetMessage.textContent = text; resetMessage.dataset.type = type; };
  const openReset = () => { resetModal.classList.remove('is-closing'); resetModal.hidden = false; document.body.classList.add('phone-modal-open'); };
  const closeReset = () => {
    if (resetModal.hidden || resetModal.classList.contains('is-closing')) return;
    resetModal.classList.add('is-closing');
    setTimeout(() => { resetModal.hidden = true; resetModal.classList.remove('is-closing'); document.body.classList.remove('phone-modal-open'); document.getElementById('forgotPasswordBtn').focus(); }, 180);
  };
  const showNewPasswordStep = () => {
    document.getElementById('resetProviderChoices').hidden = true;
    document.getElementById('resetPhoneStep').hidden = true;
    document.getElementById('resetCodeStep').hidden = true;
    document.getElementById('sendResetCode').hidden = true;
    document.getElementById('verifyResetCode').hidden = true;
    document.getElementById('resetPasswordStep').hidden = false;
    document.getElementById('saveNewPassword').hidden = false;
    document.getElementById('resetNewPassword').focus();
  };

  document.getElementById('forgotPasswordBtn').addEventListener('click', openReset);
  resetModal.querySelectorAll('[data-close-reset-modal]').forEach((button) => button.addEventListener('click', closeReset));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !resetModal.hidden) closeReset(); });
  document.querySelectorAll('[data-toggle-reset-password]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.toggleResetPassword); const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; button.classList.toggle('is-visible', show); button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} password`);
  }));

  document.querySelectorAll('[data-reset-provider]').forEach((button) => button.addEventListener('click', () => {
    const provider = button.dataset.resetProvider;
    if (provider === 'phone') {
      document.getElementById('resetPhoneStep').hidden = false;
      document.getElementById('resetPhone').focus();
      resetStatus('Enter the phone number bound to your account.', 'working');
    } else location.assign(`/api/auth/oauth/${provider}?mode=reset`);
  }));

  document.getElementById('sendResetCode').addEventListener('click', async (event) => {
    const phone = document.getElementById('resetPhone').value.trim().replace(/[ ()-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return resetStatus('Use international format, for example +639171234567.');
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Sending...';
    try {
      const [{ initializeApp, getApp, getApps }, { getAuth, RecaptchaVerifier, signInWithPhoneNumber }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js'), import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js')
      ]);
      const configResponse = await fetch('/api/auth/firebase-config'); const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(config.message || 'Phone verification is not configured.');
      const auth = getAuth(getApps().length ? getApp() : initializeApp(config));
      if (!resetRecaptchaVerifier) resetRecaptchaVerifier = new RecaptchaVerifier(auth, 'resetRecaptcha', { size: 'invisible' });
      resetConfirmation = await signInWithPhoneNumber(auth, phone, resetRecaptchaVerifier);
      document.getElementById('resetCodeStep').hidden = false; document.getElementById('verifyResetCode').hidden = false;
      resetStatus('Verification code sent.', 'success'); document.getElementById('resetCode').focus(); button.textContent = 'Resend code';
    } catch (error) {
      resetRecaptchaVerifier?.clear(); resetRecaptchaVerifier = null;
      resetStatus(error?.code === 'auth/internal-error' && ['localhost', '127.0.0.1'].includes(location.hostname) ? 'Use a Firebase test phone number locally, or use an authorized HTTPS domain for real SMS.' : error.message || 'Could not send the code.');
      button.textContent = 'Send verification code';
    } finally { button.disabled = false; }
  });

  document.getElementById('verifyResetCode').addEventListener('click', async (event) => {
    const code = document.getElementById('resetCode').value.trim();
    if (!resetConfirmation || !/^\d{6}$/.test(code)) return resetStatus('Enter the complete 6-digit code.');
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Verifying...';
    try { const credential = await resetConfirmation.confirm(code); resetIdToken = await credential.user.getIdToken(); resetStatus('Phone verified. Create your new password.', 'success'); showNewPasswordStep(); }
    catch (error) { resetStatus(error.message || 'The verification code is invalid or expired.'); button.disabled = false; button.textContent = 'Verify code'; }
  });

  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault(); const password = document.getElementById('resetNewPassword').value; const confirmPassword = document.getElementById('resetConfirmPassword').value;
    if (password.length < 8) return resetStatus('Password must contain at least 8 characters.');
    if (password !== confirmPassword) return resetStatus('The password confirmation does not match.');
    const button = document.getElementById('saveNewPassword'); button.disabled = true; button.textContent = 'Changing...';
    try {
      const response = await fetch('/api/auth/password-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: resetIdToken, resetToken: socialResetToken, newPassword: password }) });
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.message || 'Password reset failed.');
      resetStatus(result.message, 'success'); socialResetToken = ''; setTimeout(() => { closeReset(); document.getElementById('loginPassword').focus(); }, 900);
    } catch (error) { resetStatus(error.message); button.disabled = false; button.textContent = 'Change password'; }
  });

  if (socialResetToken) {
    openReset(); showNewPasswordStep(); resetStatus(`${socialProvider[0]?.toUpperCase() + socialProvider.slice(1)} verified. Create your new password.`, 'success');
    history.replaceState({}, '', '/');
  }
}
