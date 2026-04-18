import Mux from '@mux/mux-node';
import { put } from '@vercel/blob';

const mux = new Mux({ 
  tokenId: (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim(), 
  tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim()
});

const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

// MASTER uploads have no " // " in passthrough (e.g. "DRAKE")
// Sub-assets have " // " (e.g. "DRAKE // AUDIO", "DRAKE // SOCIAL // 01")
function isMasterAsset(passthrough) {
    if (!passthrough) return false;
    const pt = passthrough.toUpperCase().trim();
    return pt.length > 0 && !pt.includes(' // ');
}

// ── 1. AUDIO EXTRACTION ──────────────────────────────────────────────
async function createAudioAsset(assetId, artistName) {
    const tag = artistName + ' // AUDIO';
    console.log(`[Audio] Creating: ${tag}`);
    const result = await fetch('https://api.mux.com/video/v1/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
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
async function createSocialClips(assetId, artistName, duration) {
    const clipCount = Math.min(Math.floor(duration / 30), 5);
    if (clipCount < 1) {
        console.log('[Social] Video too short for clips');
        return;
    }

    // Request AI subtitles so highlights can supplement later
    try {
        await mux.video.assets.createTrack(assetId, {
            type: 'text',
            text_type: 'generated_subtitles',
            language_code: 'en',
            name: 'Internal_AI',
            passthrough: 'AI_Tracker'
        });
        console.log('[Social] Requested AI track for future highlights');
    } catch (e) {
        console.log('[Social] AI track skipped:', e.message);
    }

    // Create evenly-spaced ~45s clips immediately
    const segDuration = Math.min(45, duration / clipCount);
    const gap = (duration - segDuration * clipCount) / (clipCount + 1);

    for (let i = 0; i < clipCount; i++) {
        const startTime = gap * (i + 1) + segDuration * i;
        const tag = artistName + ' // SOCIAL // ' + String(i + 1).padStart(2, '0');
        console.log(`[Social] Clip ${i + 1}/${clipCount}: ${tag} @ ${startTime.toFixed(1)}s`);
        try {
            const result = await fetch('https://api.mux.com/video/v1/assets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
                body: JSON.stringify({
                    input: [{
                        url: `mux://assets/${assetId}`,
                        start_time: startTime,
                        end_time: Math.min(startTime + segDuration, duration)
                    }],
                    playback_policy: ['public'],
                    passthrough: tag,
                    static_renditions: [{ resolution: 'highest' }]
                })
            });
            const data = await result.json();
            console.log(`[Social] Created: ${data.data?.id || 'error'}`);
        } catch (e) {
            console.error(`[Social] Clip ${i + 1} error:`, e.message);
        }
    }
}

// ── 3. THUMBNAIL GENERATION ──────────────────────────────────────────
async function createThumbnails(assetId, artistName, playbackId, duration) {
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
                headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
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

    const { type, data } = req.body;

    // ── ASSET READY ──────────────────────────────────────────────────
    if (type === 'video.asset.ready') {
        const assetId = data.id || data.asset_id;
        const passthrough = (data.passthrough || '').toUpperCase().trim();
        const duration = data.duration || 0;
        const playbackId = data.playback_ids?.[0]?.id;

        console.log(`[Webhook] asset.ready — id:${assetId} pt:"${passthrough}" dur:${duration}s`);

        // Set asset name = passthrough + date
        try {
            if (passthrough) {
                const d = new Date((data.created_at || Date.now() / 1000) * 1000);
                const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
                await mux.video.assets.update(assetId, { name: passthrough + ' — ' + dateStr });
            }
        } catch (e) {
            console.log('Title update failed:', e.message);
        }

        // ── AUTO-PIPELINE: only for MASTER assets ────────────────────
        if (isMasterAsset(passthrough) && duration > 10 && playbackId) {
            console.log(`[Pipeline] MASTER "${passthrough}" (${Math.round(duration)}s) — generating audio + clips + thumbs...`);

            const results = await Promise.allSettled([
                createAudioAsset(assetId, passthrough),
                createSocialClips(assetId, passthrough, duration),
                createThumbnails(assetId, passthrough, playbackId, duration),
            ]);

            for (const r of results) {
                if (r.status === 'rejected') console.error('[Pipeline] Failed:', r.reason?.message);
            }
            console.log(`[Pipeline] Done for "${passthrough}"`);
        }
    }

    // ── AI TRACK READY → supplement with highlight clips ─────────────
    if (type === 'video.asset.track.ready' && data.type === 'text') {
        const assetId = data.asset_id;
        console.log(`[AI] Track ready for: ${assetId}`);

        try {
            const asset = await mux.video.assets.retrieve(assetId);
            const passthrough = (asset.passthrough || '').toUpperCase().trim();

            if (!isMasterAsset(passthrough)) {
                return res.status(200).send('OK');
            }

            await new Promise(r => setTimeout(r, 3000));

            let highlights = [];
            try { highlights = await mux.video.assets.getHighlights(assetId); } catch (_) {}

            if (highlights?.length) {
                // Count existing SOCIAL clips
                const allAssets = await mux.video.assets.list({ limit: 100 });
                const list = Array.isArray(allAssets) ? allAssets : (allAssets.data || []);
                const existingCount = list.filter(a =>
                    (a.passthrough || '').toUpperCase().startsWith(passthrough + ' // SOCIAL // ')
                ).length;

                const toCreate = highlights.slice(0, Math.max(0, 5 - existingCount));
                console.log(`[AI] Creating ${toCreate.length} highlight clips (${existingCount} exist)`);

                for (const [i, clip] of toCreate.entries()) {
                    const num = existingCount + i + 1;
                    const tag = passthrough + ' // SOCIAL // ' + String(num).padStart(2, '0');
                    try {
                        await fetch('https://api.mux.com/video/v1/assets', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
                            body: JSON.stringify({
                                input: [{
                                    url: `mux://assets/${assetId}`,
                                    start_time: clip.start_time,
                                    end_time: clip.start_time + Math.min(clip.duration || 45, 50),
                                }],
                                playback_policy: ['public'],
                                passthrough: tag,
                                static_renditions: [{ resolution: 'highest' }]
                            })
                        });
                        console.log(`[AI] Created: ${tag}`);
                    } catch (e) {
                        console.error(`[AI] Clip error:`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error('[AI] Error:', e.message);
        }
    }

    res.status(200).send('Webhook handled');
}