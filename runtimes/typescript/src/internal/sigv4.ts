/**
 * AWS SigV4 request signing.
 *
 * One signer for every AWS call this runtime makes: Bedrock's Converse, the managed
 * knowledge-base readiness `GET`, and the `s3` source connector. The canonical
 * request has exactly one definition here, so a fix cannot land for one caller and
 * miss another -- and a source connector cannot compute a signature that disagrees
 * with the model adapter's about how a path or a query is encoded.
 *
 * `service`, `method` and `query` are parameters because all three are signed:
 * Converse is served by `bedrock-runtime` but signed as `bedrock`, and an s3 `GET`
 * signs its canonical query string. A caller that changed any of the three without
 * signing it would produce a signature the service rejects, so they are never
 * defaulted silently at the call site.
 */

import { createHash, createHmac } from 'node:crypto';

/** The identity a request is signed with. */
export interface Sigv4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface Sigv4Request {
  readonly url: string;
  /** The request body exactly as it is sent; `''` for a `GET`. */
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: Sigv4Credentials;
  /** Supplied by tests so a signature is reproducible. */
  readonly now: Date;
  /** Defaults to `POST`, the verb every JSON API behind this signer uses. */
  readonly method?: string;
  /** Already canonical: sorted by name and RFC 3986 encoded. */
  readonly query?: string;
}

/**
 * Percent-encode one path segment the way SigV4 defines it.
 *
 * `encodeURIComponent` leaves `!*'()` alone, and AWS does not: a signature over a
 * path the server decodes differently fails with `SignatureDoesNotMatch`.
 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20261102T051711Z`, the format SigV4 signs. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * The headers that authorize one request.
 *
 * The returned map is what the caller must send: every header named in
 * `SignedHeaders` has to reach the service with the value that was signed, so
 * returning them together is the only way to keep the two from drifting.
 */
export function sigv4Headers(request: Sigv4Request): Record<string, string> {
  const { url, body, region, service, credentials, now } = request;
  const method = request.method ?? 'POST';
  const query = request.query ?? '';
  const stamp = amzDate(now);
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const parsed = new URL(url);
  const canonicalHeaders: [string, string][] = [
    ['content-type', 'application/json'],
    ['host', parsed.host],
    ['x-amz-date', stamp],
  ];
  if (credentials.sessionToken !== undefined) {
    canonicalHeaders.push(['x-amz-security-token', credentials.sessionToken]);
  }
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
  const canonicalRequest = [
    method,
    parsed.pathname,
    query,
    canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    sha256Hex(body),
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-amz-date': stamp,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }
  return headers;
}
