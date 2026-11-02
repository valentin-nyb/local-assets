// Sends this page's errors to local / assets™ (/api/client-error → Rollbar), so a broken page is seen
// without waiting for someone to say so. At most 5 a page, each error once; nothing else about the visitor.
(function () {
  if (window.laErrors) return;
  window.laErrors = true;
  var sent = {}, count = 0;
  function send(err, fallback) {
    try {
      var message = (err && err.message) || String(fallback || err || '');
      // "Script error." is a script from another site that the browser won't describe: nothing to go on
      if (!message || message === 'Script error.' || sent[message] || ++count > 5) return;
      sent[message] = 1;
      var data = JSON.stringify({ name: (err && err.name) || 'Error', message: message, stack: (err && err.stack) || '',
        page: location.origin + location.pathname });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error', new Blob([data], { type: 'application/json' }));
      else fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true });
    } catch (e) {}
  }
  window.addEventListener('error', function (e) { if (e.message || e.error) send(e.error, e.message); });
  window.addEventListener('unhandledrejection', function (e) { send(e.reason instanceof Error ? e.reason : null, e.reason); });
})();
