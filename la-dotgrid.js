// Dot grid that lights up around the pointer, as on the home, sign-in and download pages
(function () {
    var canvas = document.querySelector('.dot-grid-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d'), dots = [], mouse = { x: -1000, y: -1000 };
    var SPACING = 45, DOT_SIZE = 1.1, GLOW_RADIUS = 120, ACTIVE = '57, 255, 20';
    function init() {
        canvas.width = window.innerWidth; canvas.height = window.innerHeight; dots = [];
        for (var x = SPACING / 2; x < canvas.width; x += SPACING)
            for (var y = SPACING / 2; y < canvas.height; y += SPACING) dots.push({ x: x, y: y });
    }
    function draw() {
        var idle = '#141a11';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < dots.length; i++) {
            var d = dots[i], dx = mouse.x - d.x, dy = mouse.y - d.y, dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillStyle = dist < GLOW_RADIUS ? 'rgba(' + ACTIVE + ',' + (1 - dist / GLOW_RADIUS) + ')' : idle;
            ctx.beginPath(); ctx.arc(d.x, d.y, dist < GLOW_RADIUS ? DOT_SIZE + 0.5 : DOT_SIZE, 0, Math.PI * 2); ctx.fill();
        }
        requestAnimationFrame(draw);
    }
    window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('touchmove', function (e) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }, { passive: true });
    window.addEventListener('touchend', function () { mouse.x = -1000; mouse.y = -1000; });
    window.addEventListener('resize', init);
    init(); draw();
})();
