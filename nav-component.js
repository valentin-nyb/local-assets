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
    `;
});