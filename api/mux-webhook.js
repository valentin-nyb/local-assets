import { put } from '@vercel/blob';
import { processCameraRecording } from './_camera-recording.js';
import { createClient } from 'redis';
import { startVerticals, venueForAsset } from './_verticals.js';
import crypto from 'crypto';

// Signature check: every event must be signed by one of our Mux environments' webhook secrets
// (DJ_TENNIS_TEAM_MUX_WEBHOOK_SECRET, AMONGST_FEW_MUX_WEBHOOK_SECRET, … and MUX_WEBHOOK_SECRET).
// Header "mux-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<raw body>'>"; at most 5 minutes old.
export const config = { api: { bodyParser: false } };
const webhookSecrets = () => Object.entries(process.env)
    .filter(([k, v]) => v && (k === 'MUX_WEBHOOK_SECRET' || /_MUX_WEBHOOK_SECRET$/.test(k)))
    .map(([, v]) => v.trim());
function signedByMux(raw, header) {
    const parts = Object.fromEntries(String(header || '').split(',').map(p => p.trim().split('=')).filter(x => x.length === 2));
    const t = Number(parts.t), sig = String(parts.v1 || '');
    if (!t || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(Date.now() / 1000 - t) > 300) return false;
    return webhookSecrets().some(secret => {
        const want = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
    });
}
function rawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Every venue has its own Mux environment: each event is handled with the keys of the venue
// whose Cloud Storage holds the asset (found by asking each venue's environment).

// MASTER uploads have no " // " in passthrough (e.g. "DRAKE")
// Sub-assets have " // " (e.g. "DRAKE // AUDIO", "DRAKE // SOCIAL // 01")
function isMasterAsset(passthrough) {
    if (!passthrough) return false;
    const pt = passthrough.toUpperCase().trim();
    return pt.length > 0 && !pt.includes(' // ');
}

// ── 1. AUDIO EXTRACTION ──────────────────────────────────────────────
async function createAudioAsset(auth, assetId, artistName) {
    const tag = artistName + ' // AUDIO';
    console.log(`[Audio] Creating: ${tag}`);
    const result = await fetch('https://api.mux.com/video/v1/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({
            input: [{ url: `mux://assets/${assetId}` }],
            playback_policy: ['public'],
            passthrough: tag,
            static_renditions: [{ resolution: 'audio-only' }]
        })
    });
    const data = await result.json();
    console.log(`[Audio] Created: ${data.data?.id || JSON.stringify(data.error || data)}`);
    return data.data;
}

// ── 2. SOCIAL VERTICAL CLIPS ─────────────────────────────────────────
async function createSocialClips(auth, found, assetId, artistName, duration) {
    const clipCount = Math.min(Math.floor(duration / 30), 5);
    if (clipCount < 1) {
        console.log('[Social] Video too short for clips');
        return;
    }

    // Request AI subtitles so highlights can supplement later
    try {
        await fetch(`https://api.mux.com/video/v1/assets/${assetId}/tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify({ type: 'text', text_type: 'generated_subtitles', language_code: 'en', name: 'Internal_AI', passthrough: 'AI_Tracker' }),
        });
        console.log('[Social] Requested AI track for future highlights');
    } catch (e) {
        console.log('[Social] AI track skipped:', e.message);
    }

    // Vertical originals (9:16, 1080×1920), cut once from the full recording by api/vertical-clips.js.
    // They are kept as the originals; a Brand Kit watermark only ever goes on copies of them.
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    try {
        const n = await startVerticals(redis, found.slug, found.asset, artistName, 'https://local-assets.com');
        console.log(`[Social] Cutting ${n} vertical clips for ${artistName} (${found.slug})`);
    } finally {
        await redis.quit().catch(() => {});
    }
}

// ── 3. THUMBNAIL GENERATION ──────────────────────────────────────────
async function createThumbnails(auth, assetId, artistName, playbackId, duration) {
    const count = Math.min(5, Math.max(3, Math.floor(duration / 60)));
    const interval = duration / (count + 1);

    for (let i = 0; i < count; i++) {
        const time = Math.round(interval * (i + 1));
        const tag = artistName + ' // THUMB // ' + String(i + 1).padStart(2, '0');
        const imageUrl = `https://image.mux.com/${playbackId}/thumbnail.png?width=1920&height=1080&fit_mode=smartcrop&time=${time}`;
        console.log(`[Thumb] ${i + 1}/${count}: ${tag} @ ${time}s`);

        try {
            const imgRes = await fetch(imageUrl);
            if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

            // Upload to Vercel Blob for a public URL Mux can ingest
            const blob = await put(
                `thumbnails/${artistName.replace(/[^A-Z0-9]/gi, '_')}_${i + 1}.png`,
                imgBuffer,
                { access: 'public', contentType: 'image/png' }
            );

            // Create Mux asset from the thumbnail
            const muxRes = await fetch('https://api.mux.com/video/v1/assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({
                    input: [{ url: blob.url }],
                    playback_policy: ['public'],
                    passthrough: tag,
                    static_renditions: [{ resolution: 'highest' }]
                })
            });
            const data = await muxRes.json();
            console.log(`[Thumb] Created: ${data.data?.id || 'error'}`);
        } catch (e) {
            console.error(`[Thumb] ${i + 1} error:`, e.message);
        }
    }
}

// ── WEBHOOK HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Use POST');

    const raw = await rawBody(req);
    if (!signedByMux(raw, req.headers['mux-signature'])) {
        console.error('[Webhook] rejected: not signed by one of our Mux environments');
        return res.status(401).send('Invalid signature');
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
    const { type, data } = body;

    // ── ASSET READY ──────────────────────────────────────────────────
    if (type === 'video.asset.ready') {
        const assetId = data.id || data.asset_id;
        const passthrough = (data.passthrough || '').toUpperCase().trim();
        const duration = data.duration || 0;
        const playbackId = data.playback_ids?.[0]?.id;
        const found = await venueForAsset(assetId);
        if (!found) { console.error('[Webhook] No venue Cloud Storage holds', assetId); return res.status(200).send('Unknown asset'); }
        const auth = found.auth;

        console.log(`[Webhook] asset.ready — id:${assetId} pt:"${passthrough}" dur:${duration}s`);

        // Set asset name = passthrough + date
        try {
            if (passthrough && !data.live_stream_id) {
                const d = new Date((data.created_at || Date.now() / 1000) * 1000);
                const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
                await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ meta: { title: passthrough + ' — ' + dateStr } }) });
            }
        } catch (e) {
            console.log('Title update failed:', e.message);
        }

        // ── AUTO-PIPELINE: only for MASTER assets ────────────────────
        // Camera recordings are handled when the broadcast ends (video.asset.live_stream_completed)
        if (!data.live_stream_id && isMasterAsset(passthrough) && duration > 10 && playbackId) {
            console.log(`[Pipeline] MASTER "${passthrough}" (${Math.round(duration)}s) — generating audio + clips + thumbs...`);

            const results = await Promise.allSettled([
                createAudioAsset(auth, assetId, passthrough),
                createSocialClips(auth, found, assetId, passthrough, duration),
                createThumbnails(auth, assetId, passthrough, playbackId, duration),
            ]);

            for (const r of results) {
                if (r.status === 'rejected') console.error('[Pipeline] Failed:', r.reason?.message);
            }
            console.log(`[Pipeline] Done for "${passthrough}"`);
        }
    }

    // ── CAMERA BROADCAST ENDED → sessions per artist + vertical clips ──
    if (type === 'video.asset.live_stream_completed') {
        try { await processCameraRecording(data); }
        catch (e) { console.error('[camera-rec] failed:', e.message); }
    }

    // AI captions finishing no longer cut extra clips: vertical originals are cut once (api/_verticals.js)

    res.status(200).send('Webhook handled');
}