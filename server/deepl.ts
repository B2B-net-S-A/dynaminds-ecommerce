import { z } from 'zod';
import { safeFetch, type Transport } from './integrations';
import { ensure, Problem } from './errors';
export const deeplSettings = z.strictObject({ api_plan: z.enum(['free', 'pro']) });
export const deeplCredentials = z.strictObject({
  api_key: z
    .string()
    .trim()
    .min(10)
    .max(1000)
    .regex(/^[A-Za-z0-9:_.-]+$/),
});
export const languageCode = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i)
  .max(40);
export class DeepLError extends Problem {
  constructor(
    public http: number,
    public retryAfter = 5,
  ) {
    super(
      http === 403 ? 401 : 502,
      http === 456
        ? 'Limit znaków DeepL wyczerpany'
        : http === 403
          ? 'Sprawdź klucz i zakresy DeepL'
          : `DeepL: HTTP ${http}`,
    );
  }
  get retryable() {
    return [429, 529].includes(this.http);
  }
  get rejected() {
    return [400, 403, 404, 413, 414, 429, 456, 529].includes(this.http);
  }
}
export class DeepL {
  base: string;
  credentials: z.infer<typeof deeplCredentials>;
  transport: Transport;
  constructor(settings: unknown, credentials: Record<string, string>, transport?: Transport) {
    const s = deeplSettings.parse(settings);
    this.credentials = deeplCredentials.parse(credentials);
    ensure(
      this.credentials.api_key.endsWith(':fx') === (s.api_plan === 'free'),
      422,
      'Klucz :fx wymaga API Free; pozostałe klucze API Pro',
    );
    this.base = s.api_plan === 'free' ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    this.transport = transport ?? safeFetch;
  }
  async request(path: string, body?: unknown, responseLimit = 256 * 1024) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    ensure(
      !encoded || Buffer.byteLength(encoded) <= 128 * 1024,
      422,
      'Żądanie DeepL przekracza 128 KiB',
    );
    const r = await this.transport(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(body === undefined ? 15000 : 30000),
      headers: {
        Authorization: 'DeepL-Auth-Key ' + this.credentials.api_key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: encoded,
    });
    if (!r.ok) {
      const rawRetry = r.headers.get('retry-after') ?? '';
      const numericRetry = Number(rawRetry);
      const retry =
        Number.isFinite(numericRetry) && numericRetry > 0
          ? numericRetry
          : Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000);
      await r.body?.cancel();
      throw new DeepLError(r.status, Number.isFinite(retry) && retry > 0 ? Math.max(5, retry) : 5);
    }
    const reader = r.body?.getReader();
    ensure(reader, 502, 'Brak JSON DeepL');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.length;
        ensure(size <= responseLimit, 502, 'Odpowiedź DeepL jest zbyt duża');
        parts.push(p.value);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new Problem(502, 'Nieprawidłowa lub zbyt duża odpowiedź DeepL');
    } finally {
      await reader.cancel();
    }
  }
  async languages() {
    const rows = z
      .array(
        z.object({
          lang: languageCode,
          name: z.string().min(1).max(100),
          usable_as_source: z.boolean(),
          usable_as_target: z.boolean(),
          status: z.string(),
          features: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .max(300)
      .parse(await this.request('/v3/languages?resource=translate_text'));
    ensure(
      new Set(rows.map((r) => r.lang.toLowerCase())).size === rows.length,
      502,
      'Powielone języki DeepL',
    );
    return rows.filter((r) => r.status === 'stable');
  }
  async usage() {
    return z
      .object({
        character_count: z.number().int().nonnegative().safe(),
        character_limit: z.number().int().nonnegative().safe(),
        api_key_character_count: z.number().int().nonnegative().safe().optional(),
        api_key_character_limit: z.number().int().nonnegative().safe().optional(),
      })
      .refine(
        (u) =>
          (u.api_key_character_count === undefined) === (u.api_key_character_limit === undefined),
        'Niepełny limit klucza DeepL',
      )
      .parse(await this.request('/v2/usage'));
  }
  async test() {
    await this.languages();
    await this.usage();
    return 'verified_read';
  }
  async translate(
    source: { name: string; description: string },
    from: string,
    to: string,
    formality: string,
  ) {
    return (await this.translateMany([source], from, to, formality))[0];
  }
  async translateMany(
    sources: { name: string; description: string }[],
    from: string,
    to: string,
    formality: string,
  ) {
    ensure(sources.length > 0 && sources.length <= 20, 422, 'Porcja wymaga 1–20 produktów');
    const body = deepLBody(sources, from, to, formality);
    const out = z
      .object({
        translations: z
          .array(
            z.object({
              text: z.string().max(10000),
              detected_source_language: z.string().max(40),
              billed_characters: z.number().int().nonnegative().safe(),
              model_type_used: z.string().max(100).optional(),
            }),
          )
          .length(body.text.length),
      })
      .parse(
        await this.request(
          '/v2/translate',
          body,
          sources.length > 1 ? 2 * 1024 * 1024 : 256 * 1024,
        ),
      );
    let position = 0;
    return sources.map((source) => {
      const rows = out.translations.slice(position, position + (source.description ? 2 : 1));
      position += rows.length;
      return {
        output: { name: rows[0].text, description: source.description ? rows[1].text : '' },
        usage: {
          billed_characters: rows.reduce((n, t) => n + t.billed_characters, 0),
          detected_source_languages: rows.map((t) => t.detected_source_language),
          models: rows.map((t) => t.model_type_used ?? null),
        },
      };
    });
  }
}
export function deepLBody(
  sources: { name: string; description: string }[],
  from: string,
  to: string,
  formality: string,
) {
  return {
    text: sources.flatMap((s) => (s.description ? [s.name, s.description] : [s.name])),
    source_lang: from.toUpperCase(),
    target_lang: to.toUpperCase(),
    formality,
    preserve_formatting: true,
    show_billed_characters: true,
  };
}
