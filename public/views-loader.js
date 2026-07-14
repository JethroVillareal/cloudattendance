const viewFiles = [
  'dashboard',
  'timecard',
  'enrollment',
  'employees',
  'devices',
  'settings',
  'logs'
];

async function loadViews() {
  const container = document.getElementById('viewContainer');

  try {
    const responses = await Promise.all(
      viewFiles.map((name) => fetch(`/views/${name}.html`))
    );

    const failedResponse = responses.find((response) => !response.ok);
    if (failedResponse) {
      throw new Error(`Unable to load ${failedResponse.url} (${failedResponse.status})`);
    }

    const views = await Promise.all(responses.map((response) => response.text()));
    container.innerHTML = views.join('\n');

    const appScript = document.createElement('script');
    appScript.src = '/app.js?v=20260715-login3';
    document.body.appendChild(appScript);
  } catch (error) {
    console.error(error);
    container.innerHTML = `
      <section class="panel danger-zone">
        <h2>Page loading failed</h2>
        <p>${String(error.message || error)}</p>
        <button type="button" onclick="window.location.reload()">Retry</button>
      </section>
    `;
  }
}

loadViews();
