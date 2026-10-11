import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import crypto from 'node:crypto';

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_ALLOWED_PORTS = new Set(['', '443']);

function ipv4Parts(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => part >= 0 && part <= 255) ? parts : null;
}

function ipv4Number(parts) {
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value, network, prefix) {
  const parts = ipv4Parts(value);
  if (!parts) return false;
  const address = ipv4Number(parts);
  const base = ipv4Number(network.split('.').map(Number));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function isForbiddenIpv4(value) {
  const parts = ipv4Parts(value);
  if (!parts) return false;
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ].some(([network, prefix]) => inIpv4Range(value, network, prefix));
}

function ipv6Number(value) {
  let input = value.toLowerCase();
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const parts = ipv4Parts(input.slice(lastColon + 1));
    if (!parts) return null;
    const first = ((parts[0] << 8) | parts[1]).toString(16);
    const second = ((parts[2] << 8) | parts[3]).toString(16);
    input = `${input.slice(0, lastColon)}:${first}:${second}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const segments = [...left, ...Array(zeros).fill('0'), ...right];
  if (segments.length !== 8 || segments.some(item => !/^[0-9a-f]{1,4}$/.test(item))) return null;
  return segments.reduce((number, item) => (number << 16n) | BigInt(`0x${item}`), 0n);
}

function isForbiddenIp(value) {
  const normalized = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(normalized) === 4) return isForbiddenIpv4(normalized);
  if (net.isIP(normalized) === 6) {
    const address = ipv6Number(normalized);
    if (address === null) return true;
    const mappedPrefix = address >> 32n;
    if (mappedPrefix === 0xffffn) {
      const v4 = Number(address & 0xffffffffn);
      return isForbiddenIpv4(`${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
    }
    // Only global unicast 2000::/3 is routable for public retrieval. Exclude
    // documentation, transition, and other special-purpose subranges.
    const outsideGlobalUnicast = (address >> 125n) !== 1n;
    const first = Number((address >> 112n) & 0xffffn);
    const second = Number((address >> 96n) & 0xffffn);
    const documentation = first === 0x2001 && second >= 0x0db8 && second <= 0x0dbf;
    const special2001 = first === 0x2001 && second <= 0x01ff;
    const transition6to4 = first === 0x2002;
    const documentation3fff = first === 0x3fff && second <= 0x0fff;
    return outsideGlobalUnicast || documentation || special2001 || transition6to4 || documentation3fff;
  }
  return false;
}

export function validatePublicUrl(rawUrl, { allowedPorts = DEFAULT_ALLOWED_PORTS } = {}) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    const error = new Error('Public document URL is invalid.');
    error.code = 'RESEARCH_URL_REJECTED';
    throw error;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || isForbiddenIp(hostname)) {
    const error = new Error('Public document URL resolves to a private or loopback address.');
    error.code = 'RESEARCH_SSRF_BLOCKED';
    throw error;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowedPorts.has(parsed.port)) {
    const error = new Error('Public document URL is not allowed.');
    error.code = 'RESEARCH_URL_REJECTED';
    throw error;
  }
  parsed.hash = '';
  return parsed;
}

export async function assertSafePublicUrl(rawUrl, { dnsLookup = dns.lookup, allowedPorts = DEFAULT_ALLOWED_PORTS } = {}) {
  const parsed = validatePublicUrl(rawUrl, { allowedPorts });
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return parsed;
  let records;
  try { records = await dnsLookup(hostname, { all: true, verbatim: true }); } catch {
    const error = new Error('Public document hostname could not be resolved.');
    error.code = 'RESEARCH_HOST_UNRESOLVED';
    throw error;
  }
  if (!records?.length || records.some(record => isForbiddenIp(record.address))) {
    const error = new Error('Public document hostname resolves to a private or loopback address.');
    error.code = 'RESEARCH_SSRF_BLOCKED';
    throw error;
  }
  return parsed;
}

async function resolvePinnedAddress(hostname, dnsLookup) {
  if (net.isIP(hostname)) {
    if (isForbiddenIp(hostname)) throw Object.assign(new Error('Public document URL resolves to a private or special-purpose address.'), { code: 'RESEARCH_SSRF_BLOCKED' });
    return { address: hostname, family: net.isIP(hostname) };
  }
  let records;
  try { records = await dnsLookup(hostname, { all: true, verbatim: true }); } catch {
    throw Object.assign(new Error('Public document hostname could not be resolved.'), { code: 'RESEARCH_HOST_UNRESOLVED' });
  }
  if (!records?.length || records.some(record => isForbiddenIp(record.address))) {
    throw Object.assign(new Error('Public document hostname resolves to a private or special-purpose address.'), { code: 'RESEARCH_SSRF_BLOCKED' });
  }
  const selected = records.find(record => net.isIP(record.address) === 4) || records[0];
  return { address: selected.address, family: net.isIP(selected.address) };
}

function raceWithSignal(value, signal, code = 'RESEARCH_FETCH_TIMEOUT') {
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('Research document fetch was canceled or timed out.'), { code }));
    const onAbort = () => reject(Object.assign(new Error('Research document fetch was canceled or timed out.'), { code }));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      result => { signal.removeEventListener('abort', onAbort); resolve(result); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function requestPinnedHttps(url, { method = 'GET', headers = {}, body, signal, maxBytes, timeoutMs, dnsLookup = dns.lookup, httpsRequest = https.request } = {}) {
  const deadline = Date.now() + timeoutMs;
  if (signal?.aborted) throw Object.assign(new Error('Research network request was aborted.'), { name: 'AbortError', code: 'RESEARCH_FETCH_ABORTED' });
  let dnsTimer;
  let removeAbort;
  let pinned;
  try {
    pinned = await Promise.race([
      resolvePinnedAddress(url.hostname.replace(/^\[|\]$/g, ''), dnsLookup),
      new Promise((_, reject) => {
        dnsTimer = setTimeout(() => reject(Object.assign(new Error('Research network request timed out.'), { name: 'AbortError', code: 'RESEARCH_FETCH_TIMEOUT' })), Math.max(1, deadline - Date.now()));
        if (signal) {
          const abort = () => reject(Object.assign(new Error('Research network request was aborted.'), { name: 'AbortError', code: 'RESEARCH_FETCH_ABORTED' }));
          signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', abort);
        }
      }),
    ]);
  } finally {
    clearTimeout(dnsTimer);
    removeAbort?.();
  }
  if (signal?.aborted) throw Object.assign(new Error('Research network request was aborted.'), { name: 'AbortError', code: 'RESEARCH_FETCH_ABORTED' });
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('Research network request timed out.'), { name: 'AbortError', code: 'RESEARCH_FETCH_TIMEOUT' });
      request?.destroy(error);
      finish(error);
    }, Math.max(1, deadline - Date.now()));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      const error = Object.assign(new Error('Research network request was aborted.'), { name: 'AbortError', code: 'RESEARCH_FETCH_ABORTED' });
      request?.destroy(error);
      finish(error);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (settled) return;
      if (signal?.aborted) return abort();
      request = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname.replace(/^\[|\]$/g, ''),
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        const chunks = [];
        let total = 0;
        response.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) {
            const error = Object.assign(new Error('Research response exceeds the configured byte limit.'), { code: 'RESEARCH_RESPONSE_TOO_LARGE' });
            response.destroy(error);
            request.destroy(error);
            finish(error);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(null, {
          status: Number(response.statusCode || 0),
          headers: response.headers,
          body: Buffer.concat(chunks, total),
        }));
        response.on('error', error => finish(error));
      });
      request.on('error', error => finish(error));
      request.end(body);
    } catch (error) { finish(error); }
  });
}

async function readBoundedBody(response, maxBytes, { signal = null } = {}) {
  if (!response.body?.getReader) {
    let content;
    if (typeof response.arrayBuffer === 'function') content = await raceWithSignal(response.arrayBuffer(), signal);
    else if (typeof response.text === 'function') content = await raceWithSignal(response.text(), signal);
    else content = '';
    const buffer = Buffer.from(content);
    if (buffer.length > maxBytes) throw Object.assign(new Error('Research document exceeds the response size limit.'), { code: 'RESEARCH_RESPONSE_TOO_LARGE' });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    let chunk;
    try { chunk = await raceWithSignal(reader.read(), signal); } catch (error) {
      if (signal?.aborted) await reader.cancel().catch(() => {});
      throw error;
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error('Research document exceeds the response size limit.'), { code: 'RESEARCH_RESPONSE_TOO_LARGE' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export class SafePublicDocumentFetcher {
  constructor({ fetchImpl = null, dnsLookup = dns.lookup, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = DEFAULT_MAX_REDIRECTS, extraContentTypes = [], env = process.env } = {}) {
    if (fetchImpl && env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Production ResearchMesh must use the DNS-pinned HTTPS transport.'), { code: 'RESEARCH_TRANSPORT_CONFIGURATION_INVALID' });
    }
    this.fetchImpl = fetchImpl;
    this.dnsLookup = dnsLookup;
    this.maxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES));
    this.timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const configuredRedirects = Number(maxRedirects);
    this.maxRedirects = Math.min(DEFAULT_MAX_REDIRECTS, Math.max(0, Number.isFinite(configuredRedirects) ? configuredRedirects : DEFAULT_MAX_REDIRECTS));
    this.extraContentTypes = [...new Set(extraContentTypes.map(value => String(value).trim().toLowerCase()))];
    if (this.extraContentTypes.some(value => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value))) {
      throw Object.assign(new Error('Research fetcher extra content types are invalid.'), { code: 'RESEARCH_TRANSPORT_CONFIGURATION_INVALID' });
    }
    this.acceptHeader = ['text/html', 'text/plain', 'application/json;q=0.9', ...this.extraContentTypes.map(type => `${type};q=0.8`)].join(', ');
  }

  async fetchDocument(rawUrl, { signal } = {}) {
    const requestedUrl = validatePublicUrl(rawUrl).toString();
    let current = requestedUrl;
    const deadline = Date.now() + this.timeoutMs;
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const safeUrl = validatePublicUrl(current);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw Object.assign(new Error('Research document fetch timed out.'), { code: 'RESEARCH_FETCH_TIMEOUT' });
      let response;
      try {
        if (this.fetchImpl) {
          let dnsTimer;
          try {
            await Promise.race([
              assertSafePublicUrl(safeUrl.toString(), { dnsLookup: this.dnsLookup }),
              new Promise((_, reject) => {
                dnsTimer = setTimeout(() => reject(Object.assign(new Error('Research DNS resolution timed out.'), { code: 'RESEARCH_FETCH_TIMEOUT' })), remainingMs);
              }),
            ]);
          } finally {
            clearTimeout(dnsTimer);
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), remainingMs);
          const combinedSignal = signal && AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : (signal || controller.signal);
          try {
            response = await raceWithSignal(this.fetchImpl(safeUrl, {
              redirect: 'manual',
              signal: combinedSignal,
              headers: { accept: this.acceptHeader, 'user-agent': 'WealthGenie-ResearchMesh/1.0' },
            }), combinedSignal);
            const isRedirect = response.status >= 300 && response.status < 400;
            const body = isRedirect || !response.ok ? Buffer.alloc(0) : await readBoundedBody(response, this.maxBytes, { signal: combinedSignal });
            response = {
              status: response.status,
              ok: response.ok,
              headers: response.headers,
              bodyBytes: body,
            };
          } finally {
            clearTimeout(timer);
          }
        } else {
          response = await requestPinnedHttps(safeUrl, {
            dnsLookup: this.dnsLookup,
            maxBytes: this.maxBytes,
            timeoutMs: remainingMs,
            signal,
            headers: { accept: this.acceptHeader, 'user-agent': 'WealthGenie-ResearchMesh/1.0' },
          });
          response.ok = response.status >= 200 && response.status < 300;
          response.bodyBytes = response.body;
        }
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('Research document fetch was canceled.'), { code: 'RESEARCH_CANCELED' });
        if (error?.name === 'AbortError' || error?.code === 'RESEARCH_FETCH_TIMEOUT') throw Object.assign(new Error('Research document fetch timed out.'), { code: 'RESEARCH_FETCH_TIMEOUT' });
        throw Object.assign(new Error('Research document fetch failed.'), { code: 'RESEARCH_FETCH_FAILED', cause: error });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location') || response.headers?.location;
        if (!location || redirectCount >= this.maxRedirects) throw Object.assign(new Error('Research document redirect chain is not allowed.'), { code: 'RESEARCH_REDIRECT_REJECTED' });
        current = new URL(location, safeUrl).toString();
        continue;
      }
      if (!response.ok) throw Object.assign(new Error('Research document returned an error status.'), { code: 'RESEARCH_DOCUMENT_UNAVAILABLE' });
      const rawContentType = response.headers?.get?.('content-type') || response.headers?.['content-type'] || '';
      const contentType = String(rawContentType).split(';')[0].trim().toLowerCase();
      if (!(contentType === 'text/html' || contentType === 'text/plain' || contentType === 'application/json'
          || contentType.startsWith('text/') || this.extraContentTypes.includes(contentType))) {
        throw Object.assign(new Error('Research document content type is not supported.'), { code: 'RESEARCH_CONTENT_TYPE_REJECTED' });
      }
      const bytes = response.bodyBytes || await readBoundedBody(response, this.maxBytes);
      const body = bytes.toString('utf8');
      if (!Buffer.from(body, 'utf8').equals(bytes)) {
        throw Object.assign(new Error('Research document is not valid UTF-8.'), { code: 'RESEARCH_DOCUMENT_ENCODING_INVALID' });
      }
      return {
        requestedUrl,
        url: safeUrl.toString(),
        contentType,
        statusCode: response.status,
        redirectCount,
        rawBodySha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        body,
        retrievedAt: new Date().toISOString(),
      };
    }
    throw Object.assign(new Error('Research document redirect chain is not allowed.'), { code: 'RESEARCH_REDIRECT_REJECTED' });
  }
}

export { requestPinnedHttps };
