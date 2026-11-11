/** 229 KSeF 2.0 crypto with keys generated in the test (no real values): AES-256-CBC/PKCS#7,
 * RSA-OAEP SHA-256, the token `|timestampMs`, the KSeF number CRC-8, KOD II signatures
 * (RSA-PSS, EC P-256) and the simplified XAdES signature. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  decryptInvoice, decryptKsefToken, encryptInvoice, encryptKsefToken, isKsefNumber, ksefNumberChecksum, makeKsefNumber, mfPublicKeyFrom, newSessionKey,
  rsaOaepDecrypt, rsaOaepEncrypt, sha256Base64, sha256Base64Url, sha256Hex, signAuthTokenRequest, signCertificateQrPath, verifyAuthTokenRequest, verifyCertificateQrPath,
} from '../server/ksef229-crypto';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (k: { publicKey: import('node:crypto').KeyObject; privateKey: import('node:crypto').KeyObject }) =>
  ({ cert: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });

test('AES-256-CBC round trip with PKCS#7 edge sizes; a wrong key does not give the plain text back', () => {
  const { key, iv } = newSessionKey();
  assert.equal(key.length, 32); assert.equal(iv.length, 16);
  for (const n of [0, 1, 15, 16, 17, 31, 32, 1000]) {
    const plain = randomBytes(n), enc = encryptInvoice(plain, key, iv);
    assert.equal(enc.length, (Math.floor(n / 16) + 1) * 16, `padding for ${n} B`);
    assert.deepEqual(decryptInvoice(enc, key, iv), plain);
  }
  const plain = Buffer.from('<Faktura>wrong key</Faktura>'), enc = encryptInvoice(plain, key, iv);
  let differs: boolean;
  try { differs = !decryptInvoice(enc, newSessionKey().key, iv).equals(plain); } catch { differs = true; }
  assert.ok(differs);
  assert.throws(() => encryptInvoice(plain, key.subarray(0, 16), iv));
});

test('RSA-OAEP SHA-256 round trip and the KSeF token with the challenge timestamp', () => {
  const data = randomBytes(32), b64 = rsaOaepEncrypt(data, rsa.publicKey);
  assert.deepEqual(rsaOaepDecrypt(b64, rsa.privateKey), data);
  assert.throws(() => rsaOaepDecrypt(b64, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey));
  const enc = encryptKsefToken('lokalny|token-testowy', 1_761_200_000_123, rsa.publicKey);
  assert.deepEqual(decryptKsefToken(enc, rsa.privateKey), { token: 'lokalny|token-testowy', timestampMs: 1_761_200_000_123 });
  assert.throws(() => decryptKsefToken(rsaOaepEncrypt(Buffer.from('bez-znacznika'), rsa.publicKey), rsa.privateKey));
  const spki = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.deepEqual(rsaOaepDecrypt(rsaOaepEncrypt(data, mfPublicKeyFrom(spki)), rsa.privateKey), data);
  assert.throws(() => mfPublicKeyFrom(Buffer.from('nie klucz').toString('base64')));
});

test('SHA-256 encodings', () => {
  const b = Buffer.from('abc');
  assert.equal(sha256Hex(b), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Base64(b), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  assert.equal(sha256Base64Url(b), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('KSeF number: CRC-8 checksum, generation, validation, one-character tamper refused', () => {
  assert.equal(ksefNumberChecksum('123456789'), 'F4'); // CRC-8/SMBUS check value
  const n = makeKsefNumber('1234563218', '20261023', 'a1b2c3d4e5f6');
  assert.match(n, /^1234563218-20261023-A1B2C3D4E5F6-[0-9A-F]{2}$/);
  assert.ok(isKsefNumber(n));
  assert.equal(n.slice(33), ksefNumberChecksum(n.slice(0, 32)));
  const tampered = n.slice(0, 20) + (n[20] === 'A' ? 'B' : 'A') + n.slice(21);
  assert.equal(isKsefNumber(tampered), false);
  assert.equal(isKsefNumber(n.slice(0, 33) + (n.slice(33) === '00' ? '01' : '00')), false);
  for (const bad of ['', n.toLowerCase(), n + '0', '123456321-20261023-A1B2C3D4E5F6-00']) assert.equal(isKsefNumber(bad), false);
  assert.throws(() => makeKsefNumber('123', '20261023', 'A1B2C3D4E5F6'));
});

test('KOD II: RSA-PSS and ECDSA P-256 (IEEE-P1363) sign and verify; tampering refused', () => {
  const path = 'qr-test.ksef.mf.gov.pl/certificate/Nip/1234563218/1234563218/01F20A5D352AE590/' + sha256Base64Url(Buffer.from('<Faktura/>'));
  for (const k of [rsa, ec]) {
    const sig = signCertificateQrPath(path, k.privateKey);
    assert.match(sig, /^[A-Za-z0-9_-]+$/);
    assert.ok(verifyCertificateQrPath(path, sig, k.publicKey));
    assert.equal(verifyCertificateQrPath(path + 'x', sig, k.publicKey), false);
    assert.equal(verifyCertificateQrPath(path, sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA'), k.publicKey), false);
  }
  assert.equal(Buffer.from(signCertificateQrPath(path, ec.privateKey), 'base64url').length, 64);
  assert.equal(verifyCertificateQrPath(path, signCertificateQrPath(path, rsa.privateKey), ec.publicKey), false);
  assert.throws(() => signCertificateQrPath(path, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey));
});

test('simplified XAdES: enveloped signature verifies with RSA and EC; any tamper refused', () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><AuthTokenRequest xmlns="http://ksef.mf.gov.pl/auth/token/2.0"><Challenge>20261023-CR-0000000000-0000000000-00</Challenge><ContextIdentifier><Nip>1234563218</Nip></ContextIdentifier><SubjectIdentifierType>certificateSubject</SubjectIdentifierType></AuthTokenRequest>';
  for (const k of [rsa, ec]) {
    const { cert, priv } = pem(k), signed = signAuthTokenRequest(xml, cert, priv);
    assert.ok(signed.endsWith('</ds:Signature></AuthTokenRequest>'));
    const v = verifyAuthTokenRequest(signed);
    assert.equal(v.ok, true); assert.equal(v.body, xml);
    assert.deepEqual(v.certificateDer, k.publicKey.export({ type: 'spki', format: 'der' }));
    assert.equal(verifyAuthTokenRequest(signed.replace('1234563218', '1234563219')).ok, false);
    assert.equal(verifyAuthTokenRequest(signed.replace(/<ds:SignatureValue>(.)/, (_, c) => `<ds:SignatureValue>${c === 'A' ? 'B' : 'A'}`)).ok, false);
    assert.equal(verifyAuthTokenRequest(signed.replace('-CR-0000000000', '-CR-0000000001')).ok, false);
  }
  const other = pem(generateKeyPairSync('rsa', { modulusLength: 2048 }));
  const swapped = signAuthTokenRequest(xml, pem(rsa).cert, pem(rsa).priv).replace(/<ds:X509Certificate>[^<]+/, `<ds:X509Certificate>${other.cert.replace(/-----[^-]+-----|\s/g, '')}`);
  assert.equal(verifyAuthTokenRequest(swapped).ok, false);
  assert.throws(() => signAuthTokenRequest(xml, other.cert, pem(rsa).priv), /nie pasuje/);
  assert.equal(verifyAuthTokenRequest(xml).ok, false);
});
