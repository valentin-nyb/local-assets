document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    // Handles both /dashboard.html and extensionless /dashboard (Vercel/Netlify)
    const currentPath = window.location.pathname.split("/").pop() || "dashboard.html";

    // Strip .html before comparing so both URL styles match
    const isActive = (path) => {
        const baseName = path.replace('.html', '');
        return currentPath.includes(baseName) ? "active" : "text-zinc-400";
    };

    const isDark = document.documentElement.classList.contains('dark');

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
        <div class="px-4 pb-4 pt-2 border-t border-[#27272a]">
            <button id="theme-toggle" onclick="toggleTheme()" class="w-full flex items-center gap-3 px-3 py-2 rounded-md text-zinc-400 hover:text-white transition-colors" style="font-family:'JetBrains Mono',monospace;font-size:12px;">
                <iconify-icon icon="${isDark ? 'solar:sun-linear' : 'solar:moon-linear'}" class="text-lg" id="theme-icon"></iconify-icon>${isDark ? 'Light Mode' : 'Dark Mode'}
            </button>
        </div>
    `;
});

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.classList.contains('dark');

    if (isDark) {
        html.classList.remove('dark');
        localStorage.setItem('la_theme', 'light');
    } else {
        html.classList.add('dark');
        localStorage.setItem('la_theme', 'dark');
    }

    // Update toggle button
    const icon = document.getElementById('theme-icon');
    const btn = document.getElementById('theme-toggle');
    if (icon && btn) {
        const nowDark = html.classList.contains('dark');
        icon.setAttribute('icon', nowDark ? 'solar:sun-linear' : 'solar:moon-linear');
        btn.lastChild.textContent = nowDark ? 'Light Mode' : 'Dark Mode';
    }
}