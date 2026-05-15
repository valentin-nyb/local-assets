(function () {
  const VERSION = 'V2.4.0';

  const CSS = `
    #la-footer { font-family:'JetBrains Mono',ui-monospace,monospace; }
    #la-footer a { text-decoration:none; transition:color .15s; }
    #la-footer a:hover { color:#39FF14; }
    #la-footer .la-footer-dot {
      width:6px; height:6px; border-radius:50%; background:#39FF14;
      display:inline-block; flex-shrink:0;
      box-shadow:0 0 8px #39FF14;
      animation:la-pulse 2s cubic-bezier(.4,0,.6,1) infinite;
    }
    @keyframes la-pulse {
      0%,100% { opacity:1; }
      50%      { opacity:.3; }
    }
  `;

  const HTML = `
    <!-- Main footer -->
    <footer id="la-footer" style="background:#050505;border-top:1px solid rgba(255,255,255,.06);padding:48px 32px 0;">
      <div style="max-width:1152px;margin:0 auto;">

        <!-- Three-column grid -->
        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:24px;align-items:start;margin-bottom:40px;">

          <!-- LEFT: brand -->
          <div>
            <a href="/" style="font-size:13px;font-weight:700;color:#ffffff;letter-spacing:.04em;display:block;margin-bottom:6px;">
              local / assets™
            </a>
            <p style="font-size:8px;color:#3f3f46;text-transform:uppercase;letter-spacing:.22em;line-height:1.4;margin:0;">
              Live Event Monetization<br>Platform
            </p>
          </div>

          <!-- CENTER: nav -->
          <nav style="display:flex;flex-wrap:wrap;gap:6px 20px;justify-content:center;padding-top:2px;">
            <a href="/"              style="font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.18em;">Home</a>
            <a href="/dashboard"     style="font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.18em;">Dashboard</a>
            <a href="/privacy"       style="font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.18em;">Privacy Policy</a>
            <a href="/terms"         style="font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.18em;">Terms of Service</a>
            <a href="mailto:info@local-assets.com" style="font-size:8px;color:#52525b;text-transform:uppercase;letter-spacing:.18em;">Contact</a>
          </nav>

          <!-- RIGHT: version tag -->
          <div style="text-align:right;padding-top:2px;">
            <span style="font-size:8px;color:#27272a;text-transform:uppercase;letter-spacing:.18em;line-height:1.6;">
              Local / Assets ${VERSION}<br>
              <span style="color:#39FF14;opacity:.6;">// Connected</span>
            </span>
          </div>

        </div>

        <!-- Divider -->
        <div style="border-top:1px solid rgba(255,255,255,.04);margin:0 0 0;"></div>

        <!-- Bottom bar -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 12px;">
          <span style="font-size:8px;color:#27272a;text-transform:uppercase;letter-spacing:.2em;">
            © 2026 Local Assets · All Rights Reserved
          </span>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="la-footer-dot"></span>
            <span style="font-size:8px;color:#3f3f46;text-transform:uppercase;letter-spacing:.2em;">System Operational</span>
          </div>
        </div>

      </div>
    </footer>

    <!-- Mobile responsive overrides -->
    <style>
      @media (max-width: 640px) {
        #la-footer > div > div:first-child {
          grid-template-columns: 1fr !important;
          text-align: center;
        }
        #la-footer > div > div:first-child > div:last-child {
          text-align: center !important;
        }
        #la-footer nav {
          justify-content: center !important;
        }
      }
    </style>
  `;

  function inject() {
    // Inject CSS once
    if (!document.getElementById('la-footer-css')) {
      const style = document.createElement('style');
      style.id = 'la-footer-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // Replace placeholder if present, otherwise append before </body>
    const placeholder = document.getElementById('la-footer-placeholder');
    if (placeholder) {
      placeholder.outerHTML = HTML;
    } else {
      // Remove any existing static footer with id la-footer to avoid duplicates
      const existing = document.getElementById('la-footer');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', HTML);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
