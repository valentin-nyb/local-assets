import { put } from '@vercel/blob';
import { muxUrlAuto } from './_signing.js';
import { processCameraRecording } from './_camera-recording.js';
import { createClient } from 'redis';
import { startVerticals, venueForAsset, startAudioOnly } from './_verticals.js';
import crypto from 'crypto';
import { freshVenues, registryWebhookSecrets } from './_venues.js';

// Signature check: every event must be signed by one of our Mux environments' webhook secrets
// (DJ_TENNIS_TEAM_MUX_WEBHOOK_SECRET, AMONGST_FEW_MUX_WEBHOOK_SECRET, … and MUX_WEBHOOK_SECRET).
// Header "mux-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<raw body>'>"; at most 5 minutes old.
export const config = { api: { bodyParser: false } };
// Sign-ups' environments keep their secret in the account registry (Billing → Ready video storage).
const webhookSecrets = () => [...Object.entries(process.env)
    .filter(([k, v]) => v && (k === 'MUX_WEBHOOK_SECRET' || /_MUX_WEBHOOK_SECRET$/.test(k)))
    .map(([, v]) => v.trim()), ...registryWebhookSecrets()];
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
// The artist of a full recording (4K long form), or null for anything else: HQ audio, clips, thumbnails,
// or uploads without a video track. Labels are "ARTIST" or JSON { artist, date, camera }.
function masterArtist(rawPassthrough, tracks) {
    if (Array.isArray(tracks) && tracks.length && !tracks.some(t => t.type === 'video')) return null;
    const pt = String(rawPassthrough || '').trim();
    if (!pt) return null;
    if (pt.startsWith('{')) {
        try {
            const o = JSON.parse(pt);
            const cam = String(o?.camera || 'MASTER').toUpperCase().trim();
            const artist = String(o?.artist || '').toUpperCase().trim();
            return artist && !['AUDIO', 'SOCIAL', 'SOCIALRAW', 'THUMB'].includes(cam) ? artist : null;   // any camera: Master, Booth, PTZ
        } catch { return null; }
    }
    return isMasterAsset(pt) ? pt.toUpperCase() : null;
}

async function decksAudio(found, data, playbackId) {
  let o = null; try { o = JSON.parse(String(data.passthrough || '')); } catch {}
  const isDecks = o && String(o.camera || '').toUpperCase() === 'AUDIO';
  if (!isDecks) return;
  const hasVideo = (data.tracks || []).some(t => t.type === 'video');
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    if (hasVideo && data.source_asset_id) {
      // A set cut from the decks' recording (calendar): make it audio-only
      if (await redis.set(`aud_job:${data.id}`, '1', { NX: true, EX: 86400 })) await startAudioOnly(found.slug, { ...data, playback_ids: data.playback_ids || [{ id: playbackId }] });
    } else if (!hasVideo) {
      // The audio-only copy is ready: the video version it replaces goes
      const swap = JSON.parse(await redis.get(`aud_swap:${data.id}`) || 'null');
      if (swap?.old) {
        await fetch(`https://api.mux.com/video/v1/assets/${encodeURIComponent(swap.old)}`, { method: 'DELETE', headers: { Authorization: found.auth } }).catch(() => {});
        await redis.del(`aud_swap:${data.id}`);
        console.log('[decks-audio] replaced', swap.old, 'with audio-only', data.id);
      }
    }
  } finally { await redis.quit().catch(() => {}); }
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
            playback_policy: ['public'], video_quality: 'basic',
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
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
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
        // Mux reads the frame itself to make the thumbnail: signed for a day when the video is signed
        const imageUrl = await muxUrlAuto(auth, `https://image.mux.com/${playbackId}/thumbnail.png?width=1920&height=1080&fit_mode=smartcrop&time=${time}`, 86400);
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
                    playback_policy: ['public'], video_quality: 'basic',
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
// Minutes Mux encoded this month, by account and kind (vod|live : quality : resolution); Redis hash mux_ledger:<YYYY-MM>
async function noteEncoded(slug, a) {
  const min = (Number(a.duration) || 0) / 60;
  if (!min || !(process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL)) return;
  const r = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) }); await r.connect();
  try {
    if (!(await r.set(`mux_ledgered:${a.id}`, '1', { NX: true, EX: 60 * 86400 }))) return;
    const q = ({ baseline: 'basic', smart: 'plus' })[a.encoding_tier] || a.video_quality || 'plus';
    const tier = a.resolution_tier || (a.max_stored_resolution === 'Audio only' ? 'audio-only' : '1080p');
    const month = new Date((Number(a.created_at) || Date.now() / 1000) * 1000).toISOString().slice(0, 7);
    await r.hIncrByFloat(`mux_ledger:${month}`, `${slug || '?'}|${a.live_stream_id ? 'live' : 'vod'}:${q}:${tier}`, Math.round(min * 1000) / 1000);
  } finally { await r.quit().catch(() => {}); }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Use POST');

    const raw = await rawBody(req);
    await freshVenues(60000);
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
        // Mux charges for encoding as soon as a video is ready, even if it's deleted later: note its minutes
        // for this month (Billing → What Mux charges), once per video
        await noteEncoded(found ? found.slug : '', data).catch(e => console.error('[Webhook] encode ledger', e.message));
        if (!found) { console.error('[Webhook] No venue Cloud Storage holds', assetId); return res.status(200).send('Unknown asset'); }
        const auth = found.auth;

        console.log(`[Webhook] asset.ready — id:${assetId} pt:"${passthrough}" dur:${duration}s`);

        // Decks audio: a recording that arrived as video becomes audio-only; the audio copy replaces it
        await decksAudio(found, data, playbackId).catch(e => console.error('[decks-audio]', e.message));

        // Set asset name = passthrough + date
        try {
            // Keep a title given at upload; an upload's passthrough can be JSON ({artist, date, camera}), named from its parts
            if (passthrough && !data.live_stream_id && !data.meta?.title) {
                let name = passthrough, when = (data.created_at || Date.now() / 1000) * 1000;
                try { const o = JSON.parse(passthrough); if (o && o.artist) { name = String(o.artist).toUpperCase() + (o.camera ? ' // ' + String(o.camera).toUpperCase() : ''); if (o.date) when = Date.parse(o.date + 'T12:00:00Z') || when; } } catch {}
                const dateStr = new Date(when).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
                await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ meta: { title: name + ' — ' + dateStr } }) });
            }
        } catch (e) {
            console.log('Title update failed:', e.message);
        }

        // ── AUTO-PIPELINE: only for MASTER assets ────────────────────
        // Camera recordings are handled when the broadcast ends (video.asset.live_stream_completed)
        const artist = masterArtist(data.passthrough, data.tracks);
        // One camera of a multi-camera set: the clips come from the multi-camera edit instead
        let multiCam = false; try { multiCam = !!JSON.parse(String(data.passthrough || '')).multi; } catch {}
        if (multiCam) console.log(`[Pipeline] "${artist}" is one camera of a multi-camera set: waiting for the edit`);
        if (!data.live_stream_id && !multiCam && artist && duration > 10 && playbackId) {
            console.log(`[Pipeline] MASTER "${artist}" (${Math.round(duration)}s) — generating audio + clips + thumbs...`);

            // Once per recording (Mux can send "ready" again), and only when the recording has sound
            const hasSound = (data.tracks || []).some(t => t.type === 'audio');
            let firstReady = true;
            try {
                const rc = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) }); await rc.connect();
                try { firstReady = !!(await rc.set(`pipe_ready:${assetId}`, '1', { NX: true, EX: 30 * 86400 })); } finally { await rc.quit().catch(() => {}); }
            } catch (e) { console.error('[Pipeline] dedupe', e.message); }
            if (!firstReady) { console.log(`[Pipeline] "${artist}" ${assetId} already handled`); return res.status(200).send('OK'); }
            if (!hasSound) console.log(`[Audio] "${artist}" ${assetId} has no sound: no HQ audio made from it`);
            const results = await Promise.allSettled([
                hasSound ? createAudioAsset(auth, assetId, artist) : Promise.resolve(null),
                createSocialClips(auth, found, assetId, artist, duration),
                createThumbnails(auth, assetId, artist, playbackId, duration),
            ]);

            for (const r of results) {
                if (r.status === 'rejected') console.error('[Pipeline] Failed:', r.reason?.message);
            }
            console.log(`[Pipeline] Done for "${artist}"`);
        }
    }

    // ── BROKEN CAMERA RECORDINGS ARE NEVER KEPT ──
    // A camera or decks stream that connects and drops (a device cutting out, a reconnect) leaves a recording
    // Mux can't process, or one only seconds long. Those hold nothing usable: they're deleted straight away,
    // so they never fill Cloud Storage or System Health.
    if (data?.live_stream_id && (type === 'video.asset.errored' || (type === 'video.asset.live_stream_completed' && Number(data.duration) > 0 && Number(data.duration) < 15))) {
        const assetId = data.id;
        try {
            const found = await venueForAsset(assetId);
            const a = found?.asset;
            // Checked again with Mux before deleting: still a live recording, and still broken or seconds long
            if (a && a.live_stream_id && (a.status === 'errored' || (a.status === 'ready' && Number(a.duration) < 15))) {
                const r = await fetch(`https://api.mux.com/video/v1/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE', headers: { Authorization: found.auth }, signal: AbortSignal.timeout(10000) });
                console.log('[Webhook] removed broken camera recording', found.slug, assetId, a.status, Math.round(Number(a.duration) || 0) + 's', r.status);
                return res.status(200).send('Broken recording removed');
            }
        } catch (e) { console.error('[Webhook] broken recording cleanup', assetId, e.message); }
    }

    // ── CAMERA BROADCAST ENDED → sessions per artist + vertical clips ──
    if (type === 'video.asset.live_stream_completed') {
        try { await processCameraRecording(data); }
        catch (e) { console.error('[camera-rec] failed:', e.message); }
    }

    // AI captions finishing no longer cut extra clips: vertical originals are cut once (api/_verticals.js)

    res.status(200).send('Webhook handled');
}