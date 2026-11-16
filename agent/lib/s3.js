'use strict';
// Минимальный клиент S3 (подпись AWS Signature V4, адресация «путь/бакет/ключ»): AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO и другие S3-совместимые хранилища.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

function fileSha256(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

class S3 {
  constructor({ endpoint, region, bucket, accessKey, secretKey }) {
    this.u = new URL(endpoint);
    this.region = region || 'us-east-1';
    this.bucket = bucket;
    this.ak = accessKey;
    this.sk = secretKey;
  }

  /** Заголовки с подписью для запроса method path?query с телом, хэш которого payloadHash. */
  sign(method, pathname, query, payloadHash, extra = {}) {
    const now = new Date();
    const amz = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amz.slice(0, 8);
    const headers = { host: this.u.host, 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash, ...extra };
    const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    const canonHeaders = names.map((k) => `${k}:${String(headers[Object.keys(headers).find((x) => x.toLowerCase() === k)]).trim()}\n`).join('');
    const signed = names.join(';');
    const cq = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const canon = [method, pathname, cq, canonHeaders, signed, payloadHash].join('\n');
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amz, scope, hex(canon)].join('\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + this.sk, day), this.region), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.ak}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', key).update(sts).digest('hex')}`;
    return { headers, cq };
  }

  request(method, key, { query = {}, body = null, payloadHash, extra = {}, stream = false } = {}) {
    const base = this.u.pathname.replace(/\/$/, '');
    const pathname = `${base}/${enc(this.bucket)}${key ? '/' + encPath(key) : ''}`;
    const { headers, cq } = this.sign(method, pathname, query, payloadHash || hex(body || ''), extra);
    const lib = this.u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request({ protocol: this.u.protocol, hostname: this.u.hostname, port: this.u.port || undefined, method, path: pathname + (cq ? '?' + cq : ''), headers }, (res) => {
        if (stream && res.statusCode < 300) return resolve(res);
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (res.statusCode >= 300) {
            const code = (/<Code>([^<]+)<\/Code>/.exec(b) || [])[1];
            const msg = (/<Message>([^<]+)<\/Message>/.exec(b) || [])[1];
            return reject(Object.assign(new Error(`S3: ${res.statusCode}${code ? ' ' + code : ''}${msg ? ': ' + msg : ''}`), { status: 502, s3: res.statusCode }));
          }
          resolve({ status: res.statusCode, body: b });
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error('S3: нет ответа 30 секунд')));
      req.on('error', reject);
      if (body && !body.pipe) req.end(body);
      else if (body) pipeline(body, req).catch(reject);
      else req.end();
    });
  }

  async put(key, file) {
    const size = fs.statSync(file).size;
    const hash = await fileSha256(file);
    await this.request('PUT', key, { body: fs.createReadStream(file), payloadHash: hash, extra: { 'content-length': size, 'content-type': 'application/gzip' } });
    return { size };
  }

  async get(key, dest) {
    const res = await this.request('GET', key, { payloadHash: hex(''), stream: true });
    const tmp = dest + '.part';
    try {
      await pipeline(res, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  async del(key) {
    await this.request('DELETE', key, {});
  }

  async list(prefix, max = 1000) {
    const r = await this.request('GET', '', { query: { 'list-type': '2', prefix, 'max-keys': String(max) } });
    const out = [];
    for (const m of r.body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = (/<Key>([^<]*)<\/Key>/.exec(m[1]) || [])[1];
      const size = +(/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1] || 0;
      const lm = (/<LastModified>([^<]*)<\/LastModified>/.exec(m[1]) || [])[1];
      if (k) out.push({ key: k.replace(/&amp;/g, '&'), size, mtime: lm ? Date.parse(lm) : 0 });
    }
    return out;
  }
}

module.exports = { S3 };
