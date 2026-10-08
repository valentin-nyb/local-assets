import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
let modelPromise;

async function getPersonDetector() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tfModule = await import('@tensorflow/tfjs-core');
      const tf = tfModule.default || tfModule;
      await import('@tensorflow/tfjs-backend-cpu');
      await tf.setBackend('cpu');
      await tf.ready();
      console.log(`[Reframe] TensorFlow backend: ${tf.getBackend()}`);
      const cocoModule = await import('@tensorflow-models/coco-ssd');
      const cocoSsd = cocoModule.default || cocoModule;
      const model = await cocoSsd.load({ base: 'mobilenet_v1' });
      const jpegModule = await import('jpeg-js');
      return { tf, model, jpeg: jpegModule.default || jpegModule };
    })();
  }
  return modelPromise;
}

export async function extractSubjectFrames(videoUrl, start, duration, frameDir, signal) {
  fs.mkdirSync(frameDir, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,https,http,tcp,tls,crypto',
    '-ss', String(start), '-t', String(duration), '-i', videoUrl,
    '-vf', 'fps=0.2,scale=320:-2:flags=bilinear',
    '-q:v', '5', path.join(frameDir, 'frame_%06d.jpg'),
  ], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, signal });
}

function choosePerson(predictions, previous, frameWidth, frameHeight) {
  const people = predictions.filter(item => item.class === 'person');
  if (!people.length) return null;

  const ranked = people.map(person => {
    const [x, y, width, height] = person.bbox;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const area = width * height;
    const distance = previous
      ? Math.hypot((centerX - previous.x) / frameWidth, (centerY - previous.y) / frameHeight)
      : Math.abs(centerX - frameWidth / 2) / frameWidth;
    const score = previous
      ? area * Math.exp(-distance * 5)
      : area * (1 - distance * 0.25);
    return { x: centerX, y: centerY, score };
  });

  ranked.sort((a, b) => b.score - a.score);
  if (previous && Math.hypot((ranked[0].x - previous.x) / frameWidth, (ranked[0].y - previous.y) / frameHeight) > 0.45) {
    ranked.sort((a, b) => b.score - a.score);
  }
  return ranked[0];
}

export async function detectSubjectTrack(frameDir) {
  const { tf, model, jpeg } = await getPersonDetector();
  const frames = fs.readdirSync(frameDir)
    .filter(name => /^frame_\d+\.jpg$/.test(name))
    .sort();
  const track = [];
  let previous = null;
  let missedFrames = 0;

  for (let index = 0; index < frames.length; index++) {
    const decoded = jpeg.decode(fs.readFileSync(path.join(frameDir, frames[index])), {
      useTArray: true,
      formatAsRGBA: false,
    });
    const image = tf.tensor3d(decoded.data, [decoded.height, decoded.width, 3], 'int32');
    try {
      const predictions = await model.detect(image, 20, 0.35);
      const [frameHeight, frameWidth] = image.shape;
      const person = choosePerson(predictions, previous, frameWidth, frameHeight);
      if (person) {
        previous = person;
        missedFrames = 0;
        track.push({ time: index, centerX: person.x / frameWidth, centerY: person.y / frameHeight });
      } else {
        missedFrames++;
        if (missedFrames >= 3) previous = null;
      }
    } finally {
      image.dispose();
    }
  }

  return track;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function axisExpression(points, axis) {
  if (points.every(point => point[axis] === points[0][axis])) return formatNumber(points[0][axis]);
  if (points.length === 1) return formatNumber(points[0][axis]);
  let expression = formatNumber(points[points.length - 1][axis]);

  for (let index = points.length - 2; index >= 0; index--) {
    const from = points[index];
    const to = points[index + 1];
    const span = Math.max(0.001, to.time - from.time);
    const linear = `${formatNumber(from[axis])}+(${formatNumber(to[axis])}-${formatNumber(from[axis])})*(t-${formatNumber(from.time)})/${formatNumber(span)}`;
    expression = `if(lt(t,${formatNumber(to.time)}),${linear},${expression})`;
  }
  return expression.replace(/,/g, '\\,');
}

export function buildSubjectCropFilter(track, srcWidth, srcHeight, duration) {
  if (!(srcWidth > 0 && srcHeight > 0)) throw new Error('Video dimensions are required for vertical reframing');

  const scale = Math.min(1, 1920 / srcWidth, 1920 / srcHeight);
  const frameWidth = Math.max(2, Math.floor(srcWidth * scale / 2) * 2);
  const frameHeight = Math.max(2, Math.floor(srcHeight * scale / 2) * 2);
  let cropWidth = frameWidth;
  let cropHeight = frameHeight;
  if (frameWidth / frameHeight > 9 / 16) cropWidth = frameHeight * 9 / 16;
  else cropHeight = frameWidth * 16 / 9;
  cropWidth = Math.max(2, Math.floor(cropWidth / 2) * 2);
  cropHeight = Math.max(2, Math.floor(cropHeight / 2) * 2);

  const samples = track.length
    ? track.map(sample => ({ time: clamp(sample.time, 0, duration), centerX: sample.centerX, centerY: sample.centerY }))
    : [{ time: 0, centerX: 0.5, centerY: 0.5 }];
  if (samples[0].time > 0) samples.unshift({ ...samples[0], time: 0 });
  if (samples[samples.length - 1].time < duration) samples.push({ ...samples[samples.length - 1], time: duration });

  const points = samples.map(sample => ({
    time: sample.time,
    x: clamp(sample.centerX * frameWidth - cropWidth / 2, 0, frameWidth - cropWidth),
    y: clamp(sample.centerY * frameHeight - cropHeight / 2, 0, frameHeight - cropHeight),
  }));
  const x = axisExpression(points, 'x');
  const y = axisExpression(points, 'y');
  const preScale = scale < 1 ? `scale=${frameWidth}:${frameHeight}:flags=bilinear,` : '';
  return `${preScale}crop=${cropWidth}:${cropHeight}:${x}:${y},scale=1080:1920:flags=lanczos`;
}