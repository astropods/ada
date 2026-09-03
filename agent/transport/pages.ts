/**
 * Server-rendered HTML the app serves outside the SPA: the access-denied page
 * and the small confirmation pages the OAuth / App-manifest round-trips land
 * on. Extracted from the route handlers so app.ts stays a route map.
 */

/**
 * Themed 401 for a request the grants table denies — matches the app's dark
 * theme (see public/index.html) so a blocked user gets a coherent "no access"
 * page instead of the app shell or a bare error string.
 */
export function render401(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access denied · Ada</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#272b34; --fg:#e6e8ec; --muted:#8b93a1; --accent:#6ea8fe; --err:#ff6b6b; }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { display:flex; align-items:center; justify-content:center; padding:24px;
    font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    background:radial-gradient(1200px 600px at 50% -10%, #151b28 0%, var(--bg) 60%); color:var(--fg); }
  .card { width:min(460px,100%); background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:36px 32px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .badge { width:64px; height:64px; margin:0 auto 20px; border-radius:16px; display:flex; align-items:center; justify-content:center;
    background:rgba(255,107,107,.10); border:1px solid rgba(255,107,107,.35); color:var(--err); }
  .code { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--err); margin:0 0 10px; }
  h1 { font-size:20px; margin:0 0 10px; font-weight:600; letter-spacing:.01em; }
  p.msg { margin:0 auto; max-width:36ch; color:var(--muted); }
  .hint { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
  .hint b { color:var(--fg); font-weight:600; }
</style>
</head><body>
  <main class="card">
    <div class="badge">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
    </div>
    <p class="code">Access denied</p>
    <h1>You don't have access</h1>
    <p class="msg">Your account isn't authorized to use this agent. If you think this is a mistake, ask an administrator to grant you access.</p>
    <div class="hint">Access is controlled by the deployment's <b>grants</b>.</div>
  </main>
</body></html>`;
}

/** Minimal HTML confirmation page — the browser lands here after an OAuth or
 *  manifest round-trip, then the user returns to the app. */
export function renderPage(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${title}</h1><p>${body}</p></body></html>`
  );
}
