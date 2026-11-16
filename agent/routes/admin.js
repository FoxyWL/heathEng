'use strict';
// Маршруты управления Hearth: свой домен, уведомления, облачные бэкапы, пользователи и роли, доступ к панели, обновления.
const path = require('path');
const domainhelp = require('../lib/domainhelp');
const publicname = require('../lib/publicname');
const { listBackups } = require('../lib/scheduler');

module.exports = function adminRoutes({ on, store, mgr, tunnel, notifier, cloud, access, updater, sse, bind, port }) {
  on('POST', '/api/domain/check', async (c) => {
    const r = store.config.relay;
    if (!r.host) throw Object.assign(new Error('сначала подключитесь к релею'), { status: 409 });
    if (!tunnel.info.vhostPort) throw Object.assign(new Error('у этого релея нет общего порта с именами'), { status: 409 });
    const s = c.body.serverId ? mgr.rec(c.body.serverId) : null;
    const label = (s && (s.tunnel.subdomain || publicname.slug(s.name, 30))) || 'name';
    const ip = await domainhelp.relayIp(r.host).catch(() => { throw Object.assign(new Error('не удалось определить адрес релея'), { status: 502 }); });
    return domainhelp.check(c.body.host, { ip, vhostPort: tunnel.info.vhostPort, domain: tunnel.info.domain, label });
  });
  on('GET', '/api/notify', async () => notifier.view());
  on('PUT', '/api/notify', async (c) => notifier.set(c.body || {}));
  on('POST', '/api/notify/test', async () => {
    if (!notifier.cfg.targets.length) throw Object.assign(new Error('сначала добавьте получателя'), { status: 409 });
    return { sent: await notifier.test() };
  });
  on('GET', '/api/cloud', async () => cloud.view());
  on('PUT', '/api/cloud', async (c) => cloud.set(c.body || {}));
  on('POST', '/api/cloud/test', async () => cloud.test());
  on('GET', '/api/servers/:id/cloud-backups', async (c) => cloud.list(mgr.rec(c.params.id).id));
  on('POST', '/api/servers/:id/cloud-backups', async (c) => {
    const s = mgr.rec(c.params.id);
    const name = path.basename(String(c.body.name || ''));
    if (!listBackups(s.id).some((b) => b.name === name)) throw Object.assign(new Error('такого бэкапа нет на этом ПК'), { status: 404 });
    await cloud.upload(s.id, name);
    return cloud.list(s.id);
  });
  on('POST', '/api/servers/:id/cloud-backups/:name/pull', async (c) => cloud.pull(mgr.rec(c.params.id).id, c.params.name));
  on('DELETE', '/api/servers/:id/cloud-backups/:name', async (c) => {
    await cloud.remove(mgr.rec(c.params.id).id, c.params.name);
    return { ok: true };
  });
  on('GET', '/api/users', async () => ({ users: access.view(), servers: store.state.servers.map((s) => ({ id: s.id, name: s.name })) }));
  on('POST', '/api/users', async (c) => access.create(c.body || {}));
  on('PATCH', '/api/users/:id', async (c) => access.update(c.params.id, c.body || {}));
  on('POST', '/api/users/:id/token', async (c) => access.reissue(c.params.id));
  on('DELETE', '/api/users/:id', async (c) => {
    access.remove(c.params.id);
    for (const res of [...sse]) if (res.principal && !res.principal.admin && !access.users.includes(res.principal.user)) res.end(); // удалённого пользователя отключаем сразу
    return { ok: true };
  });
  on('GET', '/api/panel', async () => ({ lan: !!store.config.panel.lan, bind: bind, port: port(), restartNeeded: !!store.config.panel.lan !== (bind !== '127.0.0.1') }));
  on('PUT', '/api/panel', async (c) => {
    if (typeof (c.body || {}).lan === 'boolean') {
      store.config.panel.lan = c.body.lan;
      store.saveConfig();
    }
    return { lan: !!store.config.panel.lan, bind: bind, port: port(), restartNeeded: !!store.config.panel.lan !== (bind !== '127.0.0.1') };
  });
  on('GET', '/api/update', async () => updater.view());
  on('POST', '/api/update/check', async () => updater.check());
  on('POST', '/api/update/install', async () => updater.install());
  on('PUT', '/api/update', async (c) => {
    const b = c.body || {};
    if (typeof b.auto === 'boolean') updater.setAuto(b.auto);
    if (typeof b.skip === 'string') updater.skip(b.skip);
    return updater.view();
  });
};
