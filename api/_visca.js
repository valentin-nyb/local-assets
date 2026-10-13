// OBSBOT Tail 2 remote control: VISCA commands (Sony VISCA over IP, UDP 52381), from OBSBOT's
// published command list. Only these commands can be sent; the venue relay passes them to the camera.

const hex = s => s.trim().split(/\s+/).map(b => parseInt(b, 16));
const nib = (n, digits) => Array.from({ length: digits }, (_, i) => (n >> (4 * (digits - 1 - i))) & 0x0f);
const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

const DIRS = {
  up: [0x03, 0x01], down: [0x03, 0x02], left: [0x01, 0x03], right: [0x02, 0x03],
  upleft: [0x01, 0x01], upright: [0x02, 0x01], downleft: [0x01, 0x02], downright: [0x02, 0x02], stop: [0x03, 0x03],
};
export const FRAMING = { none: 0, closeup: 1, halfbody: 2, knees: 3, fullbody: 5 };

// cmd: { type, ... } from the dashboard → VISCA payload bytes, or null when it isn't allowed
export function viscaFor(cmd = {}) {
  switch (cmd.type) {
    case 'move': {
      const d = DIRS[cmd.dir];
      if (!d) return null;
      const speed = int(cmd.speed, 1, 10, 5);
      const pan = Math.max(1, Math.round(speed * 0x18 / 10)), tilt = Math.max(1, Math.round(speed * 0x17 / 10));
      return [0x81, 0x01, 0x06, 0x01, pan, tilt, ...d, 0xff];
    }
    case 'home': return hex('81 01 06 04 FF');
    case 'zoom': {
      if (cmd.dir === 'stop') return hex('81 01 04 07 00 FF');
      const p = int(cmd.speed, 0, 7, 3);
      if (cmd.dir === 'in') return [0x81, 0x01, 0x04, 0x07, 0x20 | p, 0xff];
      if (cmd.dir === 'out') return [0x81, 0x01, 0x04, 0x07, 0x30 | p, 0xff];
      return null;
    }
    case 'preset': {
      const n = int(cmd.n, 1, 16, 1) - 1;
      if (cmd.op === 'recall') return [0x81, 0x01, 0x04, 0x3f, 0x02, n, 0xff];
      if (cmd.op === 'set') return [0x81, 0x01, 0x04, 0x3f, 0x01, n, 0xff];
      return null;
    }
    case 'tracking': return [0x81, 0x01, 0x8e, 0x00, cmd.on ? 0x02 : 0x03, 0xff];
    case 'trackMode': return [0x81, 0x01, 0x8e, 0x01, cmd.mode === 'multi' ? 0x01 : 0x00, 0xff];
    case 'framing': {
      if (!(cmd.framing in FRAMING)) return null;
      return [0x81, 0x01, 0x8e, 0x03, FRAMING[cmd.framing], 0xff];
    }
    case 'onlyMe': return [0x81, 0x01, 0x8e, 0x04, cmd.on ? 0x01 : 0x00, 0xff];
    case 'focus': {
      if (cmd.mode === 'auto') return hex('81 01 04 38 02 FF');
      if (cmd.mode === 'push') return hex('81 01 04 18 01 FF');
      return null;
    }
    case 'exposure': {
      if (cmd.dir === 'up') return hex('81 01 04 0E 02 FF');
      if (cmd.dir === 'down') return hex('81 01 04 0E 03 FF');
      if (cmd.dir === 'reset') return hex('81 01 04 0E 00 FF');
      return null;
    }
    case 'orientation': return [0x81, 0x01, 0x04, 0x67, cmd.vertical ? 0x01 : 0x00, 0xff];
    case 'zoomTo': {
      const z = int(cmd.ratio * 1000, 1000, 12000, 1000);
      return [0x81, 0x01, 0x04, 0x47, ...nib(z, 4), 0xff];
    }
    default: return null;
  }
}

// Movements keep going until a stop; the relay stops them itself when no refresh arrives
export const isContinuous = cmd => (cmd.type === 'move' && cmd.dir !== 'stop') || (cmd.type === 'zoom' && cmd.dir !== 'stop');
export const stopFor = cmd => (cmd.type === 'move' ? viscaFor({ type: 'move', dir: 'stop' }) : cmd.type === 'zoom' ? viscaFor({ type: 'zoom', dir: 'stop' }) : null);

// Camera addresses the relay may send to: the venue's own network only
export const privateHost = h => /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/.test(String(h || ''));
