import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScaleLineBuffer,
  createScaleTracker,
  parseScaleFrame,
  scaleFailure,
  type ScaleFrame,
} from '../web/scale-frame';

const stable = (grams: number): ScaleFrame => ({ kind: 'weight', grams, stability: 'stable' });
const unknown = (grams: number): ScaleFrame => ({ kind: 'weight', grams, stability: 'unknown' });

test('status-header frames (A&D, CAS and OEM indicators)', () => {
  const cases: [string, ScaleFrame][] = [
    ['ST,GS,+  1.234kg', stable(1234)],
    ['ST,NT,+0001.234 kg', stable(1234)],
    ['ST,+00001.234  kg', stable(1234)],
    ['st,gs,+  0.250KG', stable(250)],
    ['ST,GS,+   1250 g', stable(1250)],
    ['ST,GS,+  1.234,kg', stable(1234)],
    ['US,GS,+  1.234kg', { kind: 'unstable' }],
    ['US,NT,+0001.200 kg', { kind: 'unstable' }],
    ['OL,GS,+9999.999kg', { kind: 'overload' }],
    ['OL,GS,  ------  ', { kind: 'overload' }],
    ['ST,GS,-  0.120kg', { kind: 'negative' }],
    ['ST,GS,+  0.000kg', { kind: 'zero' }],
    ['ST,GS,+ 1001.000kg', { kind: 'out_of_range' }],
    ['ST,GS,+  1.234', { kind: 'invalid' }],
  ];
  for (const [line, expected] of cases) assert.deepEqual(parseScaleFrame(line), expected, line);
});

test('MT-SICS and Radwag responses', () => {
  const cases: [string, ScaleFrame][] = [
    ['S S      1.234 kg', stable(1234)],
    ['S S    125.0 g', stable(125)],
    ['S D      1.230 kg', { kind: 'unstable' }],
    ['S I', { kind: 'unstable' }],
    ['S +', { kind: 'overload' }],
    ['S -', { kind: 'negative' }],
    ['S S     -0.010 kg', { kind: 'negative' }],
    ['SI     1.234 kg', stable(1234)],
    ['SI ?   1.234 kg', { kind: 'unstable' }],
    ['SI ^   ', { kind: 'overload' }],
    ['SI v   ', { kind: 'negative' }],
    ['SI  -  0.500 kg', { kind: 'negative' }],
    ['SU     2.500 lb', stable(1134)],
  ];
  for (const [line, expected] of cases) assert.deepEqual(parseScaleFrame(line), expected, line);
});

test('plain continuous output without a header', () => {
  const cases: [string, ScaleFrame][] = [
    ['   1234 g', unknown(1234)],
    ['1.234 kg', unknown(1234)],
    ['  1,234 kg', unknown(1234)],
    ['\x02  001.234kg\x03', unknown(1234)],
    ['    1.234 kg ?', { kind: 'unstable' }],
    ['MOTION 1.234 kg', { kind: 'unstable' }],
    ['  1.234 kg ST', stable(1234)],
    ['STABLE 750 g', stable(750)],
    ['  2.72 lb', unknown(1234)],
    ['  2.72 lbs', unknown(1234)],
    ['  16 oz', unknown(454)],
    ['-  0.500 kg', { kind: 'negative' }],
    ['   0 g', { kind: 'zero' }],
    ['   0.4 g', { kind: 'zero' }],
    ['   0.5 g', unknown(1)],
    ['  OL  ', { kind: 'overload' }],
    [' OVER ', { kind: 'overload' }],
    ['--------', { kind: 'overload' }],
    ['', { kind: 'empty' }],
    ['   \x00  ', { kind: 'empty' }],
  ];
  for (const [line, expected] of cases) assert.deepEqual(parseScaleFrame(line), expected, line);
});

test('exact rounding without floating point drift', () => {
  assert.deepEqual(parseScaleFrame('ST,GS,+1.0005kg'), stable(1001));
  assert.deepEqual(parseScaleFrame('ST,GS,+1.0004kg'), stable(1000));
  assert.deepEqual(parseScaleFrame('ST,GS,+1000.000kg'), stable(1000000));
  assert.deepEqual(parseScaleFrame('ST,GS,+1 lb'), stable(454));
  assert.deepEqual(parseScaleFrame('ST,GS,+999999999 kg'), { kind: 'out_of_range' });
});

test('garbage and ambiguous frames are rejected', () => {
  for (const line of [
    '1.234',
    '   1234',
    'ERR 04',
    'hello world',
    'G 1.200 kg T 0.100 kg',
    '1.2.3 kg',
    'kg',
    '1.234 kgx',
    '���',
    'ST,GS,',
    'QT,+00000012 PC',
  ])
    assert.equal(parseScaleFrame(line).kind, 'invalid', JSON.stringify(line));
});

test('line buffer splits on CR, LF and ETX across chunks and drops runaway lines', () => {
  const lines = createScaleLineBuffer(16);
  assert.deepEqual(lines('ST,GS,+  1.2'), []);
  assert.deepEqual(lines('34kg\r\nUS,GS'), ['ST,GS,+  1.234kg']);
  assert.deepEqual(lines(',+1kg\r\r\n\x02 5 g\x03'), ['US,GS,+1kg', '\x02 5 g']);
  assert.deepEqual(lines('x'.repeat(40)), []);
  assert.deepEqual(lines('\n1 kg\n'), ['1 kg']);
});

test('tracker accepts a flagged stable frame at once and an unflagged one only after repeats', () => {
  const t = createScaleTracker(3);
  assert.equal(t.push(parseScaleFrame('US,GS,+1.200kg')), null);
  assert.equal(t.push(parseScaleFrame('ST,GS,+1.234kg')), 1234);

  const plain = createScaleTracker(3);
  assert.equal(plain.push(unknown(1234)), null);
  assert.equal(plain.push(unknown(1234)), null);
  assert.equal(plain.push(unknown(1235)), null, 'changed value restarts the streak');
  assert.equal(plain.push(unknown(1235)), null);
  assert.equal(plain.push({ kind: 'empty' }), null, 'empty lines are ignored');
  assert.equal(plain.push(unknown(1235)), 1235);

  const reset = createScaleTracker(2);
  assert.equal(reset.push(unknown(500)), null);
  assert.equal(reset.push({ kind: 'unstable' }), null);
  assert.equal(reset.push(unknown(500)), null, 'unstable frame resets the streak');
  assert.equal(reset.push(unknown(500)), 500);
});

test('failure reason comes from the last frame seen', () => {
  assert.equal(scaleFailure(null), 'no_data');
  assert.equal(scaleFailure(unknown(10)), 'unstable');
  assert.equal(scaleFailure({ kind: 'overload' }), 'overload');
  assert.equal(scaleFailure({ kind: 'negative' }), 'negative');
  assert.equal(scaleFailure({ kind: 'zero' }), 'zero');
  assert.equal(scaleFailure({ kind: 'invalid' }), 'invalid');
});
