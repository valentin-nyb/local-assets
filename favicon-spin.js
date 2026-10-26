// The tab icon spins the a twice when a page opens, then rests on the still a.
// Chrome, Edge and Firefox show it; Safari keeps the still icon. Nothing moves for reduced motion.
(function () {
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var FRAMES = 25, SIZE = 64, MS = 60, LOOPS = 2;
    var sheet = new Image();
    sheet.onload = function () {
      var c = document.createElement('canvas'); c.width = c.height = SIZE;
      var x = c.getContext('2d');
      var links = Array.prototype.slice.call(document.querySelectorAll('link[rel~="icon"]'));
      var keep = links.map(function (l) { return l.getAttribute('href'); });
      var spin = document.createElement('link'); spin.rel = 'icon'; spin.type = 'image/png';
      links.forEach(function (l) { l.parentNode.removeChild(l); });
      document.head.appendChild(spin);
      var n = 0;
      var t = setInterval(function () {
        if (n >= FRAMES * LOOPS) {
          clearInterval(t); spin.parentNode && spin.parentNode.removeChild(spin);
          links.forEach(function (l, i) { l.setAttribute('href', keep[i]); document.head.appendChild(l); });
          return;
        }
        x.clearRect(0, 0, SIZE, SIZE);
        x.drawImage(sheet, (n % FRAMES) * SIZE, 0, SIZE, SIZE, 0, 0, SIZE, SIZE);
        spin.href = c.toDataURL('image/png');
        n++;
      }, MS);
    };
    sheet.src = '/favicon/spin-frames.png';
  } catch (_) {}
})();
