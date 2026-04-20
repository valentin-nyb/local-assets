document.addEventListener("DOMContentLoaded", () => {
    // Inject theme switcher CSS if not already present
    if (!document.getElementById('la-theme-switcher-css')) {
        var style = document.createElement('style');
        style.id = 'la-theme-switcher-css';
        style.textContent = `
            .la-theme-switcher{display:inline-flex;background:#111;border:1px solid #27272a;border-radius:9999px;padding:3px;gap:2px}
            .la-theme-switcher button{all:unset;display:inline-flex;align-items:center;gap:0;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:9999px;cursor:pointer;color:rgba(255,255,255,.2);transition:color .3s ease-in-out,background-color .3s ease-in-out;white-space:nowrap;-webkit-user-select:none;user-select:none}
            .la-theme-switcher button:hover{color:rgba(255,255,255,.45)}
            .la-theme-switcher button[aria-checked="true"]{background:rgba(255,255,255,.08);color:#fff}
            .la-theme-switcher button .la-theme-icon{font-size:12px;display:inline-flex;max-width:0;opacity:0;overflow:hidden;transition:max-width .3s ease-in-out,opacity .3s ease-in-out,margin .3s ease-in-out;margin-right:0}
            .la-theme-switcher button[aria-checked="true"] .la-theme-icon{max-width:18px;opacity:1;margin-right:5px}
            html:not(.dark) .la-theme-switcher{background:#e4e4e7;border-color:#d4d4d8}
            html:not(.dark) .la-theme-switcher button{color:rgba(0,0,0,.3)}
            html:not(.dark) .la-theme-switcher button:hover{color:rgba(0,0,0,.55)}
            html:not(.dark) .la-theme-switcher button[aria-checked="true"]{background:rgba(0,0,0,.07);color:#18181b}
        `;
        document.head.appendChild(style);
    }

    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const currentPath = window.location.pathname.split("/").pop() || "dashboard.html";
    const isActive = (path) => {
        const baseName = path.replace('.html', '');
        return currentPath.includes(baseName) ? "active" : "text-zinc-400";
    };

    const saved = localStorage.getItem('la_theme') || 'dark';

    sidebar.innerHTML = `
        <div class="h-16 flex items-center px-6 border-b border-[#27272a] justify-between shrink-0">
            <a href="index.html" class="h-6 w-32 flex">
                <img src="logos/White@2x.png" class="h-full w-full object-left object-contain" alt="logo">
            </a>
            <button onclick="toggleSidebar()" class="md:hidden text-zinc-400 hover:text-white transition-colors">
                <iconify-icon icon="solar:close-circle-linear" class="text-2xl"></iconify-icon>
            </button>
        </div>
        <nav class="flex-1 p-4 space-y-2 overflow-y-auto">
            <a href="dashboard.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('dashboard.html')}">
                <iconify-icon icon="solar:widget-5-linear" class="text-lg"></iconify-icon>Overview
            </a>
            <a href="camera.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('camera.html')}">
                <iconify-icon icon="solar:videocamera-record-linear" class="text-lg"></iconify-icon>Camera Control
            </a>
            <a href="assets.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('assets.html')}">
                <iconify-icon icon="solar:cloud-upload-linear" class="text-lg"></iconify-icon>Upload Asset
            </a>
        </nav>
        <div class="px-4 pb-4 pt-2 border-t border-[#27272a] flex justify-center">
            <div class="la-theme-switcher" role="radiogroup" aria-label="Theme">
                <button type="button" role="radio" aria-checked="${saved === 'light' ? 'true' : 'false'}" data-theme="light">
                    <iconify-icon icon="solar:sun-linear" class="la-theme-icon"></iconify-icon>
                    <span>Light</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'dark' || !['light','dark','auto'].includes(saved) ? 'true' : 'false'}" data-theme="dark">
                    <iconify-icon icon="solar:moon-linear" class="la-theme-icon"></iconify-icon>
                    <span>Dark</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'auto' ? 'true' : 'false'}" data-theme="auto">
                    <iconify-icon icon="solar:monitor-linear" class="la-theme-icon"></iconify-icon>
                    <span>Auto</span>
                </button>
            </div>
        </div>
    `;

    // Initialize theme engine (event delegation — works for sidebar + any other switcher)
    if (!window._laThemeInit) {
        window._laThemeInit = true;

        function resolve(mode) {
            return mode === 'auto'
                ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
                : mode;
        }

        function apply(mode) {
            var resolved = resolve(mode);
            if (resolved === 'dark') document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');
            localStorage.setItem('la_theme', mode);
            document.querySelectorAll('.la-theme-switcher button[data-theme]').forEach(function(b) {
                b.setAttribute('aria-checked', b.getAttribute('data-theme') === mode ? 'true' : 'false');
            });
        }

        document.addEventListener('click', function(e) {
            var btn = e.target.closest('.la-theme-switcher button[data-theme]');
            if (btn) apply(btn.getAttribute('data-theme'));
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
            if (localStorage.getItem('la_theme') === 'auto') apply('auto');
        });

        window._laApplyTheme = apply;
    }
});