// Mux live streams for a venue (one per camera). Stream keys are never returned.
// includeDisabled: also streams switched off between sessions (the camera page's own cameras: closed until a set
// or Record now, they still exist and must not read as missing), shown with status 'idle'
export async function listLiveStreams(muxAuth, { includeDisabled = false } = {}) {
  const res = await fetch('https://api.mux.com/video/v1/live-streams?limit=100', {
    headers: { Authorization: muxAuth },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Cloud Storage live streams ' + res.status);
  const { data = [] } = await res.json();

  const streams = data
    .filter(s => includeDisabled || s.status !== 'disabled')
    .map(s => ({
      id:          s.id,
      name:        s.passthrough || '',
      status:      s.status === 'disabled' ? 'idle' : s.status,   // 'active' while the camera is sending video
      disabled:    s.status === 'disabled',
      playbackId:  (s.playback_ids || [])[0]?.id || null,   // public or signed (pages sign through /api/media)
      activeAssetId: s.active_asset_id || null,
      recording:   !!s.new_asset_settings,          // saved as an asset when the broadcast ends
      createdAt:   Number(s.created_at) || null,
    }));

  // When a stream is live, its recording asset was created when the broadcast started.
  await Promise.all(streams.filter(s => s.status === 'active' && s.activeAssetId).map(async s => {
    try {
      const r = await fetch(`https://api.mux.com/video/v1/assets/${s.activeAssetId}`, {
        headers: { Authorization: muxAuth },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) s.liveSince = Number((await r.json()).data?.created_at) || null;
    } catch (_) {}
  }));

  return streams.map(({ activeAssetId, ...s }) => s);
}
