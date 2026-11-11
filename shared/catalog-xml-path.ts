// XML 1.0 NCName code points; a QName permits one literal prefix separator.
const xmlNameStart = (cp: number) =>
  cp === 95 ||
  [
    [65, 90],
    [97, 122],
    [0xc0, 0xd6],
    [0xd8, 0xf6],
    [0xf8, 0x2ff],
    [0x370, 0x37d],
    [0x37f, 0x1fff],
    [0x200c, 0x200d],
    [0x2070, 0x218f],
    [0x2c00, 0x2fef],
    [0x3001, 0xd7ff],
    [0xf900, 0xfdcf],
    [0xfdf0, 0xfffd],
    [0x10000, 0xeffff],
  ].some(([from, to]) => cp >= from && cp <= to);
const safeXmlName = (v: string) => {
  const parts = v.split(':');
  return (
    parts.length <= 2 &&
    parts.every(
      (part) =>
        !['__proto__', 'prototype', 'constructor', 'xmlns'].includes(part) &&
        [...part].length > 0 &&
        [...part].every((ch, index) => {
          const cp = ch.codePointAt(0)!;
          return (
            xmlNameStart(cp) ||
            (index > 0 &&
              (cp === 45 ||
                cp === 46 ||
                cp === 0xb7 ||
                (cp >= 48 && cp <= 57) ||
                (cp >= 0x300 && cp <= 0x36f) ||
                (cp >= 0x203f && cp <= 0x2040)))
          );
        }),
    )
  );
};

export function catalogXmlPathValid(path: string, absolute: boolean, maxDepth: number): boolean {
  if (!path.length || path.length > 1024 || absolute !== path.startsWith('/')) return false;
  const parts = (absolute ? path.slice(1) : path).split('/');
  return (
    parts.length <= maxDepth &&
    parts.every((part, i) => {
      if (!absolute && part.startsWith('@'))
        return i === parts.length - 1 && safeXmlName(part.slice(1));
      return safeXmlName(part);
    })
  );
}
