(function () {
  const VERSION = 'V2.4.0';
  const YEAR = new Date().getFullYear();

  // Same look as the app: Helvetica Neue text, JetBrains Mono labels, pill buttons, the logo with the
  // green sweep on hover (as in the side menu)
  const CSS = `
    #la-footer { background:#050505; border-top:1px solid rgba(255,255,255,.08); padding:56px 32px 0; color:#fafafa;
      font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; }
    #la-footer .lf-wrap { max-width:1152px; margin:0 auto; }
    #la-footer .lf-top { display:grid; grid-template-columns:minmax(0, 1.4fr) repeat(3, minmax(0, 1fr)); gap:40px; padding-bottom:48px; }
    #la-footer .lf-logo { display:block; width:168px; height:28px; }
    #la-footer .lf-logo span { display:block; width:100%; height:100%;
      -webkit-mask:url(/logos/White@2x.png) left center / contain no-repeat; mask:url(/logos/White@2x.png) left center / contain no-repeat;
      background:linear-gradient(90deg, #39FF14 0 50%, #fafafa 50% 100%); background-size:200% 100%; background-position:100% 0;
      transition:background-position .45s cubic-bezier(.65,0,.35,1); }
    #la-footer .lf-logo:hover span, #la-footer .lf-logo:focus-visible span { background-position:0 0; }
    #la-footer .lf-tag { margin:16px 0 0; max-width:300px; font-size:14px; line-height:1.55; color:#a1a1aa; }
    #la-footer .lf-btn { display:inline-flex; align-items:center; justify-content:center; height:40px; padding:0 18px; margin-top:22px;
      border-radius:999px; border:1px solid rgba(250,250,250,.3); color:#fafafa; font-size:14px; font-weight:500; text-decoration:none;
      transition:background .25s, color .25s, border-color .25s; }
    #la-footer .lf-btn:hover { background:#39FF14; border-color:#39FF14; color:#000; }
    #la-footer .lf-h { margin:4px 0 16px; font:500 10px/1.3 'JetBrains Mono', ui-monospace, monospace; letter-spacing:.2em; text-transform:uppercase; color:#71717a; }
    #la-footer .lf-col a { display:block; width:max-content; max-width:100%; padding:5px 0; font-size:14px; color:#d4d4d8; text-decoration:none; transition:color .15s; }
    #la-footer .lf-col a:hover { color:#39FF14; }
    #la-footer .lf-bottom { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:18px 0 22px;
      border-top:1px solid rgba(255,255,255,.06); font:500 10px/1.4 'JetBrains Mono', ui-monospace, monospace; letter-spacing:.18em; text-transform:uppercase; color:#52525b; }
    #la-footer .lf-status { display:inline-flex; align-items:center; gap:10px; }
    #la-footer .lf-dot { width:6px; height:6px; border-radius:50%; background:#39FF14; box-shadow:0 0 8px #39FF14; animation:lf-pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
    #la-footer .lf-status b { font-weight:500; color:#39FF14; }
    @keyframes lf-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
    @media (prefers-reduced-motion: reduce) { #la-footer .lf-logo span { transition:none; } #la-footer .lf-dot { animation:none; } }
    @media (max-width: 900px) { #la-footer .lf-top { grid-template-columns:repeat(3, minmax(0, 1fr)); } #la-footer .lf-brand { grid-column:1 / -1; } }
    @media (max-width: 560px) { #la-footer { padding:44px 16px 0; } #la-footer .lf-top { grid-template-columns:1fr 1fr; gap:32px 20px; } }
  `;

  const HTML = `
    <footer id="la-footer">
      <div class="lf-wrap">
        <div class="lf-top">
          <div class="lf-brand">
            <a href="/" class="lf-logo" aria-label="local / assets home"><span role="img" aria-label="local / assets"></span></a>
            <p class="lf-tag">Every set recorded, branded and ready to share: the full set in 4K, HQ audio, vertical clips and thumbnails.</p>
            <a href="mailto:info@local-assets.com" class="lf-btn">Talk to us</a>
          </div>
          <nav class="lf-col" aria-label="Product">
            <p class="lf-h">Product</p>
            <a href="/">Home</a>
            <a href="/login">Log in</a>
            <a href="/dashboard">Dashboard</a>
          </nav>
          <nav class="lf-col" aria-label="Legal">
            <p class="lf-h">Legal</p>
            <a href="/privacy">Privacy policy</a>
            <a href="/terms">Terms of service</a>
          </nav>
          <div class="lf-col">
            <p class="lf-h">Contact</p>
            <a href="mailto:info@local-assets.com">info@local-assets.com</a>
          </div>
        </div>
        <div class="lf-bottom">
          <span>© ${YEAR} local / assets · All rights reserved</span>
          <span class="lf-status"><span class="lf-dot" aria-hidden="true"></span>Local / Assets ${VERSION} <b>// Connected</b></span>
        </div>
      </div>
    </footer>
  `;

  function inject() {
    if (!document.getElementById('la-footer-css')) {
      const style = document.createElement('style');
      style.id = 'la-footer-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const placeholder = document.getElementById('la-footer-placeholder');
    if (placeholder) {
      placeholder.outerHTML = HTML;
    } else {
      const existing = document.getElementById('la-footer');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', HTML);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
