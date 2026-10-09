// Mux live streams for a venue (one per camera). Stream keys are never returned.
export async function listLiveStreams(muxAuth) {
  const res = await fetch('https://api.mux.com/video/v1/live-streams?limit=100', {
    headers: { Authorization: muxAuth },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Mux live-streams ' + res.status);
  const { data = [] } = await res.json();

  const streams = data
    .filter(s => s.status !== 'disabled')
    .map(s => ({
      id:          s.id,
      name:        s.passthrough || '',
      status:      s.status,                       // 'active' while the camera is sending video
      playbackId:  (s.playback_ids || []).find(p => p.policy === 'public')?.id || null,
      activeAssetId: s.active_asset_id || null,
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
