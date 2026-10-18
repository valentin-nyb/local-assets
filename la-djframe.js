// The moment of a set where the DJ is seen from the front, and where they are in the picture.
// Frames across the recording are looked at with MediaPipe (in the browser): the best one has a single
// large person near the middle (a face counts extra), not a crowd or an empty room. The answer is kept
// per recording on the server (/api/peak-moment?dj=1) and in this browser, so it's only worked out once.
(function () {
    var V = '0.10.14';
    var CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + V;
    var MODELS = 'https://storage.googleapis.com/mediapipe-models/';
    var detP = null, inflight = {};

    function detectors() {
        if (!detP) detP = import(CDN + '/vision_bundle.mjs').then(async function (m) {
            var files = await m.FilesetResolver.forVisionTasks(CDN + '/wasm');
            var people = await m.ObjectDetector.createFromOptions(files, {
                baseOptions: { modelAssetPath: MODELS + 'object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite' },
                runningMode: 'IMAGE', scoreThreshold: 0.35, categoryAllowlist: ['person'], maxResults: 12,
            });
            var faces = await m.FaceDetector.createFromOptions(files, {
                baseOptions: { modelAssetPath: MODELS + 'face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite' },
                runningMode: 'IMAGE', minDetectionConfidence: 0.5,
            }).catch(function () { return null; });
            return { people: people, faces: faces };
        });
        return detP;
    }
    function load(src) {
        return new Promise(function (res, rej) { var i = new Image(); i.crossOrigin = 'anonymous'; i.onload = function () { res(i); }; i.onerror = rej; i.src = src; });
    }

    // Look at 16 moments of the recording (8% to 92%) and keep the best view of one person
    async function find(pid, dur) {
        var d = await detectors(), best = null;
        for (var i = 0; i < 16; i++) {
            var t = Math.round(dur * (0.08 + 0.84 * i / 15));
            var img;
            try { img = await load('https://image.mux.com/' + pid + '/thumbnail.jpg?time=' + t + '&width=640'); } catch (_) { continue; }
            var W = img.naturalWidth, H = img.naturalHeight;
            var ppl = d.people.detect(img).detections || [];
            var fcs = d.faces ? (d.faces.detect(img).detections || []) : [];
            var crowd = 1 + 0.2 * Math.max(0, ppl.length - 2);
            ppl.forEach(function (p) {
                var b = p.boundingBox, area = b.width * b.height / (W * H);
                var cx = (b.originX + b.width / 2) / W;
                var middle = 1 - Math.min(1, Math.abs(cx - 0.5) * 1.6);
                var face = fcs.some(function (f) { var fb = f.boundingBox, fx = fb.originX + fb.width / 2, fy = fb.originY + fb.height / 2; return fx > b.originX && fx < b.originX + b.width && fy > b.originY && fy < b.originY + b.height * 0.5; });
                // Seen from the front, the head is near the top of the picture; from above (the decks camera) only arms and
                // shoulders show, starting low down
                var top = b.originY / H, upright = top < 0.3 ? 1 : top < 0.45 ? 0.55 : 0.2;
                var score = (p.categories[0] ? p.categories[0].score : 0.5) * Math.sqrt(area) * (0.4 + 0.6 * middle) * upright * (face ? 1.8 : 1) / crowd;
                // Centred on the head and shoulders
                if (!best || score > best.score) best = { time: t, score: score, focus: { x: Math.round(cx * 100), y: Math.round((b.originY + b.height * 0.3) / H * 100) } };
            });
        }
        return best ? { time: best.time, focus: best.focus } : null;
    }

    // asset: a Mux asset ({ id, duration, playback_ids }). Resolves to { time, focus } or null.
    window.laDjSpot = function (asset) {
        if (!asset || !asset.id || !asset.playback_ids || !asset.playback_ids[0]) return Promise.resolve(null);
        var key = 'la_dj2:' + asset.id;
        try { var c = JSON.parse(localStorage.getItem(key) || 'null'); if (c) return Promise.resolve(c.time != null ? c : null); } catch (_) {}
        if (inflight[asset.id]) return inflight[asset.id];
        var fetchFn = window.laFetch || fetch;
        var keep = function (v) { try { localStorage.setItem(key, JSON.stringify(v || { none: true })); } catch (_) {} return v; };
        inflight[asset.id] = fetchFn('/api/peak-moment?dj=2&assetId=' + encodeURIComponent(asset.id))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
                if (s && s.dj) return keep(s.dj);
                return find(asset.playback_ids[0].id, Number(asset.duration) || 0).then(function (v) {
                    if (v) fetchFn('/api/peak-moment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id, dj: v }) }).catch(function () {});
                    return keep(v);
                });
            })
            .catch(function () { return null; });
        return inflight[asset.id];
    };
})();
