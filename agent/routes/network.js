'use strict';
// Маршруты сети: адреса и приоритеты, проверка доступа, hosts, имя сервера, значки, публичное имя, релей на этом ПК, прямой доступ из интернета.

module.exports = function networkRoutes(ctx) {
  const { badRequest, publicIpOfServers, catalog, emit, icons, mgr, netaccess, netname, netwatch, on, pub, publicname, relayHost, store } = ctx;
  on('GET', '/api/network', async () => {
    const addresses = netaccess.addresses();
    const primary = addresses.find((a) => a.primary);
    const entries = netaccess.readHosts();
    const hosts = {};
    if (primary) {
      hosts[primary.fqdn] = netaccess.hostsState(primary.fqdn, primary.ip, entries);
      for (const s of store.state.servers) if (s.netName) hosts[s.netName] = netaccess.hostsState(s.netName, primary.ip, entries);
    }
    return { preferred: (store.config.net || {}).preferred || '', hostname: require('os').hostname(), suffix: netname.SUFFIX, addresses, windows: process.platform === 'win32', beta: store.config.beta, hosts, lastIp: (store.config.net || {}).lastIp || '' };
  });
  // Закрепить адрес основным (например, проводной вместо Wi-Fi) или вернуть автовыбор
  on('PUT', '/api/network/preferred', async (c) => {
    const ip = String((c.body && c.body.ip) || '').trim();
    if (ip && !netaccess.addresses('').some((a) => a.ip === ip)) throw Object.assign(new Error('такого адреса у этого ПК нет'), { status: 400 });
    store.config.net.preferred = ip;
    store.saveConfig();
    netwatch.checkIp();
    return { preferred: ip };
  });
  on('GET', '/api/network/resolve', async (c) => {
    try {
      const ip = netname.nameToIp(c.query.get('name') || '');
      return { ip, fqdn: netname.fqdn(ip) };
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: 400 });
    }
  });
  on('GET', '/api/servers/:id/reach', async (c) => {
    const s = mgr.rec(c.params.id);
    const state = mgr.view(s).state;
    const r = await netaccess.reach(catalog.portsOf(s.game, s.settings), ['running', 'starting'].includes(state));
    const fw = await netaccess.firewallState(netaccess.firewallRules(s.name, catalog.portsOf(s.game, s.settings)));
    return { state, ...r, firewall: fw };
  });
  on('POST', '/api/servers/:id/firewall', async (c) => {
    const s = mgr.rec(c.params.id);
    const action = c.body && c.body.action === 'close' ? 'close' : 'open';
    const rules = netaccess.firewallRules(s.name, catalog.portsOf(s.game, s.settings));
    if (!rules.length) throw Object.assign(new Error('у сервера нет портов TCP или UDP'), { status: 400 });
    if (process.platform !== 'win32') {
      return { executed: false, rules: rules.map((r) => r.name), commands: rules.map((r) => `ufw ${action === 'open' ? 'allow' : 'delete allow'} ${r.port}/${r.proto.toLowerCase()}`) };
    }
    const res = await netaccess.elevated(rules.map(action === 'open' ? netaccess.netshAdd : netaccess.netshDel));
    return { ...res, rules: rules.map((r) => r.name) };
  });
  on('POST', '/api/network/hosts', async (c) => {
    const ip = String((c.body && c.body.ip) || '').trim();
    if (!netname.parseIp(ip) || ip === '0.0.0.0' || ip.startsWith('127.')) throw Object.assign(new Error('нужен IPv4-адрес сервера в сети'), { status: 400 });
    const action = c.body.action === 'remove' ? 'remove' : 'add';
    let name = netname.fqdn(ip);
    if (c.body.name) {
      name = badRequest(() => netname.parseCustom(c.body.name, { anyZone: store.config.beta.anyZone })).host;
    }
    const line = netaccess.hostsLine(ip, name);
    if (process.platform !== 'win32') return { executed: false, commands: [`${action === 'add' ? 'echo' : 'remove:'} ${line} (${netaccess.hostsPath()})`], line, fqdn: name };
    const res = await netaccess.elevated(netaccess.hostsCommands(ip, action, name));
    return { ...res, line, fqdn: name };
  });

  // Своё имя сервера. Всем: <имя>.hearth[:порт]. Бета (администратор): любая зона, например soskacraft.mc:25570. Пустое имя возвращает автоимя.
  on('GET', '/api/beta', async () => store.config.beta);
  on('PUT', '/api/beta', async (c) => {
    if (c.body && typeof c.body.anyZone === 'boolean') store.config.beta.anyZone = c.body.anyZone;
    store.saveConfig();
    return store.config.beta;
  });
  on('PUT', '/api/servers/:id/netname', async (c) => {
    const s = mgr.rec(c.params.id);
    const raw = String((c.body && c.body.name) || '').trim();
    if (!raw) {
      delete s.netName;
      store.saveState();
      return mgr.update(s.id, {});
    }
    const { host, port } = badRequest(() => netname.parseCustom(raw, { anyZone: store.config.beta.anyZone }));
    if (mgr.list().some((o) => o.id !== s.id && o.netName === host)) throw Object.assign(new Error(`имя ${host} уже занято другим сервером`), { status: 409 });
    let restart = false;
    if (port !== null) {
      const f = catalog.games[s.game].fields.find((x) => x.key === 'port');
      if (!f) throw Object.assign(new Error('у этой игры порт меняется в разделе «Запуск»: укажите имя без порта'), { status: 400 });
      if (port < (f.min || 1) || port > (f.max || 65535)) throw Object.assign(new Error(`порт для этой игры: ${f.min || 1}–${f.max || 65535}`), { status: 400 });
      const busy = mgr.list().find((o) => o.id !== s.id && catalog.portsOf(o.game, o.settings).some((p) => p.port === port && p.proto === 'tcp'));
      if (busy) throw Object.assign(new Error(`порт ${port} уже занят сервером «${busy.name}»`), { status: 409 });
      if (+s.settings.port !== port) {
        mgr.update(s.id, { settings: { port } });
        restart = ['running', 'starting'].includes(mgr.view(s).state);
      }
    }
    s.netName = host;
    store.saveState();
    return { ...mgr.update(s.id, {}), host, port, restartRequired: restart };
  });

  // Значки игр: отдают картинку или 404 (тогда панель рисует свою плитку)
  on('GET', '/api/games/:game/icon', async (c) => ({ __icon: await icons.forGame(c.params.game) }));
  on('GET', '/api/servers/:id/icon', async (c) => ({ __icon: await icons.forServer(mgr.rec(c.params.id)) }));
  on('PUT', '/api/servers/:id/icon', async (c) => {
    const s = mgr.rec(c.params.id);
    const b = c.body || {};
    if (b.steamApp !== undefined) await icons.setFromSteam(s.id, +b.steamApp);
    else {
      const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String(b.dataUrl || ''));
      if (!m) throw Object.assign(new Error('нужна картинка (dataUrl) или номер игры в Steam'), { status: 400 });
      icons.setCustom(s.id, Buffer.from(m[1], 'base64'));
    }
    s.iconRev = (s.iconRev || 0) + 1;
    store.saveState();
    return mgr.update(s.id, {});
  });
  on('DELETE', '/api/servers/:id/icon', async (c) => {
    const s = mgr.rec(c.params.id);
    icons.clearCustom(s.id);
    s.iconRev = (s.iconRev || 0) + 1;
    store.saveState();
    return mgr.update(s.id, {});
  });
  on('GET', '/api/icons/search', async (c) => icons.searchSteam(c.query.get('term')));

  // Публичное имя вместо IP (sslip.io без регистрации или DuckDNS со своим именем)
  const refreshServers = () => store.state.servers.forEach((s) => emit('state', mgr.view(s)));
  on('GET', '/api/publicname', async () => publicname.view());
  on('PUT', '/api/publicname', async (c) => {
    publicname.set(c.body || {});
    const cfg = store.config.publicName;
    if (cfg.mode === 'duckdns' && cfg.duckSub && cfg.duckToken) await publicname.updateDuck(publicIpOfServers());
    refreshServers();
    emit('publicname', publicname.view());
    return publicname.view();
  });
  on('POST', '/api/publicname/check', async (c) => {
    const s = mgr.rec(c.body && c.body.id);
    const host = publicname.hostFor(s);
    if (!host) throw Object.assign(new Error('сначала откройте порты сервера из интернета'), { status: 409 });
    return publicname.verify(host, s.publicIp.ext);
  });

  // «Стать релеем»: релей Hearth на этом ПК для друзей
  on('GET', '/api/relayhost', async () => relayHost.view());
  on('POST', '/api/relayhost/start', async (c) => {
    if (c.body && (c.body.portMin || c.body.portMax || c.body.controlPort || c.body.vhostPort !== undefined)) relayHost.setPorts(c.body);
    return relayHost.start();
  });
  on('POST', '/api/relayhost/stop', async () => relayHost.stop());
  on('POST', '/api/relayhost/token', async () => relayHost.newToken());
  on('PUT', '/api/relayhost', async (c) => relayHost.setPorts(c.body || {}));

  // Доступ из интернета напрямую (UPnP): проверка и открытие портов сервера одной кнопкой
  on('GET', '/api/public', async () => pub.check());
  on('POST', '/api/servers/:id/public', async (c) => {
    const s = mgr.rec(c.params.id);
    if (c.body && c.body.enabled === false) await pub.close(s);
    else await pub.open(s);
    return mgr.update(s.id, {});
  });

};
