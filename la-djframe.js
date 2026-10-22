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

    // Look at 16 moments of the recording (8% to 92%) and keep the best view of the DJ. The DJ stays in one
    // place for the whole set while people in the room or walking past move around, so a person seen in
    // the same spot in many of the frames counts far more than one big person in a single frame.
    function iou(a, b) {
        var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
        var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        return inter / (a.w * a.h + b.w * b.h - inter || 1);
    }
    async function find(pid, dur) {
        var d = await detectors(), frames = [];
        for (var i = 0; i < 16; i++) {
            var t = Math.round(dur * (0.08 + 0.84 * i / 15));
            var img;
            try { img = await load('https://image.mux.com/' + pid + '/thumbnail.jpg?time=' + t + '&width=640'); } catch (_) { continue; }
            var W = img.naturalWidth, H = img.naturalHeight;
            var ppl = d.people.detect(img).detections || [];
            var fcs = d.faces ? (d.faces.detect(img).detections || []) : [];
            var crowd = 1 + 0.2 * Math.max(0, ppl.length - 2);
            frames.push({ t: t, people: ppl.map(function (p) {
                var b = p.boundingBox, area = b.width * b.height / (W * H);
                var cx = (b.originX + b.width / 2) / W;
                var middle = 1 - Math.min(1, Math.abs(cx - 0.5) * 1.6);
                var face = fcs.some(function (f) { var fb = f.boundingBox, fx = fb.originX + fb.width / 2, fy = fb.originY + fb.height / 2; return fx > b.originX && fx < b.originX + b.width && fy > b.originY && fy < b.originY + b.height * 0.5; });
                // Seen from the front, the head is near the top of the picture; from above (the decks camera) only arms and
                // shoulders show, starting low down
                var top = b.originY / H, upright = top < 0.3 ? 1 : top < 0.45 ? 0.55 : 0.2;
                return {
                    box: { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H },
                    score: (p.categories[0] ? p.categories[0].score : 0.5) * Math.sqrt(area) * (0.4 + 0.6 * middle) * upright * (face ? 1.8 : 1) / crowd,
                    // Centred on the head and shoulders
                    focus: { x: Math.round(cx * 100), y: Math.round((b.originY + b.height * 0.3) / H * 100) },
                };
            }) });
        }
        var best = null, others = Math.max(1, frames.length - 1);
        frames.forEach(function (f) {
            f.people.forEach(function (p) {
                // In how many other frames someone stands in the same place
                var seen = frames.filter(function (g) { return g !== f && g.people.some(function (q) { return iou(p.box, q.box) > 0.3; }); }).length;
                var score = p.score * (seen >= 3 ? 0.3 + seen / others : 0.15);
                if (!best || score > best.score) best = { time: f.t, score: score, focus: p.focus };
            });
        });
        return best ? { time: best.time, focus: best.focus } : null;
    }

    // asset: a Mux asset ({ id, duration, playback_ids }). Resolves to { time, focus } or null.
    // The account's saved moment (the server's) always wins, so every device shows the same one (also after
    // the banner moment is chosen); this browser's copy is only used when the server can't be reached.
    window.laDjSpot = function (asset) {
        if (!asset || !asset.id || !asset.playback_ids || !asset.playback_ids[0]) return Promise.resolve(null);
        var key = 'la_dj3:' + asset.id;
        var cached = null; try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
        var local = cached && cached.time != null ? cached : null;
        if (inflight[asset.id]) return inflight[asset.id];
        var fetchFn = window.laFetch || fetch;
        var keep = function (v) { try { localStorage.setItem(key, JSON.stringify(v || { none: true })); } catch (_) {} return v; };
        var save = function (v) { fetchFn('/api/peak-moment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: asset.id, dj: v, v: 3 }) }).catch(function () {}); };
        inflight[asset.id] = fetchFn('/api/peak-moment?dj=3&assetId=' + encodeURIComponent(asset.id))
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (s) {
                if (s && s.dj) return keep(s.dj);
                // Not on the server yet: this browser's earlier find goes there (so other devices get it), else find it now
                if (local) { save(local); return local; }
                return find(asset.playback_ids[0].id, Number(asset.duration) || 0).then(function (v) {
                    if (v) save(v);
                    return keep(v);
                });
            })
            .catch(function () { return local; })
            .then(function (v) { delete inflight[asset.id]; return v; });
        return inflight[asset.id];
    };
})();
