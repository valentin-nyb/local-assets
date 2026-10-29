import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail, venueChoices, freshVenues } from './_venues.js';
import { signWebToken } from './_venues.js';

export default async function handler(req, res) {
  await freshVenues();
  const oauthCookie = parseCookie(req.headers.cookie || '').la_google_state || '';
  const [expectedState, intent = 'admin', devPort = '', appChallenge = ''] = oauthCookie.split('.');
  const clearState = 'la_google_state=; Path=/api/google-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  try {
    const { code, state } = req.query;
    if (!code) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=google_failed' : '/login.html?error=no_code');
    }
    if (!expectedState || !state || state !== expectedState) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=google_state' : '/login.html?error=auth_failed');
    }

    // Exchange code for tokens with Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  'https://local-assets.com/api/google-callback',
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.id_token) {
      console.error('[google-callback] no id_token:', tokens);
      return res.redirect('/login.html?error=no_token');
    }

    // Decode the JWT payload to get email (Google already verified the signature)
    const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
    const email   = payload.email?.toLowerCase().trim();
    if (!email || payload.email_verified !== true) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=no_email' : '/login.html?error=no_email');
    }

    if (intent === 'client') {
      const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
      await redis.connect();
      try {
        let clientId = await redis.get(`client:email:${email}`);
        const allowedEmails = (process.env.CLIENT_EMAILS || '').split(',').map(value => value.toLowerCase().trim()).filter(Boolean);
        if (!clientId && allowedEmails.includes(email)) {
          clientId = 'cl_' + crypto.randomBytes(12).toString('hex');
          await redis.hSet(`client:${clientId}`, {
            id: clientId,
            email,
            name: payload.name || email,
            createdAt: new Date().toISOString(),
            status: 'active',
            assets: '[]',
          });
          await redis.set(`client:email:${email}`, clientId);
        }
        if (!clientId) {
          res.setHeader('Set-Cookie', clearState);
          return res.redirect('/client.html?error=not_registered');
        }

        const profile = await redis.hGetAll(`client:${clientId}`);
        if (!Object.keys(profile).length) {
          res.setHeader('Set-Cookie', clearState);
          return res.redirect('/client.html?error=profile_missing');
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        await redis.set(`session:${sessionToken}`, clientId, { EX: 7 * 24 * 3600 });
        res.setHeader('Set-Cookie', [
          clearState,
          `la_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
        ]);
        return res.redirect('/client.html');
      } finally {
        await redis.quit();
      }
    }

    // Check if email is authorised
    const venue       = findVenueByEmail(email);
    if (!venue) {
      console.error('[google-callback] unauthorized:', email);
      res.setHeader('Set-Cookie', clearState);
      return res.redirect('/login.html?error=unauthorized');
    }

    // Sign a short-lived webToken (no Redis — pure HMAC)
    const venueSlug = venue?.slug || '';
    const webToken  = signWebToken(email, venueSlug, venue?.member?.owner);

    const sessionData = JSON.stringify({
      email,
      webToken,
      name:     payload.name    || '',
      picture:  payload.picture || '',
      // An artist with access sees their own name at the top, not the venue's or label's
      venue:    venue?.member ? venue.member.name : (venue?.name || 'Admin'),
      venueSlug,
      venues:   venueChoices(email),
      role:     venue?.role     || 'admin',
      // An artist with access to a venue's or label's account (only their own sets, Calendar, Brand Kit)
      member:   venue?.member   || null,
      ts:       Date.now(),
    });

    console.error('[google-callback] web login OK:', email, 'venue:', venueSlug);

    res.setHeader('Set-Cookie', clearState);
    // Local development: the session goes to the dev server on this computer only (in the URL fragment,
    // which is never sent to a server)
    // The Mac app: park the session for two minutes under a one-time code and hand the code to the app.
    // Only the app that started the sign-in holds the secret that collects it.
    if (/^[A-Za-z0-9_-]{43}$/.test(appChallenge)) {
      const code = crypto.randomBytes(32).toString('base64url');
      const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
      await redis.connect();
      try { await redis.set('app_signin:' + code, JSON.stringify({ challenge: appChallenge, session: sessionData }), { EX: 120 }); }
      finally { await redis.quit().catch(() => {}); }
      const link = 'localassets://signed-in?code=' + code;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(appHandoffPage(link));
    }
    if (/^\d{4,5}$/.test(devPort)) {
      return res.redirect(`http://localhost:${devPort}/__dev/session#` + Buffer.from(sessionData).toString('base64url'));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><body><script>
      try { history.replaceState(null, '', '/login'); } catch (e) {}
      localStorage.setItem('la_admin', ${JSON.stringify(sessionData)});
      ${venue?.name
        ? `localStorage.setItem('la_venue_name', ${JSON.stringify(venue.name.toUpperCase())});`
        : `localStorage.removeItem('la_venue_name');`}
      localStorage.removeItem('la_revenue_cache_v2');
      // Back to the page that asked for the sign-in (login.html?next=…, e.g. /download), else the dashboard;
      // only a path on this site
      var next = ''; try { next = sessionStorage.getItem('la_pending_next') || ''; sessionStorage.removeItem('la_pending_next'); } catch (e) {}
      window.location.href = next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charCodeAt(1) !== 92 ? next : '/dashboard';   // 92: a backslash
    </script></body></html>`);

  } catch (e) {
    console.error('[google-callback] error:', e.message);
    res.setHeader('Set-Cookie', clearState);
    if (intent === 'client') return res.redirect('/client.html?error=google_failed');
    return res.redirect('/login.html?error=server_error');
  }
}

function parseCookie(cookieHeader) {
  return Object.fromEntries(cookieHeader.split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

// The favicon inside the page: opening the app link straight away cancels a favicon still loading,
// which left the tab with the browser's blank globe
const FAVICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHN0eWxlPi53e2Rpc3BsYXk6bm9uZX1AbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKXsud3tkaXNwbGF5OmlubGluZX0ua3tkaXNwbGF5Om5vbmV9fTwvc3R5bGU+PGltYWdlIGNsYXNzPSJrIiB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHhsaW5rOmhyZWY9ImRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCxpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBSUFBQUFDQUNBWUFBQUREUG1ITEFBQVJKVWxFUVZSNG5PMWRmWXhjVlJYL3ZkbFpsKzF1bDM1c29XV2h4VUlySWpTMWZCY0JQMEFFb1JFeGdpaEdRMFJFamFoUlNZeWl4R2o0eDJqaVIxQ00vZ0VDYXVJSFNGSTBoZy9sMnlvdEJOQlNLS1Y4ZEx1c0Z1aTJ1enZ6ekVsK0p6bTV2cG4zM3N5YmVmZk52cE84dkpuZG1UZjMzdk03NTU1Nzdqbm5CaWdlQmM3cmtGY2NWUUVNQWpnZXdDb0Ewd0JtQWZRQjJBZmdTUUNiRXo2clVidTBQV2pqT2JrTlpoSGEyR2hRK3dFY3dQc0lnR0crUGhEQUtJQ0RBY3pqWjFid2J6VUFkVDUvQnNBdUFNOENlQm5BYmdBdkFOalA1OWpmbGUrOUJtQVBYd2Y4WEsxQnU3MEdncThBVUdrQ21XU3BRbWtXUmc4Qk9JUlN2WXp2andRd1JtWXZBYkRBU0diUXBOOTE4M3hoOERZQS95VndMQk5GY3p3SDRDbStEZ2lhWjNpOVNJMWl2eVBQUkFwdE5XY0JZRldva2pCN09kWDIwUUJXQWxnS1lERlYrbnkrbmtkMUxpRG9OTTBTSkNyMVV3RDJBcGlrRnZrM2dNY0JiQUh3UkFTSW8vbzVad0dnMGw0M0RGOUU2VDBNd0RGay9Kc0FITVgveFZIWVlwL0RGRzJPQThoV0FQOEE4QkJ0aTUzVURuc2luaEhPTlFDNFRGZGFEZUJVQUdjQVdFOFFESEFlRm1CRXFkRWdwejZGVGY2bUtuK0dXbUtHbXVFMkFQY0FlQVRBaFBsZWJtRElBd0JXL2NucnR3STRrZEw5WmdDSDAxQVR4cnRrNTNHZktlVGRiZXNFZ2JDTlU4VFRBQjZtUFpITEZOSE53YXdZNlJVRDdWQUFwd0M0R01DN0loamVUTXFMUktGNUhRV0lPd0g4aGxwaG5QYUVPMTRkbzI0TXJMc2Nrdm44TWdEdnBnVS9RdlhlS3d4dlJpNHpkUWs2U2Exd0g0Qy9BTGdMd092bU0xSGZ6WVE2UGRCV2xiMEZ3RmxrL0dsY3F4ZE50V2ROYnI5RitoOERjQyt2ZjNMS0tJeGZBYWF4YWdqSnN1d2NxcnE2VVdzMTUvMWN2dW9jRC91My93QzRpVWF4blI0cnZndUxiZHhhQURkeVhUeHRPcHYzZ1B0NjFjMFYwcmNnUzhoZjBsWVMyOGxyVXFtWFpkczdBR3lNNkdEZWcxeVVxKzY4L3hlQXF3R3NNMER3U2hOb1kwUmRYUTVnQnh0ZWkxQnY1WVhFWTJESGI0b09wczhZWWZNQ0JOcUlOUUN1QTdDOWxIaDBVaVBJWHNTWDZBYTM0NThMNlkrTEErZTNCcTJsdWtkSFFLRGoreXFBenpkd21IV2QrUXNCZklOclYxVmJwWnBIeDhaQXgxY2NSMTgxYnZLdWF3TDl3WTl6Lzd5VWZIUWRCT0pPUHJsVkFGVGFaSDVJaDg0RjNJL1hBSXVTT2s4Ni9oTDdjQ1czeWNPMDQ5OE9BRUorLzNTNmQxUC9lRW1acmJvdTVINksvWHRIQWFEZUtFSGRGZHpZc1ZFOEpYVlhDOHlqZTMwb3JSWnVWd1BJTnU2WlJLRzhMeWsvT2dIQWVZeUtDanNKQUEza1dFajFMMkZacGZyUFh3dElMT1JGREtMUnYzZE1Bd2pLUHNEZHZTSlNVa3U3U0ZTbG0xaU04WTRCUU5FbUVUdVh0bXA1ZHBtaW1Cb2t2RkF3TUloV2ZtT2FMNmdESVFucGdJeHkyU0doMkw1VEZEaGxWL0lWT3EwbUdaV2pTU0lWUmhpUG1zQlVOMTdQWjdBUGNBZDJJL3NYRzFxV0JnRGd3MlRKOFVtUDUzNlYyTUJFM014d0kwV2NWWTh5QzJpY1VUalBjZHQxaGxQYllReE9QWUtEZVRRVFM0YU1nZVZibndPekM3dU9rZFFQSnZsaVVnQW9rbVIrZVErZFA3NE5oS3ZlUVFiL2tZR1gyNW45bzlJL1E4bDNTVUR5ZHdKOGhKcEFBTEVCd1BsVXN6NlMrbVdPNEpVcEFFSitWcGgvcklkem9nWGpUcnBISlFqbGJnQi9BdkJTZys4RkRmNCt5ODJXVi9tOExZengzMHpqVjZUc0RSNEtBYWlweEMrQXJQaGs1LzdyellhUEw3dDkybzVwU3ZvVmRJOVdJMExVMUlHVnhHa1ZPTit6NiszZmViamhwZU1nTnMxVlNabWJ4Z2FRS0pTRFBJeEdDYWpxSld6cUQ1VFdmZVovclZyeW9YUFhad25JcnVYN3M2a0o3UC96SXAybUZ6TEhvczhrcjRaWkFNQ241WkJGdmN6WFB3RndDNDI1VGtYUWhrWWpiQ0lJaHVpRDkybGNLalJrcXhFWnkyMzdBWHpvcUdYRUhRQStCdUFYWkw2cStFNkJOU1RvS2dUZXIvaTczaVI3a3R5VXUwd0FvQVVXMnRrL3lJcjVvdUp2QmZBMUx1bjA3em9QZG9NQzV2bmRRNk14N3luQTBtelNjYWlrZk9oVUduUmxUTm9oTVVKdkFQQnBXdVZkU2FGeVNJRW1xNDJiV1ZBQ0htbUJ4SHhOQTRCWG1Pb3M2K1J1ZDlZNmRuNUF5WjlnKy9NQ1pJVytoUHZwVWRSMkZvb3FLUVovaWxiMk0xMldPUDE5a2Z5ZkFmZ2VzMmJ5WkQ1TS8zYzM4VE40VDJrMFFNQnFGdzhaSTh6NkFyS2dxSFd0MXVENU1ZRFBjYkNqYWd2a1JYc1pxKytqVXloVFQ2QjI3bnF1TlMrS0tNZGlnUkEzR0M1b1hPZU12bjZRUzd5YmttNXdkSmxxZERGUG1YcENoUUZDV2o5QVFCZnIxU3gzOGw3dW5vMnc4LzNPNTZNR3c4N25sdXEwN3FjNXFLOXlxZlZUN203QlErWnJtNm81cjQ1YXBsWjJBd1B1cEYxTDVxeGtXUEo2N3B6Tk00Q0lrZ1RycEpua3RZK0Eya3JqYmlzTEp1eGdwUzVmbVE5NjNKYlNRMW9vNlc4RkFEQ2RuT1lPMjNZeWF5T0RRdzhnQU1ZSUFyR1UzUUdiSnVQSEtlbjYva1hPcVJNUnpQYVIrYUFyV0FwZFlLNEF3RlhqSVptNGlWZFdsTWY2UGcxcDM3Vk1YU0dwVlFEQVlVNlU4UmJIdUdhZjAxV0F6eFFTcEd2VEJtTDJDZ0FzV1NZbWxWaGZKVHVOZGxySjZDaUpHSnJUQUpoTEZQQWVNa0RtWEk5RHhXS3BCRUE2c2p1TjcyUHdTV0daTDFRQ0lKNlVzZXA5REJnRGNCMWpCUXZMZktFU0FOSGtob0xydlkvNUVGL29CZVlMbFFDSVpuam9yUE5YTU5KV1NyWmRVcENFbURrRGdFWk1pR05PdmNtS3BNcjF2VGl6VHFMTCsyMW11ZGNUekM4cUFGei9RZGpHTWpNd01YU3I2TkhUWXRWampJUWVaVDVFZjY4eHYyZ0FpSEljOVZORkQvTmVaK1RTSUwxekEzeHZ2MS9uNTFmVGJkMW56aU00bENEUVNOOGttMWlGSmg4QjRBNXdWS3pmR0dzUGoxRTZqNktrN3VlVzhSai9ObWoySXV4eis4amtnTy90ZVFSUlhzNmVZN3hQQUlqYUxuYmY5N0VHNFNtVVZGWFJJOFlYcjVrNnRUYjNPTkRMRFBjQkFPN2cxaVBhZEFBWk9zUmtGUEczdjcvQnVRS3VpblpMenlkdEUrWUswL01DUUtNc25TcjMwMGZKN0tONWlzZ0tudmcxbjljaWFvS29HamlOb29sSzhnQUFicUxHQ0szdXczbGZUdU5ySWE4VmZOOXNCNjZrQWdEQUJvMkNsdmM2cnFmUDRQcDZwSW0wMWlQVWN5blpCUUNBU3J3eWNEMUx4Ni9sb1ZCTHFPNHJNUUdscGFRWEVBQXE5ZjIwMXM5Z1lZWFR1Q1N6NUFhVGxOS2RIU1hXbHRVT1NMMHcra09zWkwyS1lGQmdsT3E4TzVRNGxLNmFJZlA3ZUNEVUJ0NVhPZzBxVlhyM2FEWnBTRjAxQXpWVHB6RjNBZk1GeEFNM0o1MHFIdEVnL1NqcUJzK2NMRU5YTWx0WFE3bnRvVWZsaGE2T2daYXRlWVFHTitJMGI3VU5sVDlJSSs4eWhrZXBCNjZVOXZ4SXgzNHdhVFd6YW92TUYvWHlVUUJmTm5OOXlYeC9hSlliWTVsWENnM3BraFdwL3hUTGt2YmtObWtQVUthckFHdnBYMFRKSDUxalVoODY3MzN2ZCtaK2dEN3V5RjFKNW11eHBGNlhsTENCaHJQWno3NkRvUzBBcUJObk5jK3FPNmJnekhkZHprSE01L1gvcjdFYVNJVUNZTE9mQzZzSjR3Q2c2L3dCU3Y5eDV1OUZsVzdiOXBrR0VVTTFwcXpQTUQzOWFSYWdmSjVqZGhpamhGZlJEaXBjWVlpMFU4QUcxdU9yRktDamNWVktKbG5SWTU5SmI3ZGpJZmM5UEt2M2FkWUszc1cwZFMwSFY2V0xlem1QelBzRVl4WjhINXRVQUxCTHZnMDhrc1RuRGtiTng3dFlEbjRucitkNVRYS1p0SXNPTEJod1YxbnVaU0tpdG9HU2xwOS9qQmxDTzVna2VwVG5ZOVFTQUVaTklvU1BuZE4ycWEyaWFuc0xpemplVDBhOTNFTEtlY1g4aHQ3ZHlLTmRyRndtV3VPN0FBNzBkSnhTQTBBN3ZaWWhXNEhuVWk4cS9VNldoOTlDMWI2YnhwdFNtajZFRFFEanBzSXI4RzduS1dxWEZHazZpQU9Bb1BtZEppUEdGN0liVGFMYW53THdWd0MvYjFDbEpHblJpbGFvYmpUQjlZeDZPcUVYQUFCSy9xbWVJZHEyUStvRWY1K25sdTh5RE5iNVhEL2ZyV0lVajlNZUVBQVVndUlBc01UWjEvZUJBZzZ5bkE5d0cwdkoyZk1CR3FudWJ0QzBxUnZjRXdEUXhBdGZxTWI1L1ljc0VXL1R2cm9wNlM3WjMyMjBjaWdrQUlZYTVNbDFtMVNxNVF5Z3J3TzR6eGhnZVRJZUVUVU0zZGhIcnluT25ldWVtNWZubkMrSE5sMEQ0RzlOY2dienBxcG5Hck10QU14M0FCRGt5SHhaWS8rY2xyNjdOdmVKRHFIZnBDY0FvTWV2NUVYS2ZKbFRid1R3YXcvbStrYWtIdE8zTTdNSkhtak90Z0ZRUzNMb1VCZG9rc3dmZCtaYVh5Z3dTK2J6VFZwYjRRR3dJS0ljZkRkSkdiMlRYajFmQnpRdzZ2OUVrNlplK0ZXQW5wbUxuSTlrMlV6ZnZxK0RHaElFNjNJZXI4dzF3SEpxZ2J5TVAzQURaNHM1RDlBM0N0aldFM21vdHRZdThGVmJwYllCOHBhNlBRU0JPbnp5Yms4VTh5VXU0Q01BVHZmVVFHMFpBTE1lR0lHemRQUDZXRGs4NEgwSlU5MExtUmZoOHpJd3FwaVRUeFR5dm9hVlRlQnBPNXVTNzRHZHd4emNxbWNESEJBQVl2U2R4VnlKUXBMdkFGaE14NHFlV080TEJieExoUFE1bm0yWDl3UUFWTUswb0tORTNmcElSNXBzNkVKU25CR1k1MmFML3U0cWJrdkRJd2tMZVY5bXdPcEwyeklEd0E0ZTBlcURpMVdjTEw1UVFJWXZwbllxTkZWaXdwdGU4Z0FBTWcxY3pyTUo4ODVJQ3N6OXZDS0ZmaldpWm9PNTM1UG9sb0JPbGt2cGFZc3FGTm10ZG9EU3Y1NmdsT3dnRkZYOXh3SEFkYjdrYVF0VWVFRFRoV2F6cFp0K2lzQzA1WGhtUjU5Y1pNWW4yUXphNjhteDZEcm5TbkRxdHpqMzNzRE1IUHVaVGdFMU1NKzhnQ2VZbjFLUU5MbTJZd0luMnF5K25UVVRKQkh6aTF3VzNrNURkVStDZk1CV0VrY0Rzd29TUjgvWkxJSzFwb1hmOHBiaUdMdVhvYzU1QThDQ1lBVURReTltSnRDZm1jUTV5U05zMDFUR0NzeHJkeU5IWHg4TDRDb0dleXh4a2xJS1QzR00xZE85ZlhIRUtBam1NV1h0Y0phaDNVM203MkY3YXlaYjUyVWFzeTh3VVRRa1NNWWRzRlJZV0dtWVM4OWpXTzMwT0JwOWhUd2R2RjBBN0dhYXRCek80QXZaT1hsQnpGSk1QdmNLdGRnMkJwZlV1Y0o1aXYzYlR5QXNvMmR2RVJsL2toTVIxWFBNVDJvRGJPSWdEM3MwQ0hHNWZqWkZURS8yWHNwekNFQVE3S05tME5WT1A2VmNENnl3NldXRkxnUFREZ0FrRk90UnFsVUJnRzhVcEFCSTRFeGx3ekhQOWdYc3JWQml3TWJGQTRRRWdCWlJDQXM2RUJZUVNTNFVtUGxJRTVuVURBRDZBQzJUMGdzVUpMeUtUb2tUWkpQNDFlVVl0cTE4M1F1RE14ZW9talNHSWs0REtNTWZvTlhzWTJKR1NmOVBROHhUUUJ5L2t1NnNTZG1WTzB5VnJCSUVmdE9COUdNTXRRc0EzWFFSSS9BdVRnY2wrVXNxbkF1WXF4Q2JxRnBKOGVBbldKS2xKUDhwb0F0Ym81WGJBb0J1aUd4bmxxNjRWb1hLYWNCdjBsUFBNOU1BNGs2OUZjQzk1V3FnRURTUUpRQjBSU0FiS0RmVE42Qi9MOGt2c21GckI4ZGxlS2VOcnd1NEJmc2o3cjZWS3dLL2FSbHRnVXdBb05JdWxUZHY0VlNnZjUrcm1pQjBMdmV3ckR3cG9CMGdZZldaYVFDZENtUnYvU3UwQ1RRMkwrOE81MW1tTnVDbFl4RjRNaVpWazdMZThBTnBTWDBERWpiK1RhWkZuY2xnemJ6RHRqdE5vY1A0L2RTSU05eGVucUlMZHBqam9rRWtlYm5STmJ1NkliVWE2cVdNZm9LSFIwbXc1b2VkUGZSZTJqc0llYmViUmJJYzNrZzMrVGpqRThjWlVMS0dKWGJQY1N6eGJtNHgyMUs1RGFtZFdEK056NWN3cTJ1NU1qamZuQ3BpRzFKRUlJUVJKZklrdXVoaEJzbHM0UUdOMjdsRVZ0ckdtb1ozRXlDbnNucllzVG1ra2ZVblBUK3dIYktkT1l0N0JoTlVQVnBscEc2cWp0WE02YUkrWFRXbmZTRmZUOU1GTHFGeDMyWmtjdFFZVk16bDFqZzRsL3NwVSthNWpkb1JablRWV0YzdDRxVE1hNGNzc3NlWU1YTWEwYi9HN0V3VmlWNGkwemRUbXAra3RPdnlOMG1JdVlhV0I4eHJrQk5XUDJ0cUNVWlJXc1BSTlRackJGM0EwMHkrdzhpdWhsL3VGQTB5Qm04TmQ2YkdUTlN0WnZmRWRiWkNRMnJFcElWbFFkcnYxOG5RR2tQZ0ozbC9rYWVNYktXcXR3a3lhYTE3RzQzVVQ0bjhJSVZrSWZ1bHdqT1FZUVQya3p6UDZJRWtqY3VTTFBJdEkvdTVUYm1ZSUZDVjE2d05mWXpGWDgzdlRXY3doOWJabGdEQU13Q2VwV3JlelREeS9SRkZNbTE1MmxhWGRoWTQ4eWtZNjJnMDZuTVBZcjJCSmFaR1U0WEN0TlJVYmFzNzdiSWFlSVpNdjRZN3VFMEJHK1FZdVp1RzNtQ1dtZTJTTG1OQnh0ZTcxQWY3VEgxZXYxT05mWUJNSGpUMlFFQmpmUkUxUnArSnl6aVltclZPNGRqTFE3RTIwUmhOMUpodWtKdHlsWVk2N1ZVTEdqQzYwNytaMVcrb0JsRS9oUDJOMk9mL0Q4SXgzQUloY0RxNUFBQUFBRWxGVGtTdVFtQ0MiLz48aW1hZ2UgY2xhc3M9InciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgeGxpbms6aHJlZj0iZGF0YTppbWFnZS9wbmc7YmFzZTY0LGlWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFJQUFBQUNBQ0FZQUFBRERQbUhMQUFBU2prbEVRVlI0bk8xZGFaQmNWUlgrVGs5UHdwQmtTQ0FKZ2JCSkNKdVFBbVNUVFZRUVVVaXhsU0NJaXBZZ1dCYnVVbHBpU1ZsbCtVUEZVbEVFbHgvS0lyZ2hVaFd4TEFRRUZBaEN3SUJnV01PU0VFSUNaSnZNSE9zMDM1M2MzTHp1ZmozOSt2VjlQZTlVZFhWUFQvZnIrKzc1enJubm5uc1dRY0ZJVmNYNzAxNnJpR2lLNzFVQkRBQTRHTUJjQUJzQWJBVFFCMkFkZ0VjQlBKVG1XZzNHVlJ0UGJXQmp2RTdlNUU5bTlBeXZONm1xMmc5Z0t3RDJQQWhnTWw5dkEyQTZnTzBCYk0zUDdNcjNoZ0dNY0E2R0FDd0Q4QlNBbHdDOERPQjVBT3Q1SGY5MzdYdXZBMWpOMS9iOTlTSXluRFR1MklFUUpRQThhYklKSEFuK1Z3RlFKYU1uQWRpUlVyMEQvOTREd0d3eWV3YUFxWjVrU29QN0h1RnpoUXhlQW1BVmdlTXowVFRITXdBZTQyc2hhSjdrNHdYVEtEN2pPZWJheTlnQUliRXhQcHdncXU1ZHFMYjNCYkE3Z0ZrQXRxTktuOExYVzFPZEd3ZzZUUnNKRWlmMWF3R3NBYkNTV3VSeEFJOEFXQVJnY1FLSXQ3alBjUXNBSisxdWtzandiU205T3dQWWo0emZDOERlL0YvVHk0N3hualdqZVRPQVBBSGdBUUQvTXRzQ3dGTFREaUt5T3UzUzFyTUFDSm51dmI4bmdDTUJ2QVBBRVFUQlJLN0RWZmV4Z0ZIU3BYdlNCdTg1bFQ5RUxURkV6ZkFuQUxjRHVFOUVWb3grcVl0Z3lCMEF2dnJqalI4STRGQks5ejRBZHFPaE5qSHA2ekZvclJUa21CaU9kUVdCc0lSTHhQOEEzQ3NpajNWcmljaHRNbWtJMVl3Z1ZUVURiU2NBYndkd0ZvQjNKekM4a1pRWGlkUjduUVNJdndDNDBiUUNnT1Vpc2phY3IwNE9ydU1URzI2SFZOWFc4NDhEZUE4dCtFR3E5MTVoZUNNS21lbTJvQ3VwRmU0QzhEY0F0NG5JRzNsc0p5VkhkZjlXQU1lVDhVZHpyejc2MFI1bWVpTUs3OXVrLzJFQWQvRHhieEY1cXBOQWtFNGJlYXBxMjdKakFId1d3SEhlYnpvbnpIaGtmRWpPc0hYR0kraUQrRE9BSzJnMHJ1L0UwaUFkbHZvREFId0J3R0UwN0p4WHJXUjZNb1hMNEZwdUowMHIzQVRnRHlKaWJ1dk1LRk5HR0RvcDljYm9vd0JjUXBVLytwR1MrYWtwbkN0ekx2MmNSdU4vREFoWjdCWXlBNEFiaktxYU5mOFJBRitqcGUrN1dFdHFuZno1VzBlSDB1VzJORkRZMmdLQlpNejhlUURPNGRiTzNMZWx4R2RIL2x3K0MrQUhBSDRpSXErMUF3TEprUG5td1BrZWdQbEVhOG44emhxTGRoWnhLVFZCelVBY0MxVXlZdjQwQUIvbGVsL3hMUHlTc2lYeDV0ZTIwVjh4STV2bkoyR3NSQ3JLYWwwK0JjRDUzdEZwdWQ1M2xod0lMSzdoWXp3T0gvT0YycFYrUStLcFBJOHZKVDgvY2pFT0Z2dHdrYXJ1VG41SUxnRGdqMVhvNURIM2Jybm01MHVPMGJick9wM25LZjc3blFPQU1aNUlzK0NNVDNLN1YzcjF1cWNGYk9rOTJyeXVibXVZaXdiZ01lNXhSR0VVRVM3am1BNEJjSktxOXJXeUpheU1jZTBmb2VWL0RNT3lTdlhmZlMxZ3NaQm5Nb2dtOVk1Z3JFdUF4ZDZkd2RPOUl1K250Y21qU0dSYndZTm9qQnRsRHdEUDQyUUhPK2ZTQm9oZCtwT1lLaWtmS0JnWVRDdS9wWlV2dURpN3B1UlVpcXJhM3ZPaWR2YWVPVklTT0MyVSt4VUFiekFRWTRXWEpGSmhoUEYwTHpEVi8zN3NZRGRiN0FCVlhXQUJKV2xjeEtrQjRHMzliTXR4UWNScnY1Tlk4U0p1aG5pMGFza2VEeklMYURtamNKNWhTTGQ5cG8rUnlCYWNPc2NtazF0Y1N5eVp4UC9IZU05dVBQMWNCaXlTK3A5cHZsaHQwZWxqNjh0NzZZYU1iU0pDOVE0eTJJSXE3Z1h3TkxOL25QUVBpWWhKZmtqUHErcjlCUGdnTmNHZVBPTTRtV28yUm5JZTJEbDhaQWNBTXI5SzV1OGY0WnJvZzNFcG8yM3QvUHp2QUc0VmtSY1R2NlRKbHJLSTJITHdHaDkydlVXcStnRGorOCtnbEUySVVBaEFUYlYxMnZDeHBnRHcxaEZMc1RxY1Z1Wm9FbVFFNUpnd1JQWCtNOGJmdjBSR2JwWnE1bzliR2t5UUJ3NFhpMmZhNUR1cWFuSDlYNlUyaVBITVkxSVFiNG1zYkFBTDVaN0paMFNFZkJ1SE1lY2FoazB0Y21GVFFTQmxTNENWVGVEd2N4anMvWHRWOVRMKzdnblVCRzRjM1NRbmxMWkU3VTJIMEhBelE3QVZBTVMwSFhKanNjTW5XNjkvQ3VBNkVWblRxUWhhNFVFTHc5NFdFZ1NUNklPUGFWNHFOR1NOdDV0bExDZFJxeXBNSTFMNU52WmJHSWZ3UzJPK082TXdablVpamw3ZXZPNElRV0RBK3cxM0VERXRpVWFicGR4bEJRQlhZS0VTQWZOTnhWOXZjWWNpWWx1Nm1uUWFjL0pLcWRJM3RjenRmR3lNWUFud3ljYVRhaDRxTFY1MGJTdm95cGpjRGRrVzdtb0FueEtSaHlpTnVlYmR5eWFnMlc3aldoYVU4TWZZYlVyTjExWUE4QXBUbmMyWmt2Zk4rbzZkSDFMeVY3Z3c5QnpITVVyOGJkdDUzRTJQWXUxdEZJd3FhWTBmSmkzZXhDb1llUnFFanZsdmNJdDN1WWk4MmszbWs5ejltL1FuK2htS1FLazFBRUd3bUZyQUQwN01FZ3orb1kyN2RxMEdENEFmQTdqWW5EcHV2VWNjdEliWk96RTZoVEwxQkxxYnU1Sjd6VE1UeXJHMGt1R2JsQ2tiVmdBRFhaclhBZmgxMmdPT25HbVlMdWExWGxCc1lZQ1EyZy9nTFFXUHErb2xMSWIwZnA2ZURmTG03VEFpNlZDbTNucnUwd2l0K3cyY1ZIUEQybGJyS2hGWlVQdGlmTXdINzZNYXFWZXdLWTNsTk5DWXNKeU9rS3NZRTNBNFM3cnNTeUE0UUNSSmd1K1NYY25IT2dMcUNSN1BQc0dDQ2MrS3lLcUltUStlRU02aWg3UlEwdDh5QUFJUWJPQUoyOU9xYXN4YXdPRFFyUWlBMlFTQldjcmhoRzBnNDVkVDB0M2ZMM0JOWFJFeU8xTG1nNjVnSzNTQmNRR0F3Q2FvZWNBc1B3M0FRajR5b2J4S3BMUkJ6dnZueXRRVmtzWUVnUENBSmFGOGErM3RacGVvOXpubmNrWGNwQVRwQVM0UXMyalMzeFlBZkFxa05LM0V4aXJacWJVVDdaOExHREZVU0FBVTBuTHRKdW5tSjQwV0lQTStMemdFNDFJRGpCZlNUVHNSVS8rbk1Dc3ExampCVkZRQ29BbjVrVUZlMnBYRkFIeWJzWUtGWmI1UkNZQUVxbE82MWFTK2ova1FuK3NGNWh1VkFNQ1dEQTlLdlU5Z0lzd2MxakUrdXlBSk1lTURBQTF5NEJveXg5OW1TbktKK2lsMFpoMUdsL2RSM25hdko1aGZTQUNFOFg0TkhFV2E4bG9WeHRETnBVZlBGYXVlelF5aDZZeUU3dTgxNWhjS0FFbUJucXhIT0lGaDBQWTh3c2lsQVhybkxGV3FGaG9lVkNpZHpEVjhLMXJ4cmgvQlRnVEJoS1FoOUdJTmhHb0JWUG9Xc1g2cWF0SnB0WWRuVXpyM3BxU3VaK0RJYkw0MzRKMUYrTmZ0STVPRmYvdjlDTkFna2JUbnFCb2J3eE5VdXJPKzU3RzgvRjZlaWg3MGZQSE9HVFBjeG4ycEcwYXZNcnpyQUFpeWRKS2FRbFdwbWljdzRHUW0vZTJuMWVrck1QcFY3MnkrVmErY0JNL2pobklEUUwwc0hUSjhGbFg0VEs3SEIxTEtwMUxDcHpCSnM2OU9KYko2MFVRbGRSc0FZYUtHcWc3UzZ0Nk56N3ZRK0pyR3g2NzhPL0Z5NWZsRlFRRGdvblk5eGs5bVZ1MVJiQXBsKyt2QkJ0STZrcUNlUzhtT0hRQ2V4THMyY0JZcTlrNnU0L3ZRbVRJOTRTUXlEQ2d0VHlxTEJvQ2dYOEJlbFBUNWJCRXpFSDU4dkJ0Z0hhVFUyckthdGRTcnFqSDZnMndSWTk2MS9vUUMwcVU2N3l5bHp0Vm9Hd0JlK1pnK1ZndWZ6K2ZkZ3dHVktqMC9NdS9uU0VjQkVEU0dHbVRCNkV2b2dhdDloTStsdE9kUEEvU2pPRGQ0dGdBSUltTjJaOTM2VTdsWEQ5ZjJrdktubWR4T0wyNVd1NkRhaHNvZm9KRm5UU0JQOFR4d0plTzdSMjd1QjlKV002dU9rZm1tWGo0TTRFdmVXbDh5UHg0eTFiOCs4MHFoWlA2MmxQb0xXWmEwSjQ5SmU0Q3kyd1VFbHY2WmxQenA0MHpxTmZnNzl2dk8xZzlBNXAvR09zSFR1YzJvakFOSjBUb2FMaXhKVzBpcXR1RGRzd2lhTDdJT2JaR1pIN3FjcGNubjNmOWZaeldRQ2dYQXozNHVyQ2FzcG13T01aSFMvemIrU3dvczNmN1loK3BFREEwelpkMyt0NHJGb0JZQmVJNXp0ak9qaE9mU0RpcGNZWWhXbDRENXJNZFhoSWFRemFxVXJHUkZqM1V1dlQyWUMzdGVEZUMvWlB4U2ZuNk5WdzZ1U2hlM0hXV2ZCK0FUakZtSWZXN1NBeURZOHMxblM1S1liekJwUFY3R2N2QkwrWGlPajVYY0ppMWpRUXA0NEs2eTNJdlZLQWhyR3poeTVlY2ZWdFZ2czVYckJmU0N4anhITFdrQTUwR2E3aVZDeEhoemJsenV3TW1wN1VVczRuZzMyNisvMUdyS3ViNlpCZXgrSTZ5VnhMZkVRSFM1cXByVytDNkFiU0tkcDVZQjRGVHBBUXpaa3NpbGZoMWJxOTlLNXB0cWYxbEVYaC85Y0F2dDFLUk9qWUl3RmQ0clYzY3p1NmlkWGFUbG9DNEFpSFpEODd1OGpKaFl5RDl2TU5YK0dJQTdBZnpSQ2psdjhlRU9GSTkyNUxWd1g2YXFWekxxNlpEQ0E0QTBpL2x3TVNIYUg0ZlZDZjQrZ04vYmV1NkZuN24xZkl0Y3Z3N1RJN1FIREFDRm9HWUFtQkdjNjhkQXdrbStobzBoN3ZmN0EzU3p2SXlJYkZCVlZ6ZTRKd0RnRWk5aW9XR3U3ejlpaWZqUmppQjVGNHoyS2ZqZGVqdUhRZ0pnVXAwOHViekpsWTYxSGtDWEFyakxhMTdkOVVwaXVua053ekQyTVdwcTVzNE4rK1oxYzgyM3BrMWZGNUYvMU43TXVUOUFHdkxTeW9zUEFGV2RFZ0JBdXNoODIyUC9Ra1R1ZEh2em1CanYwWTcwbS9TRUJxaDBXZm9kODIxTi9SV0FHN2lkNjdyS0Q4bnptQjdMVUt6YTJ5ZzRBSWJUTkIzS2djeHRlNFBWSjZibkxTcm02eWJuMGl5Mmt0dXBWd0F3TmFFY2ZKN2tHTDJVOVloam5WRHgxUCtoUmFzWjJBZ0FybWR1TjhjMnhHNmRxOGJTK3k4blVvTHpvQzdQVitZQTJJVmFvRnZHbjlGTDNQZlgrZ0hHUnJwcCsyZVNmN3BYdXlCV2JkV3lEZEJ0aVZ0TkVOUWNQakd0LzdycHVOemlBajRFNEpoV1VyS0tBSUNORVJpQk5nWno4OFpZT1Z6NFBJT3A3b1hNaTRoNUc1aFV6Q2ttVWo3UFl5WU9JaDFuUTRvOXNITXlKN2Ztc281bEo2Q2IxTDhaZmNjekphNlFGRHNBdHFOanhYVXNqNFdFenhZaGZXSmt4K1U5QVFBWGp1WUtPbHJVYll5MGg1Y05YVWhxWmdTNjVvM2RJUGU3YzNrc2pZZ2tUUG04Z3dmV1dNYVdHUUFzNk9KVmRJOThGNnM1V1JEWityOGR0Vk9ocWRJa3ZPbkZDQUJneThENXFubzQ0Kys2dG13cGpWQStuMVNrMEs5NjFHZ3kxMGNTM1NKMHNweHJHVXBlMTQ1Y1NUY1BMTFhLWitjek84aU5zZWNBRURwZnVta0xWTmlnNlhRN2RuWFJRSGtCUVQzbXErckJ6STQrdk1pTVR4TVd2a1pWWTJpTDdvd3NDMDc5cG0wTlZmVnF0ck52MU9JbDgzQXZWYlV5T0JlemFIVVIwdVRhamdsYzBXYjE3YXhCWUltWW43ZHRvYXJlek43Q3E0TlM4cWtZa2dRVTNUTHJaOFFyaW5FQ2kyRE5DOFpWYUdyRzJEWHM2OXR0QVBnZzJKV0JvV2RaSnBDcS9wVkpuQlk0OHBxTEZHNjNWeEEyZFVYZEg4Qm5HT3d4bzllS1lEVmpyT3Z1SFlzanhvRmdhNmFzN2NZeXRCYUxiLzJMVjZ2cVNtb3QrK3d5bmlhYU1mczhFMFh0K3dhUzVUNVl1THVZeGwzSExIcjU5bUpLL0JGRjdRN2VMZ0JlWnBxME5XZUloZnl5WjFPYmJNWHNjNjlRaXkxaGNNa0lkemlQTVluRFhtK2tVOGM4ZTl1UzhZY0ZFVkU5eC95ME5zQkNUdkxraUNiQnI4eVJSTzc5aXRmWmV4YjdFSUFnV0VmTjRIWTcvWlJ5MTdCaU5MMnM2R1ZnMmdHQXBWay95R1hBQUJBYlNRc0FrV0FwbTl6azJyR0FmU3lVR3JDTjhnSXM3VmtKQUZkRVFRczZFVDRnMGp4UVlPYWpsY2lrUm80Z2R3RlhKcVVYU0ZJK2lrNHVsYTRwTmZXcmk0aTFZWHZDL2RuMjBFcktnNXdkTTNZQUJPVlE3bUVSaG9hRmgwdUtoaVl4VHdITitKWDJaTTNLcnR6aVZja3FRUkEzV1dXWC9WUjFValBYZUVNQXVFTVhFVEVqOERaMjVTd3BYbkxDT1pXNUNrMFRWVk5wQUM0RmkxbVNwYVQ0eWZpMXZ4ZXQzSllSNkhMd24yYVdycmxXamNwbElHNXlYYyt6MFFCVy93YkE5UUR1S0hjRGhhQ0ptUUhBN1FpWW9uMHRmUU5HcFJhSWoveUNIdHViSWRqb3d5M0YxOUVXc0dLTVYvRDByZHdSeEUwNzBCWm9Id0J1TzhIS205ZHhLVUFSRXlJekpBMGVMb3craGprUjJnRVdWcCtOQnZDV0FqdGIvekp0QXBkRDJPMGI3bWFaV3VIRHpZVkVNaWRWTDJXOTdnZGFJczgzOElpcWZvTnBVY2N4aWJQSWpTVFNVTmdseEdJSlh1ZXhzaDB2cjZVTGRqTG54UVdSZE11TjdyS3I2OUtZUXIxY2ZMNklMRmJWQ3htc2VVNXdobDc3S0hxRGxNLytZWkZ0aHhmUVRiNmNpVFRMR1ZBeWp5VjJUd3dzOFR5UG1OMllHMnFoYWdaRmtwOVIxY3U0TXpqWjZ5cmlENlNJUU5DRUVua1dYWFF2ZzJTc2NzbDk1aC9oRnRuUkVsVjlnRVV0RnhBSXg5SVl5enVOckw5Wi8wREpPR3o2ZURhTmR1RlVybkYwYUJURkNBajFYanRKSDJGODRSQ1B4RzhFY0pXSVBKblVSbmYweTE2dFlqYmJPb0h6Y2hTWEJiK1Jka2haelkzOXh1OEEvRlpFekdqdjNJOTUrWExDK01FNWJCbC9KTldoTzVrcUVyM0llTWlIS00yUFV0cGZDMFBQRzRTWXU1NUx3cndHNjdENmFhK1dZQksxYWppR3hxWUJ0by92V3plVGI0bklxa1pmN2dpeHRleUJCTUIrQklhTHVuV2wxSnJkYklVU00waHJOcXRTTWU2KzM2QS9ZNWdoOEN2NS9BSzdqRmdjeENJUmViRk9YZUJXczRyNkdjNytBUXJKTk42WFd4WW1aaGlCYllBOVQwVE1Sa0Z1QVBDUjc3MW5qT3puTWVWMkJNRklFMVVJSW5rR3MzRHRleHN5V0VOSE9CWUJZS3I4S1Zydkx6T00zQ3o3WVJFWlRtb2RNOWJNbzJDcG5FTEJPTWhydUswOHZObWI5K3hxTk5sdkR6Q28xVlZ0YzNQcnh1WGJGclpjM2NPNnlyYzFBNnprbEV6WjdyVW1lTnZNdGkvblRkemFScjBGT3RGcEpBQkNmMUNOZlNLWlBPQTVsWVRHK3JiVUdIMWVYTWIyMUt3akZJNDFiSXExVUVRc0RMNHA1WnBjT2NiZjdHaHRZTjNjZ0J2OW5SeCtNeXZoY0Jwa1haZ3ZtZWI2L3djSzByVm1PUUp0d0FBQUFBQkpSVTVFcmtKZ2dnPT0iLz48L3N2Zz4=';

// The browser page after signing in for the Mac app, in the login page's style: the wordmark top left,
// the message in the middle, a quiet footer. It opens the app straight away.
function appHandoffPage(link) {
  return `<!DOCTYPE html><html lang="en" style="color-scheme:dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>local / assets™ — Signed in</title><link rel="icon" type="image/svg+xml" href="${FAVICON}"><link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png?v=2">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--green:#39FF14;--bg:#070905;--fg:#fafafa;--mono:'JetBrains Mono',ui-monospace,monospace;--display:'Helvetica Neue',Helvetica,Arial,sans-serif;--col:min(100vw - 48px,420px);--gut:24px}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:var(--display);-webkit-font-smoothing:antialiased}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;overflow:hidden}
/* Dot grid that lights up around the pointer, as on the sign-in page */
.dot-grid-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
.wrap,.foot,.wordmark{z-index:1}
.wordmark{position:absolute;top:calc(env(safe-area-inset-top) + 40px);left:24px;width:184px;aspect-ratio:1328/165;background:url(/logos/White@2x.png) left center/contain no-repeat}
.wrap{position:relative;width:var(--col);display:flex;flex-direction:column;align-items:flex-start}
.eyebrow{display:flex;align-items:center;gap:10px;font:500 10px/1 var(--mono);letter-spacing:.24em;text-transform:uppercase;color:var(--green);margin-bottom:18px}
.eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
h1{font-weight:700;font-size:clamp(28px,8.6vw,44px);line-height:.96;letter-spacing:-.02em;text-transform:uppercase}
h1 span{display:inline-block;white-space:nowrap;transition:color .3s,transform .3s}
@media (hover:hover){h1 span:hover{color:var(--green);transform:translateX(6px)}}
.lead{margin-top:16px;font-size:15px;line-height:1.5;color:#a1a1aa;max-width:40ch}
.btn{position:relative;isolation:isolate;overflow:hidden;margin-top:36px;display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:54px;
  background:#fafafa;border:1px solid #fafafa;border-radius:999px;color:#0a0a0a;font:500 15px/1 var(--display);text-decoration:none;transition:transform .15s ease,border-color .3s ease}
.btn::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:inherit;background:var(--green);transform:scaleX(0);transform-origin:right center;transition:transform .42s cubic-bezier(.65,0,.35,1)}
@media (hover:hover){.btn:hover::before{transform:scaleX(1);transform-origin:left center}.btn:hover{border-color:var(--green)}}
.btn:active{transform:scale(.98)}
/* Open, then the a logo with its ™ */
.btn i{width:17px;aspect-ratio:420/467;margin-left:-4px;background:#0a0a0a;-webkit-mask:url(/logos/a-white-large.png) center/contain no-repeat;mask:url(/logos/a-white-large.png) center/contain no-repeat}
.btn sup{font-size:10px;font-weight:700;margin-left:-10px;align-self:flex-start;margin-top:14px}
.note{margin-top:16px;font-size:12px;line-height:1.5;color:#71717a}
.foot{position:fixed;left:0;right:0;bottom:calc(max(env(safe-area-inset-bottom),12px) + 18px);text-align:center;font:400 10px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#52564f}
@media (min-width:980px){
  h1{font-size:50px}
  .foot{bottom:32px}
}
</style></head>
<body>
<canvas class="dot-grid-canvas" aria-hidden="true"></canvas>
<span class="wordmark" role="img" aria-label="local / assets"></span>
<main class="wrap">
  <p class="eyebrow">Signed in</p>
  <h1><span>Back to</span><br><span>the app</span></h1>
  <p class="lead">a™ is opening your workspace. You can close this tab.</p>
  <a class="btn" href="${link}" aria-label="Open a™">Open<i aria-hidden="true"></i><sup aria-hidden="true">™</sup></a>
  <p class="note">Nothing happened? Press Open a™.</p>
</main>
<p class="foot">© 2026 local / assets LTD</p>
<script>
  // The address bar shows the site, not the long one-time sign-in address (it can't be used again anyway)
  try { history.replaceState(null, '', '/'); } catch (e) {}
  addEventListener('load',function(){setTimeout(function(){location.href=${JSON.stringify(link)};},150);});
        // Dot grid that lights up around the pointer, as on the home page hero
        (function () {
            var canvas = document.querySelector('.dot-grid-canvas');
            if (!canvas) return;
            var ctx = canvas.getContext('2d'), dots = [], mouse = { x: -1000, y: -1000 };
            var SPACING = 45, DOT_SIZE = 1.1, GLOW_RADIUS = 120, ACTIVE = '57, 255, 20';
            function init() {
                canvas.width = window.innerWidth; canvas.height = window.innerHeight; dots = [];
                for (var x = SPACING / 2; x < canvas.width; x += SPACING)
                    for (var y = SPACING / 2; y < canvas.height; y += SPACING) dots.push({ x: x, y: y });
            }
            function draw() {
                var idle = '#141a11';
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                for (var i = 0; i < dots.length; i++) {
                    var d = dots[i], dx = mouse.x - d.x, dy = mouse.y - d.y, dist = Math.sqrt(dx * dx + dy * dy);
                    ctx.fillStyle = dist < GLOW_RADIUS ? 'rgba(' + ACTIVE + ',' + (1 - dist / GLOW_RADIUS) + ')' : idle;
                    ctx.beginPath(); ctx.arc(d.x, d.y, dist < GLOW_RADIUS ? DOT_SIZE + 0.5 : DOT_SIZE, 0, Math.PI * 2); ctx.fill();
                }
                requestAnimationFrame(draw);
            }
            window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
            window.addEventListener('touchmove', function (e) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }, { passive: true });
            window.addEventListener('touchend', function () { mouse.x = -1000; mouse.y = -1000; });
            window.addEventListener('resize', init);
            init(); draw();
        })();
</script>
</body></html>`;
}
