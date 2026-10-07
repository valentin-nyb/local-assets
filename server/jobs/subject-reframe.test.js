import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubjectCropFilter } from './subject-reframe.js';

test('centers the crop when the detector finds no person', () => {
  const filter = buildSubjectCropFilter([], 1920, 1080, 30);
  assert.equal(filter, 'crop=606:1080:657:0,scale=1080:1920:flags=lanczos');
});

test('tracks a moving subject with an interpolated crop position', () => {
  const filter = buildSubjectCropFilter([
    { time: 0, centerX: 0.25, centerY: 0.5 },
    { time: 10, centerX: 0.75, centerY: 0.5 },
  ], 1920, 1080, 20);
  assert.match(filter, /if\(lt\(t\\,10\)/);
  assert.match(filter, /scale=1080:1920:flags=lanczos$/);
  assert.match(filter, /crop=606:1080:/);
});

test('keeps portrait video within source bounds', () => {
  const filter = buildSubjectCropFilter([
    { time: 0, centerX: 0.5, centerY: 0.2 },
    { time: 8, centerX: 0.5, centerY: 0.8 },
  ], 1080, 2400, 10);
  assert.match(filter, /^scale=864:1920:flags=bilinear,crop=864:1536:0:/);
  assert.match(filter, /if\(lt\(t\\,8\)/);
});

test('downscales 4K landscape input before the vertical crop', () => {
  const filter = buildSubjectCropFilter([
    { time: 0, centerX: 0.25, centerY: 0.5 },
    { time: 10, centerX: 0.75, centerY: 0.5 },
  ], 3840, 2160, 20);
  assert.match(filter, /^scale=1920:1080:flags=bilinear,crop=606:1080:/);
  assert.match(filter, /scale=1080:1920:flags=lanczos$/);
});

test('downscales 4K portrait input without exceeding the portrait frame', () => {
  const filter = buildSubjectCropFilter([], 2160, 3840, 20);
  assert.equal(filter, 'scale=1080:1920:flags=bilinear,crop=1080:1920:0:0,scale=1080:1920:flags=lanczos');
});

test('rejects missing source dimensions', () => {
  assert.throws(() => buildSubjectCropFilter([], 0, 1080, 30), /Video dimensions/);
});