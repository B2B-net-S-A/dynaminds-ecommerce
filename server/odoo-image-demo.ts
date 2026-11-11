import { deflateSync } from 'node:zlib';
/** Deterministic synthetic PNG for the local connector example, never a provider photo. */
export function demoOdooImage() {
  const width = 160,
    height = 120,
    raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const bag = x >= 47 && x < 113 && y >= 30 && y < 83;
      const handle = y >= 17 && y < 34 && x >= 63 && x < 97 && (x < 69 || x >= 91 || y < 23);
      const letter =
        (x >= 64 && x < 71 && y >= 42 && y < 72) ||
        ((y < 48 || y >= 66) && x >= 71 && x < 86 && y >= 42 && y < 72) ||
        (x >= 86 && x < 92 && y >= 48 && y < 66);
      const colors = letter ? [48, 58, 167] : bag || handle ? [255, 255, 255] : [48, 58, 167];
      const font: Record<string, string[]> = {
        D: ['1110', '1001', '1001', '1001', '1110'],
        E: ['1111', '1000', '1110', '1000', '1111'],
        M: ['10001', '11011', '10101', '10001', '10001'],
        O: ['0110', '1001', '1001', '1001', '0110'],
      };
      let marked = false,
        left = 49;
      for (const c of 'DEMO') {
        const gx = Math.floor((x - left) / 2),
          gy = Math.floor((y - 97) / 2);
        if (gy >= 0 && gy < 5 && gx >= 0 && gx < font[c][gy].length && font[c][gy][gx] === '1')
          marked = true;
        left += (font[c][0].length + 2) * 2;
      }
      const color = marked ? [255, 255, 255] : colors,
        at = y * (width * 4 + 1) + 1 + x * 4;
      raw.set([...color, 255], at);
    }
  const crc = (data: Buffer) => {
    let n = 0xffffffff;
    for (const b of data) {
      n ^= b;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]),
      out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), out.length - 4);
    return out;
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', h),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
