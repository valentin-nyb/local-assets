// Cameras stay live all the time (so Camera Control shows them running), but only sessions are kept.
// A session is a calendar set the camera follows, or one made with Create a session / Record now.
// When a session opens or closes, the current broadcast is ended, so each session is its own recording;
// the times are logged per stream, and a recording that falls outside every session is deleted
// (api/_camera-recording.js).

const openKey = streamId => `cam_sess_open:${streamId}`;   // when the session on now started (ms)
const logKey = streamId => `cam_sess:${streamId}`;         // past sessions: JSON { from, to }
// Set once the stream is run this way; recordings from before that are kept as they were
export const managedKey = streamId => `cam_sess_v1:${streamId}`;

// Ends the broadcast in progress: Mux saves it now, and the camera reconnects into a new one
async function cut(auth, streamId) {
  await fetch(`https://api.mux.com/video/v1/live-streams/${encodeURIComponent(streamId)}/complete`, {
    method: 'PUT', headers: { Authorization: auth }, signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

export async function inSession(redis, streamId) {
  return !!(await redis.exists(openKey(streamId)));
}

export async function openSession(redis, auth, streamId) {
  await redis.set(managedKey(streamId), '1');
  if (!(await redis.set(openKey(streamId), String(Date.now()), { NX: true, EX: 2 * 86400 }))) return false;
  await cut(auth, streamId);
  return true;
}

export async function closeSession(redis, auth, streamId) {
  const from = Number(await redis.get(openKey(streamId)));
  if (!from) return false;
  await redis.rPush(logKey(streamId), JSON.stringify({ from, to: Date.now() }));
  await redis.lTrim(logKey(streamId), -100, -1);
  await redis.expire(logKey(streamId), 30 * 86400);
  await redis.del(openKey(streamId));
  await cut(auth, streamId);
  return true;
}

// Seconds of this recording (startMs–endMs) that were inside a session; null for a stream not run this way yet
export async function sessionSeconds(redis, streamId, startMs, endMs) {
  if (!(await redis.exists(managedKey(streamId)))) return null;
  const list = (await redis.lRange(logKey(streamId), 0, -1)).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  const open = Number(await redis.get(openKey(streamId)));
  if (open) list.push({ from: open, to: Date.now() });
  return list.reduce((sec, w) => sec + Math.max(0, Math.min(endMs, w.to) - Math.max(startMs, w.from)) / 1000, 0);
}
