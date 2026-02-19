document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    // Get the current filename (e.g., "dashboard.html")
    const currentPage = window.location.pathname.split("/").pop() || "index.html";

    // Helper to check if the link should be active
    const isActive = (path) => currentPage === path ? "active" : "text-zinc-400";

    sidebar.innerHTML = `
        <div class="h-16 flex items-center px-6 border-b border-[#27272a] justify-between">
            <a href="index.html" class="h-6 w-32 flex">
                <img src="https://res.cloudinary.com/dso3xwno0/image/upload/v1770974377/eayfotlcvgq36kpwvitw.svg" class="h-full w-full object-left object-contain" alt="logo">
            </a>
        </div>
        <nav class="flex-1 p-4 space-y-2">
            <a href="dashboard.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('dashboard.html')}">
                <iconify-icon icon="solar:widget-5-linear" class="text-lg"></iconify-icon>Overview
            </a>
            <a href="camera.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('camera.html')}">
                <iconify-icon icon="solar:videocamera-record-linear" class="text-lg"></iconify-icon>Camera Control
            </a>
            <a href="assets.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('assets.html')}">
                <iconify-icon icon="solar:clapperboard-play-linear" class="text-lg"></iconify-icon>Media Assets
            </a>
            <a href="archive.html" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('archive.html')}">
                <iconify-icon icon="solar:archive-linear" class="text-lg"></iconify-icon>Archive
            </a>
        </nav>
    `;
});