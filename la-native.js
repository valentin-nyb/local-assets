// a™ for iPhone and iPad (ios-app): what the website does differently inside the app.
// Nothing happens in a browser or in the Mac app; Capacitor adds window.Capacitor only inside the iOS app.
//  - Sign-in: Google doesn't allow it inside apps, so it opens in Safari (in the app) with the hash of a
//    one-time secret; Safari hands back a code through localassets://signed-in and the app swaps the code
//    and its secret for the session (api/google-auth POST), as the Mac app does.
//  - Push notifications: once signed in, the device asks once and its token goes to api/push-token.
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var P = C.Plugins || {};
  document.documentElement.classList.add('la-ios-app');

  var b64url = function (bytes) { var s = ''; bytes.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var session = function () { try { return JSON.parse(localStorage.getItem('la_admin') || 'null'); } catch (_) { return null; } };

  window.laApp = window.laApp || {};
  window.laApp.signIn = async function () {
    var verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    var challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    localStorage.setItem('la_app_verifier', verifier);
    if (P.Browser) P.Browser.open({ url: 'https://local-assets.com/api/google-auth?mode=web&app=' + challenge });
    else location.href = '/api/google-auth?mode=web';
  };

  if (P.App) P.App.addListener('appUrlOpen', async function (e) {
    var u; try { u = new URL(e.url); } catch (_) { return; }
    if (u.protocol !== 'localassets:' || u.hostname !== 'signed-in') return;
    if (P.Browser) P.Browser.close().catch(function () {});
    var verifier = localStorage.getItem('la_app_verifier');
    localStorage.removeItem('la_app_verifier');
    var fail = function (m) { if (window.laAlert) window.laAlert(m, { tone: 'error' }); else alert(m); };
    if (!verifier) return fail('Press Continue with Google in this app to sign in.');
    try {
      var r = await fetch('/api/google-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code') || '', verifier: verifier }) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.session) return fail(d.error || 'Sign-in failed. Try again.');
      var s = d.session;
      localStorage.setItem('la_admin', JSON.stringify(s));
      if (s.venue && s.venue !== 'Admin') localStorage.setItem('la_venue_name', String(s.venue).toUpperCase()); else localStorage.removeItem('la_venue_name');
      localStorage.removeItem('la_revenue_cache_v2');
      location.replace('/dashboard');
    } catch (_) { fail('Could not reach local / assets. Check your connection and try again.'); }
  });

  // Push notifications, once signed in: the token is sent again whenever it changes
  var push = P.PushNotifications, s = session();
  if (push && s && s.webToken) {
    push.addListener('registration', function (t) {
      if (!t || !t.value || localStorage.getItem('la_push_token') === t.value) return;
      fetch('/api/push-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.webToken }, body: JSON.stringify({ token: t.value, platform: 'ios' }) })
        .then(function (r) { if (r.ok) localStorage.setItem('la_push_token', t.value); }).catch(function () {});
    });
    // Tapping a notification opens the page it is about (a session, a clip)
    push.addListener('pushNotificationActionPerformed', function (a) {
      var url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url && /^\/[^/]/.test(url)) location.href = url;
    });
    push.checkPermissions().then(function (p) {
      if (p.receive === 'granted') return push.register();
      if (p.receive === 'prompt' || p.receive === 'prompt-with-rationale') return push.requestPermissions().then(function (q) { if (q.receive === 'granted') push.register(); });
    }).catch(function () {});
  }
})();
