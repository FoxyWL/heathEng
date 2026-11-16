'use strict';
// Облачные бэкапы: после каждого бэкапа копия уходит в S3-совместимое хранилище, оттуда её можно вернуть на ПК (и восстановить обычной кнопкой).
const path = require('path');
const { S3 } = require('./s3');

class Cloud {
  constructor({ store, backupDir, listLocal, onResult }) {
    this.store = store;
    this.backupDir = backupDir;
    this.listLocal = listLocal;
    this.onResult = onResult || (() => {});
    this.last = { ts: 0, name: '', ok: true, error: '' };
    this.busy = new Set();
  }

  get cfg() {
    const c = this.store.config;
    c.cloud = { enabled: false, endpoint: '', region: 'us-east-1', bucket: '', accessKey: '', secretKey: '', prefix: 'hearth/', keep: 14, ...(c.cloud || {}) };
    return c.cloud;
  }

  view() {
    const c = this.cfg;
    return { enabled: c.enabled, endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix, keep: c.keep, accessKey: c.accessKey, hasSecret: !!c.secretKey, last: this.last };
  }

  set(b) {
    const c = this.cfg;
    if (typeof b.endpoint === 'string') {
      const e = b.endpoint.trim().replace(/\/$/, '');
      if (e && !/^https?:\/\/[^\s/]+/i.test(e)) throw Object.assign(new Error('адрес хранилища: https://s3.example.com'), { status: 400 });
      c.endpoint = e;
    }
    for (const k of ['region', 'bucket', 'accessKey']) if (typeof b[k] === 'string') c[k] = b[k].trim();
    if (typeof b.secretKey === 'string' && b.secretKey.trim()) c.secretKey = b.secretKey.trim();
    if (typeof b.prefix === 'string') c.prefix = b.prefix.trim().replace(/^\/+/, '').replace(/[^\w./-]/g, '_');
    if (b.keep !== undefined) c.keep = Math.max(1, Math.min(1000, +b.keep || 14));
    if (typeof b.enabled === 'boolean') {
      if (b.enabled && !(c.endpoint && c.bucket && c.accessKey && c.secretKey)) throw Object.assign(new Error('заполните адрес, бакет и ключи'), { status: 400 });
      c.enabled = b.enabled;
    }
    this.store.saveConfig();
    return this.view();
  }

  client() {
    const c = this.cfg;
    if (!(c.endpoint && c.bucket && c.accessKey && c.secretKey)) throw Object.assign(new Error('облако не настроено'), { status: 409 });
    return new S3(c);
  }

  keyOf(serverId, name) {
    return `${this.cfg.prefix}${serverId}/${path.basename(name)}`;
  }

  async test() {
    await this.client().list(this.cfg.prefix, 1);
    return { ok: true };
  }

  async upload(serverId, name) {
    const id = serverId + '/' + name;
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const s3 = this.client();
      const file = path.join(this.backupDir(serverId), path.basename(name));
      const r = await s3.put(this.keyOf(serverId, name), file);
      // хранить в облаке не больше keep копий этого сервера
      const items = (await s3.list(`${this.cfg.prefix}${serverId}/`)).sort((a, b) => b.mtime - a.mtime);
      for (const old of items.slice(Math.max(1, +this.cfg.keep || 14))) await s3.del(old.key).catch(() => {});
      this.last = { ts: Date.now(), name, ok: true, error: '', size: r.size };
      this.onResult(this.last, serverId);
    } catch (e) {
      this.last = { ts: Date.now(), name, ok: false, error: e.message };
      this.onResult(this.last, serverId);
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }

  async list(serverId) {
    const items = await this.client().list(`${this.cfg.prefix}${serverId}/`);
    const local = new Set(this.listLocal(serverId).map((b) => b.name));
    return items.map((i) => ({ name: path.basename(i.key), size: i.size, mtime: i.mtime, local: local.has(path.basename(i.key)) })).sort((a, b) => b.mtime - a.mtime);
  }

  async pull(serverId, name) {
    const base = path.basename(name);
    await this.client().get(this.keyOf(serverId, base), path.join(this.backupDir(serverId), base));
    return { name: base };
  }

  async remove(serverId, name) {
    await this.client().del(this.keyOf(serverId, name));
  }

  /** После локального бэкапа: если включено, отправляем в облако, не задерживая основной бэкап. */
  afterBackup(server, name) {
    if (!this.cfg.enabled) return;
    this.upload(server.id, name).catch(() => {});
  }
}

module.exports = { Cloud };
