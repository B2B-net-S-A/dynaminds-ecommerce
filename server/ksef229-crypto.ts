/** KSeF 2.0 cryptography only (no network, no DB): AES-256-CBC/PKCS#7 invoice encryption,
 * RSA-OAEP (SHA-256, MGF1-SHA-256) for the session key and the KSeF token, SHA-256 hashes,
 * the KSeF number CRC-8, the KOD II (offline certificate) QR signature and a simplified
 * enveloped XML signature for certificate authentication.
 *
 * Known simplification of signAuthTokenRequest vs MF's XAdES-BES: no exc-c14n and no
 * QualifyingProperties (SigningTime, SigningCertificate). The digest covers the exact bytes
 * of the document as given and the signature the exact bytes of the SignedInfo we produce
 * (no whitespace). Enough for the local fake; a real MF certificate login needs a full
 * XAdES-BES signer. `certPem` may be an X.509 certificate PEM or, for the local fake only,
 * an SPKI public key PEM (`-----BEGIN PUBLIC KEY-----`), because Node cannot mint X.509. */
import { X509Certificate, constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

/** Fresh AES-256 key (32 B) and IV (16 B) for one online session. */
export function newSessionKey(): { key: Buffer; iv: Buffer } { return { key: randomBytes(32), iv: randomBytes(16) }; }
const aesArgs = (key: Buffer, iv: Buffer) => { if (key.length !== 32 || iv.length !== 16) throw new Error('Klucz AES-256 musi mieć 32 bajty, a wektor IV 16 bajtów'); };
/** AES-256-CBC with PKCS#7 padding (the cipher's default padding). */
export function encryptInvoice(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  aesArgs(key, iv); const c = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([c.update(plain), c.final()]);
}
export function decryptInvoice(enc: Buffer, key: Buffer, iv: Buffer): Buffer {
  aesArgs(key, iv); const d = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([d.update(enc), d.final()]);
}

const oaep = (key: KeyObject) => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' });
/** RSA-OAEP, SHA-256 with MGF1-SHA-256 (Node uses the OAEP hash for MGF1), base64. */
export function rsaOaepEncrypt(data: Buffer, publicKey: KeyObject): string { return publicEncrypt(oaep(publicKey), data).toString('base64'); }
export function rsaOaepDecrypt(b64: string, privateKey: KeyObject): Buffer { return privateDecrypt(oaep(privateKey), Buffer.from(b64, 'base64')); }

/** encryptedToken of POST /auth/ksef-token: RSA-OAEP of UTF-8 `token|timestampMs` (challenge time). */
export function encryptKsefToken(token: string, timestampMs: number, publicKey: KeyObject): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new Error('Nieprawidłowy znacznik czasu wyzwania KSeF');
  return rsaOaepEncrypt(Buffer.from(`${token}|${timestampMs}`, 'utf8'), publicKey);
}
export function decryptKsefToken(b64: string, privateKey: KeyObject): { token: string; timestampMs: number } {
  const text = rsaOaepDecrypt(b64, privateKey).toString('utf8'), at = text.lastIndexOf('|'), ts = text.slice(at + 1);
  if (at < 1 || !/^\d{1,16}$/.test(ts)) throw new Error('Zaszyfrowany token KSeF ma nieprawidłowy format');
  return { token: text.slice(0, at), timestampMs: Number(ts) };
}

export const sha256Base64 = (buf: Buffer): string => createHash('sha256').update(buf).digest('base64');
export const sha256Base64Url = (buf: Buffer): string => createHash('sha256').update(buf).digest('base64url');
export const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** MF public key from `certificate` of /security/public-key-certificates: X.509 DER, or SPKI DER
 * (what the local fake publishes). */
export function mfPublicKeyFrom(base64Der: string): KeyObject {
  const der = Buffer.from(base64Der, 'base64');
  try { return new X509Certificate(der).publicKey; } catch { /* not a certificate, try SPKI */ }
  try { return createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { throw new Error('Nieprawidłowy klucz publiczny KSeF'); }
}
/** Public key from an X.509 certificate PEM or an SPKI public key PEM. */
export function publicKeyFromPem(pem: string): KeyObject {
  return /-----BEGIN CERTIFICATE-----/.test(pem) ? new X509Certificate(pem).publicKey : createPublicKey(pem);
}

/** CRC-8 (poly 0x07, init 0x00, no reflection, xorout 0x00) over the ASCII of the first 32
 * characters `NIP-YYYYMMDD-XXXXXXXXXXXX`, as 2 uppercase hex digits. */
export function ksefNumberChecksum(first32: string): string {
  let crc = 0;
  for (const b of Buffer.from(first32, 'ascii')) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff; }
  return crc.toString(16).toUpperCase().padStart(2, '0');
}
export function makeKsefNumber(nip: string, yyyymmdd: string, hex12: string): string {
  if (!/^\d{10}$/.test(nip) || !/^\d{8}$/.test(yyyymmdd) || !/^[0-9A-Fa-f]{12}$/.test(hex12)) throw new Error('Nieprawidłowe składniki numeru KSeF');
  const first = `${nip}-${yyyymmdd}-${hex12.toUpperCase()}`;
  return `${first}-${ksefNumberChecksum(first)}`;
}
export function isKsefNumber(s: string): boolean {
  return typeof s === 'string' && /^\d{10}-\d{8}-[0-9A-F]{12}-[0-9A-F]{2}$/.test(s) && ksefNumberChecksum(s.slice(0, 32)) === s.slice(33);
}

const isP256 = (k: KeyObject) => k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1';
/** KOD II signature of `path` = the verification URL without `https://` and without the
 * trailing `/{signature}`. RSA → RSASSA-PSS SHA-256/MGF1-SHA-256/salt 32; EC P-256 → ECDSA
 * SHA-256 in IEEE-P1363 (r||s). Returns base64url. */
export function signCertificateQrPath(path: string, privateKey: KeyObject): string {
  const data = Buffer.from(path, 'utf8');
  if (privateKey.asymmetricKeyType === 'rsa') return sign('sha256', data, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url');
  if (isP256(privateKey)) return sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  throw new Error('Nieobsługiwany klucz certyfikatu offline (wymagany RSA albo EC P-256)');
}
export function verifyCertificateQrPath(path: string, sigB64Url: string, publicKey: KeyObject): boolean {
  const data = Buffer.from(path, 'utf8'), sig = Buffer.from(sigB64Url, 'base64url');
  try {
    if (publicKey.asymmetricKeyType === 'rsa') return verify('sha256', data, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    if (isP256(publicKey)) return verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  } catch { /* malformed signature */ }
  return false;
}

const DS = 'http://www.w3.org/2000/09/xmldsig#', C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#', SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', ECDSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256';
const sigMethod = (k: KeyObject) => k.asymmetricKeyType === 'rsa' ? RSA_SHA256 : isP256(k) ? ECDSA_SHA256 : null;
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' });
const SIG_OPEN = `<ds:Signature xmlns:ds="${DS}">`;

/** Enveloped signature inserted before the closing root tag (simplified, see file header). */
export function signAuthTokenRequest(xml: string, certPem: string, privateKeyPem: string): string {
  const end = /<\/[A-Za-z_][\w.:-]*>\s*$/.exec(xml);
  if (!end || /<ds:Signature[\s>]/.test(xml)) throw new Error('Dokument do podpisu ma nieprawidłową postać');
  const priv = createPrivateKey(privateKeyPem), alg = sigMethod(priv);
  if (!alg) throw new Error('Nieobsługiwany klucz certyfikatu (wymagany RSA albo EC P-256)');
  const isCert = /-----BEGIN CERTIFICATE-----/.test(certPem), pub = publicKeyFromPem(certPem);
  if (!spki(createPublicKey(priv)).equals(spki(pub))) throw new Error('Klucz prywatny nie pasuje do certyfikatu');
  const certDer = isCert ? new X509Certificate(certPem).raw : spki(pub);
  const signedInfo = `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="${C14N}"/><ds:SignatureMethod Algorithm="${alg}"/><ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="${DS}enveloped-signature"/></ds:Transforms><ds:DigestMethod Algorithm="${SHA256}"/><ds:DigestValue>${sha256Base64(Buffer.from(xml, 'utf8'))}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const value = sign('sha256', Buffer.from(signedInfo, 'utf8'), alg === ECDSA_SHA256 ? { key: priv, dsaEncoding: 'ieee-p1363' } : priv).toString('base64');
  const signature = `${SIG_OPEN}${signedInfo}<ds:SignatureValue>${value}</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certDer.toString('base64')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`;
  return xml.slice(0, end.index) + signature + xml.slice(end.index);
}

/** Fake-server side of signAuthTokenRequest: exactly one signature, digest of the document
 * without it, signature by the embedded certificate (X.509 or SPKI). `body` = the document
 * without the signature. */
export function verifyAuthTokenRequest(signedXml: string): { ok: boolean; certificateDer: Buffer | null; body: string } {
  const fail = { ok: false, certificateDer: null, body: signedXml };
  if ((signedXml.match(/<ds:Signature[\s>]/g) ?? []).length !== 1) return fail;
  const start = signedXml.indexOf(SIG_OPEN), close = signedXml.indexOf('</ds:Signature>', start);
  if (start < 0 || close < 0) return fail;
  const inner = signedXml.slice(start + SIG_OPEN.length, close), body = signedXml.slice(0, start) + signedXml.slice(close + '</ds:Signature>'.length);
  const m = /^(<ds:SignedInfo>[\s\S]*<\/ds:SignedInfo>)<ds:SignatureValue>([A-Za-z0-9+/=]+)<\/ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>([A-Za-z0-9+/=]+)<\/ds:X509Certificate><\/ds:X509Data><\/ds:KeyInfo>$/.exec(inner);
  if (!m) return { ...fail, body };
  const [, signedInfo, value, certB64] = m as unknown as [string, string, string, string], certificateDer = Buffer.from(certB64, 'base64');
  const digest = /<ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#enveloped-signature"\/><\/ds:Transforms><ds:DigestMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmlenc#sha256"\/><ds:DigestValue>([A-Za-z0-9+/=]+)<\/ds:DigestValue><\/ds:Reference>/.exec(signedInfo);
  const alg = /<ds:SignatureMethod Algorithm="([^"]+)"\/>/.exec(signedInfo)?.[1];
  let key: KeyObject;
  try { key = mfPublicKeyFrom(certB64); } catch { return { ok: false, certificateDer, body }; }
  if (!digest || digest[1] !== sha256Base64(Buffer.from(body, 'utf8')) || alg !== sigMethod(key)) return { ok: false, certificateDer, body };
  let ok = false;
  try { ok = verify('sha256', Buffer.from(signedInfo, 'utf8'), alg === ECDSA_SHA256 ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(value, 'base64')); } catch { ok = false; }
  return { ok, certificateDer, body };
}
