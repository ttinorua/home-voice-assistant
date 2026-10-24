import {
  base64ToPcm16,
  downsample,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
} from '../../src/audio/pcm';

test('floatToPcm16 maps 1.0 to 32767 and -1.0 to -32768', () => {
  const out = floatToPcm16(new Float32Array([1, -1, 0]));
  expect(Array.from(out)).toEqual([32767, -32768, 0]);
});

test('floatToPcm16 clamps 2.5 to 32767', () => {
  expect(floatToPcm16(new Float32Array([2.5]))[0]).toBe(32767);
});

test('pcm16ToFloat round-trips within 1/32768', () => {
  const src = new Float32Array([0.5, -0.25, 0.1234]);
  const back = pcm16ToFloat(floatToPcm16(src));
  src.forEach((v, i) => expect(Math.abs(back[i] - v)).toBeLessThanOrEqual(1 / 32768));
});

test('downsample 48000 to 16000 of 480 samples returns 160 samples', () => {
  expect(downsample(new Float32Array(480).fill(0.5), 48000, 16000)).toHaveLength(160);
});

test('base64 round-trip returns identical Int16Array', () => {
  const src = new Int16Array([0, 1, -1, 32767, -32768, 1234]);
  expect(Array.from(base64ToPcm16(pcm16ToBase64(src)))).toEqual(Array.from(src));
});

test('base64ToPcm16 of an empty string returns an empty array', () => {
  expect(base64ToPcm16('')).toHaveLength(0);
});
