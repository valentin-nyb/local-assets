// Videos, thumbnails and downloads through /api/media, which signs them for the signed-in account
// (Mux signed playback). Pages write Mux addresses as before and pass them through laMux():
//   laMux(url)                 an address the page can use in <img>, <video>, hls src or fetch
//   laMux(url, { dl: name })   a download (a 15-minute link, noted for the account)
//   laMux.player(el, pid)      a <mux-player> (or <mux-audio>) gets its tickets, then its playback ID
//   laMux.ready                resolves once this device has its media key (12 hours, renewed)
(function() {
    if (window.laMux) return;
    var KEY = 'la_mkey', key = '', exp = 0;
    // A shared link (player.html?s=…): no sign-in; the share id opens its one video
    var share = (new URLSearchParams(location.search).get('s') || '').replace(/[^A-Za-z0-9_-]/g, '');
    try { var c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && c.exp > Date.now() + 60e3) { key = c.key; exp = c.exp; } } catch (_) {}
    var token = function() { try { return JSON.parse(localStorage.getItem('la_admin') || '{}').webToken || ''; } catch (_) { return ''; } };
    var post = function(body) {
        var t = token();
        if (share) body.share = share; else if (!t) return Promise.reject(new Error('Not signed in'));
        var h = { 'Content-Type': 'application/json' }; if (t && !share) h.Authorization = 'Bearer ' + t;
        return fetch('/api/media', { method: 'POST', headers: h, body: JSON.stringify(body) })
            .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); });
    };
    var isMux = function(u) { return /^https:\/\/(stream|image)\.mux\.com\//.test(String(u || '')); };
    function laMux(url, o) {
        if (!isMux(url)) return url;
        return '/api/media?u=' + encodeURIComponent(url) + (o && o.dl ? '&dl=' + encodeURIComponent(o.dl) : '') + (share ? '&s=' + share : '&k=' + encodeURIComponent(key));
    }
    // Addresses written before the key arrived (k empty) get it once it's here
    function fix() {
        if (!key) return;
        document.querySelectorAll('[src*="/api/media?"],[href*="/api/media?"],[poster*="/api/media?"]').forEach(function(el) {
            ['src', 'href', 'poster'].forEach(function(a) { var v = el.getAttribute(a); if (v && /\/api\/media\?.*&k=$/.test(v)) el.setAttribute(a, v + encodeURIComponent(key)); });
        });
    }
    function renew() {
        return post({ action: 'key' }).then(function(d) {
            key = d.key; exp = d.exp;
            try { localStorage.setItem(KEY, JSON.stringify({ key: key, exp: exp })); } catch (_) {}
            fix();
        });
    }
    laMux.ready = share || (key && exp - Date.now() > 2 * 3600e3) ? Promise.resolve() : renew().catch(function() {});
    if (!share) setInterval(function() { if (exp - Date.now() < 2 * 3600e3) renew().catch(function() {}); }, 30 * 60e3);
    // A link to one video for anyone (days: until it ends, 7 unless given)
    laMux.share = function(pid, title, days) { return post({ action: 'share', pid: pid, title: title || '', days: days || 7 }); };
    laMux.shared = !!share;
    // Mux Player: tickets for its playback, poster and storyboard, then the playback ID (public videos: none needed)
    var _tickets = {};
    laMux.player = function(el, pid) {
        if (!el || !pid) return Promise.resolve();
        var set = function(t) {
            // A player moving to another video drops the last one's tickets
            ['playback-token', 'thumbnail-token', 'storyboard-token'].forEach(function(a) { el.removeAttribute(a); });
            if (t && t.playback) {
                el.setAttribute('playback-token', t.playback);
                if (t.thumbnail) el.setAttribute('thumbnail-token', t.thumbnail);
                if (t.storyboard) el.setAttribute('storyboard-token', t.storyboard);
            }
            el.setAttribute('playback-id', pid);
        };
        if (pid in _tickets && _tickets[pid].at > Date.now() - 3600e3) { set(_tickets[pid].t); return Promise.resolve(); }
        return post({ action: 'tickets', pids: [pid] }).then(function(d) {
            var t = d.tickets && d.tickets[pid];
            if (t && t.denied) return;
            _tickets[pid] = { t: t, at: Date.now() }; set(t);
        }).catch(function() { set(null); });
    };
    // Every <mux-player data-pid="…"> inside a part of the page (written as HTML)
    laMux.players = function(root) {
        (root || document).querySelectorAll('mux-player[data-pid]:not([playback-id])').forEach(function(el) { laMux.player(el, el.getAttribute('data-pid')); });
    };
    window.laMux = laMux;
    // Players written into the page later (lists, popups) get theirs as they appear
    var watch = function() {
        laMux.players(document);
        new MutationObserver(function(ms) {
            for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
                var nd = ms[i].addedNodes[j];
                if (nd.nodeType === 1 && (nd.matches('mux-player[data-pid]') || nd.querySelector('mux-player[data-pid]'))) { laMux.players(nd.parentNode || document); return; }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();
