// Decks recorded on this device (an iPad, an iPhone, any browser): the mixer plugged in (its USB, or an
// audio interface) is recorded here, uncompressed, and each set goes up as that session's HQ audio when it
// ends. A browser can't send a live stream to Cloud Storage itself, so the sound is kept on the device while
// it records (in its storage, a few seconds at a time, so a reload or a crash loses nothing) and uploaded after.
// With the venue calendar it records every set like the cameras (2 minutes before to 2 minutes after);
// without one, Record and Stop. window.laDeckRec.open(slot) opens the panel from a Decks audio card.
(function() {
    if (window.laDeckRec) return;
    var DB = 'la-deckrec', STORE = 'chunks', META = 'sets';
    // A set's sound starts and stops at the set's exact times, like the cameras' kept recording, so picture and
    // sound begin together (the cameras open 2 minutes early, but what's kept starts at the set)
    var PAD = 0;
    var st = { lastCmd: 0, levelDb: null, stream: null, ctx: null, node: null, analyser: null, deviceId: '', label: '', rate: 48000,
        seg: null, follow: false, timer: null, wake: null, uploading: false, cal: null, slot: null, manualArtist: '' };

    // ── Storage on the device (IndexedDB): pieces of sound, and the sets waiting to go up ──
    var dbp = null;
    function db() {
        if (dbp) return dbp;
        dbp = new Promise(function(ok, bad) {
            var r = indexedDB.open(DB, 1);
            r.onupgradeneeded = function() { var d = r.result; d.createObjectStore(STORE, { autoIncrement: true }).createIndex('set', 'set'); d.createObjectStore(META, { keyPath: 'id' }); };
            r.onsuccess = function() { ok(r.result); }; r.onerror = function() { bad(r.error); };
        });
        return dbp;
    }
    function tx(store, mode, fn) {
        return db().then(function(d) { return new Promise(function(ok, bad) {
            var t = d.transaction(store, mode), out = fn(t.objectStore(store));
            t.oncomplete = function() { ok(out && out.result !== undefined ? out.result : out); }; t.onerror = function() { bad(t.error); };
        }); });
    }
    var putSet = function(s) { return tx(META, 'readwrite', function(o) { o.put(s); }); };
    var allSets = function() { return tx(META, 'readonly', function(o) { return o.getAll(); }); };
    function chunksOf(id) { return tx(STORE, 'readonly', function(o) { return o.index('set').getAll(id); }); }
    function dropSet(id) {
        return tx(STORE, 'readwrite', function(o) { var r = o.index('set').openCursor(IDBKeyRange.only(id)); r.onsuccess = function() { var c = r.result; if (c) { c.delete(); c.continue(); } }; })
            .then(function() { return tx(META, 'readwrite', function(o) { o.delete(id); }); });
    }

    // ── Sound in ──
    var londonDay = function(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ms)); };
    var clock = function(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }); };
    function inputs() {
        // Device names are only listed once sound may be used
        return navigator.mediaDevices.getUserMedia({ audio: true }).then(function(s) { s.getTracks().forEach(function(t) { t.stop(); }); })
            .then(function() { return navigator.mediaDevices.enumerateDevices(); })
            .then(function(l) { return l.filter(function(d) { return d.kind === 'audioinput'; }); });
    }
    // The device's own microphone is never the decks: something plugged in is chosen first
    var builtIn = /built-in|iphone|ipad|macbook|default|internal/i;
    function openInput(deviceId) {
        closeInput();
        return navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } } })
        .then(function(stream) {
            st.stream = stream; st.deviceId = deviceId;
            var tr = stream.getAudioTracks()[0]; st.label = tr ? tr.label : '';
            var AC = window.AudioContext || window.webkitAudioContext;
            var ctx = st.ctx = new AC({ sampleRate: 48000, latencyHint: 'playback' });
            st.rate = ctx.sampleRate;
            var src = ctx.createMediaStreamSource(stream);
            // The level: the analyser goes on to a silent output, or the browser never feeds it
            var mute = ctx.createGain(); mute.gain.value = 0; mute.connect(ctx.destination);
            st.analyser = ctx.createAnalyser(); st.analyser.fftSize = 2048; src.connect(st.analyser); st.analyser.connect(mute);
            // Every piece of sound: its loudest point counts towards the level, and it's kept while recording
            var onBlock = function(l, r) {
                var p = st.peakAcc || 0;
                for (var i = 0; i < l.length; i++) { var v = Math.abs(l[i]); if (v > p) p = v; v = Math.abs(r[i]); if (v > p) p = v; }
                st.peakAcc = p;
                if (st.seg) take(l, r);
            };
            // Pieces of sound off the audio thread (an AudioWorklet); older browsers: a ScriptProcessor
            var code = "registerProcessor('la-rec', class extends AudioWorkletProcessor { process(i) { var c = i[0]; if (c && c.length) this.port.postMessage([c[0].slice(), (c[1] || c[0]).slice()]); return true; } })";
            var viaWorklet = ctx.audioWorklet ? ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))).then(function() {
                var n = st.node = new AudioWorkletNode(ctx, 'la-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
                n.port.onmessage = function(e) { onBlock(e.data[0], e.data[1]); };
                src.connect(n); n.connect(mute);
            }) : Promise.reject();
            return viaWorklet.catch(function() {
                var p = st.node = ctx.createScriptProcessor(4096, 2, 2);
                p.onaudioprocess = function(e) { var b = e.inputBuffer; onBlock(b.getChannelData(0).slice(), (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice()); };
                src.connect(p); p.connect(mute);
            }).then(function() { return ctx.resume(); });
        });
    }
    function closeInput() {
        try { if (st.node) st.node.disconnect(); } catch (_) {}
        try { if (st.ctx) st.ctx.close(); } catch (_) {}
        if (st.stream) st.stream.getTracks().forEach(function(t) { t.stop(); });
        st.stream = st.ctx = st.node = st.analyser = null;
    }

    // ── Recording: 16-bit stereo, kept on the device a few seconds at a time ──
    var pending = [], pendingFrames = 0;
    function take(l, r) {
        var n = l.length, pcm = new Int16Array(n * 2);
        for (var i = 0; i < n; i++) {
            var a = Math.max(-1, Math.min(1, l[i])), b = Math.max(-1, Math.min(1, r[i]));
            pcm[i * 2] = a < 0 ? a * 0x8000 : a * 0x7fff; pcm[i * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
        }
        pending.push(pcm); pendingFrames += n; st.seg.frames += n;
        if (pendingFrames >= st.rate * 5) flush();
    }
    function flush() {
        if (!pending.length || !st.seg) return Promise.resolve();
        var blob = new Blob(pending, { type: 'application/octet-stream' }), id = st.seg.id, seg = st.seg;
        pending = []; pendingFrames = 0;
        return tx(STORE, 'readwrite', function(o) { o.add({ set: id, at: Date.now(), blob: blob }); })
            .then(function() { return putSet(seg); }).catch(function(e) { status('Could not keep the recording on this device: ' + (e && e.message || e), true); });
    }
    function startSet(artist, setStart, setEnd, date, fromSession) {
        if (st.seg) return Promise.resolve();
        st.seg = { id: 'set-' + Date.now(), artist: String(artist || '').toUpperCase().trim(), date: date || londonDay(setStart || Date.now()),
            setStart: setStart || null, setEnd: setEnd || null, startedAt: Date.now(), frames: 0, rate: st.rate, input: st.label, state: 'recording', fromSession: !!fromSession };
        keepAwake(true);
        return putSet(st.seg).then(render);
    }
    function stopSet() {
        var seg = st.seg; if (!seg) return Promise.resolve();
        return flush().then(function() { st.seg = null; seg.state = 'ready'; seg.endedAt = Date.now(); return putSet(seg); })
            .then(function() { if (!st.follow) keepAwake(false); render(); return uploadAll(); });
    }

    // ── Up to Cloud Storage as the session's HQ audio ──
    function wavHeader(frames, rate) {
        var b = new DataView(new ArrayBuffer(44)), bytes = frames * 4;
        var s = function(o, t) { for (var i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
        s(0, 'RIFF'); b.setUint32(4, 36 + bytes, true); s(8, 'WAVE'); s(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true);
        b.setUint16(22, 2, true); b.setUint32(24, rate, true); b.setUint32(28, rate * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 16, true);
        s(36, 'data'); b.setUint32(40, bytes, true);
        return b.buffer;
    }
    function uploadAll() {
        if (st.uploading) return Promise.resolve();
        st.uploading = true;
        return allSets().then(function(sets) {
            var next = sets.filter(function(s) { return s.state === 'ready' || s.state === 'failed'; }).sort(function(a, b) { return a.startedAt - b.startedAt; });
            return next.reduce(function(p, s) { return p.then(function() { return uploadOne(s); }); }, Promise.resolve());
        }).then(function() { st.uploading = false; render(); }, function() { st.uploading = false; render(); });
    }
    function uploadOne(s) {
        if (!s.artist) { s.state = 'failed'; s.error = 'No artist for this recording'; return putSet(s).then(render); }
        s.state = 'uploading'; s.progress = 0; render();
        return chunksOf(s.id).then(function(chunks) {
            chunks.sort(function(a, b) { return a.at - b.at; });
            var frames = chunks.reduce(function(n, c) { return n + c.blob.size / 4; }, 0);
            if (!frames) return dropSet(s.id);
            var file = new Blob([wavHeader(frames, s.rate)].concat(chunks.map(function(c) { return c.blob; })), { type: 'audio/wav' });
            return laFetch('/api/get-upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: s.artist, date: s.date, camera: 'AUDIO', at: s.startedAt }) })
                .then(function(r) { return r.json().catch(function() { return {}; }).then(function(d) { if (!r.ok || !d.url) throw new Error(d.error || 'could not start the upload (' + r.status + ')'); return d; }); })
                .then(function(d) { return new Promise(function(ok, bad) {
                    var x = new XMLHttpRequest(); x.open('PUT', d.url);
                    x.upload.onprogress = function(e) { if (e.lengthComputable) { s.progress = Math.round(e.loaded / e.total * 100); render(); } };
                    x.onload = function() { x.status >= 200 && x.status < 300 ? ok() : bad(new Error('upload failed (' + x.status + ')')); };
                    x.onerror = function() { bad(new Error('the connection dropped')); };
                    x.send(file);
                }); })
                .then(function() { laToast && laToast(s.artist + ': HQ audio uploaded'); return dropSet(s.id); });
        }).catch(function(e) { s.state = 'failed'; s.error = e.message || String(e); return putSet(s); }).then(render);
    }

    // ── Following the venue calendar ──
    function tick() {
        return laFetch('/api/cameras').then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
            if (!d) return;
            st.cal = d.calendar || null;
            if (!st.follow || !st.stream || !(st.cal && st.cal.connected)) return render();
            var now = Date.now(), cal = st.cal || {}, cur = cal.current, next = (cal.upcoming || [])[0];
            if (st.seg && st.seg.setEnd && now > st.seg.setEnd + PAD) return stopSet();
            var set = cur && !(cur.endedAt && now > cur.endedAt + PAD) ? cur : next && now >= next.start - PAD ? next : null;
            if (!st.seg && set) startSet(set.artist, set.start, set.endedAt || set.end);
            else if (st.seg && set && st.seg.setStart === set.start) st.seg.setEnd = set.endedAt || set.end;
            render();
        }).catch(function() {});
    }
    // Every 3 s while on: this device tells the Decks card it's there (input, level, recording), so the card
    // shows it live to everyone, and picks up Create a session / Stop recording for this slot
    var deviceName = function() { var u = navigator.userAgent; return /iPad/.test(u) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : 'Computer'; };
    function here() {
        if (!st.slot || !(st.follow || st.seg) || !st.stream) return;
        var h = { 'Content-Type': 'application/json' }; if (st.slot._venue) h['X-LA-Venue'] = st.slot._venue;
        laFetch('/api/cameras', { method: 'POST', headers: h, body: JSON.stringify({ action: 'deckHere', id: st.slot.id, state: st.seg ? 'recording' : 'ready',
            input: st.label, device: deviceName(), artist: st.seg ? st.seg.artist : '', level: Math.round(st.levelDb == null ? -90 : st.levelDb) }) })
        .then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
            var cmd = d && d.cmd; if (!cmd || !(cmd.at > st.lastCmd)) return;
            st.lastCmd = cmd.at;
            if (cmd.op === 'start' && !st.seg && Date.now() - cmd.at < 8 * 3600e3) startSet(cmd.artist, null, null, cmd.date, true);
            if (cmd.op === 'stop' && st.seg && st.seg.fromSession) stopSet();
        }).catch(function() {});
    }
    setInterval(here, 3000);
    // The level for the card, also when the panel is closed
    // (the loudest point of the last second, from the sound itself)
    setInterval(function() {
        if (!st.stream) { st.levelDb = null; return; }
        var peak = st.peakAcc || 0; st.peakAcc = 0;
        st.levelDb = peak > 0 ? Math.max(-90, 20 * Math.log10(peak)) : -90;
    }, 1000);
    function keepAwake(on) {
        if (!('wakeLock' in navigator)) return;
        if (on && !st.wake) navigator.wakeLock.request('screen').then(function(w) { st.wake = w; w.addEventListener('release', function() { st.wake = null; }); }).catch(function() {});
        if (!on && st.wake) { st.wake.release().catch(function() {}); st.wake = null; }
    }
    document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible' && (st.seg || st.follow)) { keepAwake(true); if (st.ctx) st.ctx.resume(); } });
    window.addEventListener('beforeunload', function(e) { if (st.seg) { flush(); e.preventDefault(); e.returnValue = ''; } });

    // ── The panel and the bar while it records ──
    var esc = function(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var css = document.createElement('style');
    css.textContent = '.dr-bar{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 16px);transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;border-radius:999px;background:var(--la-surface);border:1px solid var(--la-line);box-shadow:0 10px 30px rgba(0,0,0,.35);font-size:13px;color:var(--la-text);max-width:calc(100vw - 32px)}' +
        '.dr-bar b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dr-dot{width:9px;height:9px;border-radius:50%;background:#ef4444;flex:none;animation:dr-p 1.2s ease-in-out infinite}.dr-dot.idle{background:var(--la-dim);animation:none}' +
        '@keyframes dr-p{50%{opacity:.35}}.dr-bar button{height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--la-line);background:transparent;color:var(--la-text);font-size:12px;cursor:pointer}' +
        '.dr-meter{height:8px;border-radius:99px;background:var(--la-chip);overflow:hidden;margin:6px 0 2px}.dr-meter i{display:block;height:100%;width:0;background:var(--la-accent);transition:width .08s linear}' +
        '.dr-list{display:grid;gap:8px;margin-top:14px}.dr-item{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--la-chip);font-size:12px}' +
        '.dr-note{font-size:12px;line-height:1.55;color:var(--la-dim);margin-top:10px}.dr-err{color:var(--la-bad)}';
    document.head.appendChild(css);
    var bar = null, meterRaf = 0, lastMsg = '';
    function status(msg, bad) { lastMsg = msg ? (bad ? '<span class="dr-err">' + esc(msg) + '</span>' : esc(msg)) : ''; render(); }
    function fmtLen(frames, rate) { var s = Math.floor(frames / rate), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); }
    function render() {
        // The bar: while armed or recording, on every visit to the page
        if (st.follow || st.seg) {
            if (!bar) { bar = document.createElement('div'); bar.className = 'dr-bar'; document.body.appendChild(bar); bar.addEventListener('click', function(e) { if (e.target.closest('[data-dr-open]')) open(st.slot); if (e.target.closest('[data-dr-stop]')) disarm(); }); }
            bar.innerHTML = '<span class="dr-dot' + (st.seg ? '' : ' idle') + '"></span><b>' + (st.seg ? 'Recording ' + (st.ownChosen ? 'from the microphone' : 'decks') + ' · ' + esc(st.seg.artist || 'No artist') + ' · ' + fmtLen(st.seg.frames, st.rate) : 'Decks ready on this ' + deviceName() + ' · records with each session') + '</b>' +
                '<button type="button" data-dr-open>Open</button><button type="button" data-dr-stop>' + (st.seg ? 'Stop' : 'Turn off') + '</button>';
        } else if (bar) { bar.remove(); bar = null; }
        var body = document.getElementById('dr-body');
        if (!body) return;
        allSets().then(function(sets) {
            var waiting = sets.filter(function(s) { return s.state !== 'recording' || !st.seg || s.id !== st.seg.id; });
            var cal = st.cal || {}, cur = cal.current, next = (cal.upcoming || [])[0];
            var when = cur ? 'On now: ' + esc(cur.artist) + ', until ' + clock(cur.endedAt || cur.end) : next ? 'Next: ' + esc(next.artist) + ', ' + new Date(next.start).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }) + ' ' + clock(next.start) : '';
            var el = body.querySelector('[data-dr-state]');
            if (el) el.innerHTML = st.seg ? 'Recording <b>' + esc(st.seg.artist || 'No artist') + '</b> from <b>' + esc(st.label || 'the input') + '</b> · ' + fmtLen(st.seg.frames, st.rate) : st.follow ? 'On: recording starts with <b>Create a session</b> (tick this Decks audio, with the camera)' + (cal.connected ? ' and with every set in the calendar. ' + when : '.') : 'Turn it on to record with Create a session' + (cal.connected ? ' and every set in the calendar. ' + when : ', or press Record now.');
            var btns = body.querySelector('[data-dr-btns]');
            if (btns) btns.innerHTML = !st.stream ? '' : st.seg ? '<button type="button" class="cam-btn" data-dr="stop">Stop and upload</button>'
                : '<button type="button" class="cam-btn primary" data-dr="' + (st.follow ? 'unfollow' : 'follow') + '">' + (st.follow ? 'Turn off' : 'Turn on') + '</button>' +
                  (typeof window.openSession === 'function' ? '<button type="button" class="cam-btn" data-dr="session">Create a session</button>' : '');
            var list = body.querySelector('[data-dr-list]');
            if (list) list.innerHTML = waiting.length ? waiting.map(function(s) {
                var what = s.state === 'uploading' ? 'Uploading ' + (s.progress || 0) + '%' : s.state === 'failed' ? '<span class="dr-err">Not uploaded: ' + esc(s.error || '') + '</span>' : s.state === 'recording' ? 'Stopped before the end (kept here)' : 'Waiting to upload';
                return '<div class="dr-item"><span><b>' + esc(s.artist || 'No artist') + '</b> · ' + esc(s.date) + ' · ' + fmtLen(s.frames || 0, s.rate || 48000) + '</span><span>' + what + '</span></div>';
            }).join('') + (waiting.some(function(s) { return s.state !== 'uploading'; }) ? '<button type="button" class="cam-btn" data-dr="upload">Upload now</button>' : '') : '';
            var msg = body.querySelector('[data-dr-msg]'); if (msg) msg.innerHTML = lastMsg;
        });
    }
    function meter() {
        cancelAnimationFrame(meterRaf);
        var bar = document.querySelector('#dr-body .dr-meter i');
        if (!bar || !st.analyser) return;
        var buf = new Float32Array(st.analyser.fftSize);
        (function loop() {
            if (!document.body.contains(bar) || !st.analyser) return;
            st.analyser.getFloatTimeDomainData(buf);
            var peak = 0; for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
            var db_ = peak > 0 ? 20 * Math.log10(peak) : -90;
            bar.style.width = Math.max(0, Math.min(100, (db_ + 60) / 60 * 100)) + '%';
            bar.style.background = db_ > -1 ? 'var(--la-bad)' : '';
            meterRaf = requestAnimationFrame(loop);
        })();
    }
    function disarm() { st.follow = false; var p = stopSet(); keepAwake(false); render(); return p; }
    function open(slot) {
        st.slot = slot || st.slot;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { openCamDialog('Record the decks here', '<p class="cam-dialog-text">This browser can’t record a sound input.</p>'); return; }
        openCamDialog('Record the decks here', '<div id="dr-body">' +
            '<p class="cam-dialog-text">Plug the mixer into this device: its USB, a USB audio interface, or the audio jack (on an iPad without one, a USB-C to 3.5 mm adapter with a mic input). Then choose it below. The sound is recorded here, uncompressed, and each set goes up as that session’s HQ audio when it ends.</p>' +
            '<label class="cam-field" style="margin-top:14px"><span>Decks input</span><select data-dr-in style="height:40px;border-radius:10px;border:1px solid var(--la-line);background:var(--la-input);color:var(--la-text);padding:0 10px"><option>Looking for inputs…</option></select></label>' +
            '<div data-dr-warn></div>' +
            '<div class="dr-meter" aria-hidden="true"><i></i></div><p class="dr-note" style="margin-top:2px">The bar moves with the music. Red means too loud: turn the mixer’s output down a little.</p>' +
            '<p class="dr-note" data-dr-state style="color:var(--la-text);font-size:13px"></p>' +
            '<label class="cam-field" style="margin-top:10px"><span>Artist (when there\u2019s no set in the calendar)</span><input data-dr-artist maxlength="60" placeholder="DJ name" value="' + esc(st.manualArtist || (st.slot && st.slot.artist) || '') + '" style="height:40px;border-radius:10px;border:1px solid var(--la-line);background:var(--la-input);color:var(--la-text);padding:0 12px;font-size:14px"></label>' +
            '<div data-dr-btns style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px"></div>' +
            '<p class="dr-note" data-dr-msg></p>' +
            '<div class="dr-list" data-dr-list></div>' +
            '<p class="dr-note">Keep this page open on screen and the device on charge: it records only while the page is showing (the screen stays on by itself).</p></div>');
        var body = document.getElementById('dr-body'), sel = body.querySelector('[data-dr-in]');
        // The decks are only ever an input plugged in: the device's own microphone is listed last, marked, and
        // used only when chosen by hand (it once recorded the room instead of the decks, with nothing said)
        var warn = body.querySelector('[data-dr-warn]');
        var fill = function() {
            return inputs().then(function(list) {
                var ext = list.filter(function(d) { return !builtIn.test(d.label); }), own = list.filter(function(d) { return builtIn.test(d.label); });
                var cur = st.deviceId && list.find(function(d) { return d.deviceId === st.deviceId; });
                var pick = cur && (!builtIn.test(cur.label) || st.ownChosen) ? cur : ext[0] || null;
                sel.innerHTML = (pick ? '' : '<option value="" selected>Choose the decks</option>') +
                    ext.map(function(d, i) { return '<option value="' + esc(d.deviceId) + '"' + (d === pick ? ' selected' : '') + '>' + esc(d.label || 'Input ' + (i + 1)) + '</option>'; }).join('') +
                    own.map(function(d) { return '<option value="' + esc(d.deviceId) + '"' + (d === pick ? ' selected' : '') + '>' + esc((d.label || 'Microphone') + ' \u2014 this device\u2019s microphone, not the decks') + '</option>'; }).join('');
                warn.innerHTML = ext.length ? '' : '<div class="dr-item" style="display:block;margin-top:10px;line-height:1.55"><b class="dr-err">This device doesn\u2019t see the decks yet: only its own microphone.</b><br>' +
                    'Connect the mixer as a sound input, then press Look again:<br>\u2022 <b>USB:</b> the mixer\u2019s USB, if it works as a USB sound card without a driver on this device, or a USB audio interface with the mixer\u2019s <b>Rec Out</b> or <b>Booth Out</b> in its line inputs (through a powered USB-C hub if it needs power).<br>' +
                    '\u2022 <b>Audio jack:</b> the headphone jack only takes a microphone plug (4 rings, TRRS): use a line-to-mic TRRS cable or an iRig-type adapter from the mixer\u2019s Rec or Booth Out. A plain stereo cable isn\u2019t heard as an input.' +
                    '<br><button type="button" class="cam-btn" data-dr="rescan" style="margin-top:10px">Look again</button></div>';
                if (!pick) { if (!st.seg) closeInput(); render(); return; }
                return (st.stream && st.deviceId === pick.deviceId ? Promise.resolve() : openInput(pick.deviceId)).then(meter).then(render);
            }).catch(function(e) { status('Could not open the sound input: ' + (e && e.message || e) + '. Allow the microphone for this site and try again.', true); });
        };
        fill();
        // Plugged in (or out) while the panel is open: the list follows
        if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', function() { if (document.body.contains(sel) && !st.seg) fill(); });
        sel.addEventListener('change', function() {
            if (st.seg) { status('Stop the recording before changing the input.', true); sel.value = st.deviceId; return; }
            var opt = sel.options[sel.selectedIndex];
            st.ownChosen = !!(opt && /not the decks/.test(opt.textContent));
            if (!sel.value) { closeInput(); render(); return; }
            openInput(sel.value).then(meter).then(render).catch(function(e) { status('Could not open that input: ' + (e && e.message || e), true); });
        });
        body.addEventListener('click', function(e) {
            var b = e.target.closest('[data-dr]'); if (!b) return;
            var a = b.dataset.dr;
            // Turned on during a session already started: it joins it (a session's start counts for 8 hours)
            if (a === 'follow') { st.follow = true; st.lastCmd = 0; keepAwake(true); tick(); here(); }
            if (a === 'unfollow') disarm();
            if (a === 'stop') { st.follow = false; stopSet(); }
            if (a === 'upload') uploadAll();
            // Recording by hand is a session: the cameras and the decks start together
            if (a === 'session') { window.openSession(); return; }
            if (a === 'rescan') { status(''); fill(); }
            if (a === 'now') {
                // The calendar's set, else the artist typed here (or On stage on the card)
                var cal = st.cal || {}, typed = body.querySelector('[data-dr-artist]');
                st.manualArtist = typed ? typed.value.trim() : st.manualArtist;
                var who = (cal.current && cal.current.artist) || st.manualArtist || (st.slot && st.slot.artist) || '';
                if (!who) { status('Type the artist first.', true); if (typed) typed.focus(); return; }
                startSet(who, cal.current ? cal.current.start : Date.now(), cal.current ? (cal.current.endedAt || cal.current.end) : null);
            }
            render();
        });
        tick(); render();
    }
    // Every 20 s: the calendar, and sets finishing; every second while recording: the time recorded
    setInterval(function() { if (st.follow || st.seg || document.getElementById('dr-body')) tick(); }, 5000);
    setInterval(function() { if (st.seg) render(); }, 1000);
    // Anything left from an earlier visit (the page closed while recording or uploading) goes up when the page opens
    if (window.indexedDB) setTimeout(function() {
        allSets().then(function(sets) {
            var left = sets.filter(function(s) { return s.state !== 'ready' && s.state !== 'failed'; });
            return Promise.all(left.map(function(s) { s.state = 'ready'; return putSet(s); }));
        }).then(function() { return uploadAll(); }).catch(function() {});
    }, 4000);
    window.laDeckRec = { open: open };
})();
