'use strict';
// @imports:start
import { gameBadge } from './gameicons.js';
import { icon } from './icons.js';
import { STATE, T, api, askConfirm, click, copy, h, lab, toast } from './lib.js';
import { go } from './shell.js';
import { S, fill, ui } from './state.js';
// @imports:end
// Сеть: адреса этого ПК и их короткие имена, проверка, что сервер доступен по адресу в сети, брандмауэр и запись имени в hosts.

const KIND = () => ({
  private: [T('Домашняя сеть', 'Home network'), 'ok'],
  public: [T('Внешний адрес', 'Public address'), 'ok'],
  cgnat: [T('Адрес провайдера (CGNAT): из интернета не откроется', 'Carrier address (CGNAT): not reachable from the internet'), 'warn'],
  linklocal: [T('Сеть не настроена (169.254…)', 'No network configured (169.254…)'), 'bad'],
});

const STATUS = () => ({
  ok: [T('Доступен в сети', 'Reachable on the network'), 'ok'],
  'loopback-only': [T('Слушает только этот ПК: друзья не подключатся', 'Listens on this PC only: friends cannot connect'), 'bad'],
  closed: [T('Порт не отвечает', 'Port does not answer'), 'bad'],
  udp: [T('UDP: проверить нельзя', 'UDP: cannot be checked'), 'dim'],
  stopped: [T('Сервер остановлен', 'Server is stopped'), 'dim'],
});

const advice = (s, st) => {
  if (st === 'loopback-only') return s.game.startsWith('minecraft') ? T('Откройте server.properties: поле server-ip должно быть пустым.', 'Open server.properties: the server-ip field must be empty.') : T('Запустите сервер с адресом 0.0.0.0 (а не 127.0.0.1 или localhost).', 'Start the server on 0.0.0.0 (not 127.0.0.1 or localhost).');
  if (st === 'closed') return T('Подождите, пока сервер запустится, или проверьте порт в настройках.', 'Wait until the server has started, or check the port in the settings.');
  return '';
};

export async function networkPage() {
  const page = h('div', { class: 'page net' });
  ui.main.replaceChildren(page);
  ui.onState = null;
  let net = null;
  const reach = {};
  const alive = () => page.isConnected && S.view === 'network';
  ui.redrawNet = async () => {
    if (!alive()) return;
    try {
      net = await api('GET', '/api/network');
      S.net = net;
    } catch {
      return;
    }
    draw();
  };
  const HOSTS = () => ({
    ok: [T('включено на этом ПК', 'enabled on this PC'), 'ok'],
    stale: [T('ведёт на старый IP: обновите', 'points to an old IP: update'), 'bad'],
    missing: [T('на этом ПК не включено', 'not enabled on this PC'), 'dim'],
  });
  const hostsBadge = (name) => {
    const st = net.hosts && net.hosts[name];
    if (!st) return null;
    const [label, tone] = HOSTS()[st];
    return h('small', { class: 'tone-' + tone, 'data-hosts': st }, label);
  };
  const FW = () => ({
    present: [T('Брандмауэр: порты открыты', 'Firewall: ports open'), 'ok'],
    missing: [T('Брандмауэр: правила нет, друзья могут не пройти', 'Firewall: no rule, friends may be blocked'), 'warn'],
  });

  const copyBtn = (text, label) => h('button', { class: 'btn sm', title: text, on: { click: (e) => copy(text, e.currentTarget) } }, icon('copy', 14), label || T('Копировать', 'Copy'));

  const runElevated = (title, text, path, body, okMsg) => click(async () => {
    if (!(await askConfirm({ title, text, ok: T('Продолжить', 'Continue') }))) return;
    const r = await api('POST', path, body);
    if (r.executed) return toast(okMsg);
    if (r.error) return toast(r.error, true);
    await copy((r.commands || []).join('\n'));
    toast(T('На этой системе выполните команды вручную (скопированы в буфер)', 'On this system run the commands by hand (copied to the clipboard)'));
  });

  const check = async (id) => {
    try {
      reach[id] = await api('GET', `/api/servers/${id}/reach`);
    } catch (e) {
      reach[id] = { error: e.message, ports: [] };
    }
    if (alive()) drawServers();
  };

  const addrCards = () => net.addresses.length
    ? net.addresses.map((a) => {
      const [kind, tone] = KIND()[a.kind];
      return h('article', { class: 'addr-card' + (a.primary ? ' primary' : ''), 'data-ip': a.ip },
        h('div', { class: 'ac-top' }, h('b', { class: 'mono' }, a.ip), a.primary ? h('span', { class: 'badge running' }, T('основной', 'main')) : null, a.virtual ? h('span', { class: 'badge' }, T('виртуальный', 'virtual')) : null),
        h('div', { class: 'ac-name' }, h('span', { class: 'mono' }, a.fqdn), copyBtn(a.fqdn)),
        a.primary ? hostsBadge(a.fqdn) : null,
        h('small', { class: 'tone-' + tone }, `${kind} · ${a.iface}`));
    })
    : [h('p', { class: 'muted' }, T('Сетевых адресов не найдено: подключите ПК к сети.', 'No network addresses found: connect the PC to a network.'))];

  const decoded = h('div', { class: 'decoded', 'aria-live': 'polite' });
  const nameIn = h('input', { type: 'text', placeholder: 'sajiba-feleesee.hearth', spellcheck: false, 'aria-label': T('Имя сервера', 'Server name'), autocomplete: 'off' });
  const decode = async () => {
    const v = nameIn.value.trim();
    if (!v) return fill(decoded);
    try {
      const r = await api('GET', '/api/network/resolve?name=' + encodeURIComponent(v));
      fill(decoded, h('span', {}, T('Адрес: ', 'Address: '), h('b', { class: 'mono', 'data-resolved': r.ip }, r.ip)), copyBtn(r.ip, T('Копировать IP', 'Copy IP')));
    } catch (e) {
      fill(decoded, h('span', { class: 'tone-bad' }, e.message));
    }
  };
  nameIn.addEventListener('keydown', (e) => e.key === 'Enter' && decode());
  nameIn.addEventListener('input', decode);

  const hostOf = (s) => s.netName || (net.addresses.find((a) => a.primary) || {}).fqdn;
  const saveName = async (s, name) => {
    const r = await api('PUT', `/api/servers/${s.id}/netname`, { name });
    const i = S.servers.findIndex((x) => x.id === s.id);
    if (i >= 0 && r.id) S.servers[i] = { ...S.servers[i], ...r };
    toast(name ? T(`Имя ${r.host} сохранено` + (r.restartRequired ? '. Перезапустите сервер: порт изменился' : ''), `Name ${r.host} saved` + (r.restartRequired ? '. Restart the server: the port changed' : '')) : T('Автоимя возвращено', 'Automatic name restored'));
    if (alive()) drawServers();
  };
  const nameEditor = (s) => {
    const inp = h('input', { type: 'text', value: s.netName || '', placeholder: net.beta && net.beta.anyZone ? 'soskacraft  ·  soskacraft.mc:25570' : 'soskacraft', spellcheck: false, autocomplete: 'off', 'aria-label': T('Своё имя сервера', 'Custom server name'), 'data-role': 'netname' });
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && e.currentTarget.parentElement.querySelector('[data-act=name-save]').click());
    return h('div', { class: 'name-edit' },
      h('label', {}, T('Своё имя', 'Custom name'), net.beta && net.beta.anyZone ? h('span', { class: 'badge beta', title: T('Свои зоны (.mc и другие) пока доступны только администратору', 'Custom zones (.mc and others) are admin-only for now') }, T('бета: любые зоны', 'beta: any zone')) : null),
      h('div', { class: 'searchbar grow' }, icon('link', 16), inp),
      h('button', { class: 'btn sm', 'data-act': 'name-save', on: { click: click(() => saveName(s, inp.value)) } }, T('Сохранить', 'Save')),
      s.netName ? h('button', { class: 'btn sm ghost', 'data-act': 'name-reset', on: { click: click(() => saveName(s, '')) } }, T('Сбросить', 'Reset')) : null,
      s.netName ? hostsBadge(s.netName) : null,
      h('small', { class: 'muted' }, T(`Автоимя: ${(net.addresses.find((a) => a.primary) || {}).fqdn || '—'}. Можно написать только слово (будет .${net.suffix}) и порт через двоеточие.`, `Automatic: ${(net.addresses.find((a) => a.primary) || {}).fqdn || '—'}. Type just a word (it gets .${net.suffix}) and a port after a colon.`)));
  };
  const srvHost = h('div', { class: 'net-servers' });
  function drawServers() {
    const primary = net && net.addresses.find((a) => a.primary);
    fill(srvHost, S.servers.length ? S.servers.map((s) => {
      const r = reach[s.id];
      const rows = r && r.ports ? r.ports : null;
      const live = ['running', 'starting'].includes(s.state);
      return h('article', { class: 'net-srv', 'data-server': s.id },
        h('div', { class: 'ns-head' }, gameBadge(s.game, 'sm'), h('b', {}, s.name), h('span', { class: 'badge ' + s.state }, STATE()[s.state] || s.state),
          h('span', { class: 'ns-actions' },
            r && r.firewall && FW()[r.firewall] ? h('small', { class: 'tone-' + FW()[r.firewall][1], 'data-fw': r.firewall }, FW()[r.firewall][0]) : null,
            h('button', { class: 'btn sm', 'data-act': 'check', on: { click: click(() => check(s.id)) } }, icon('refresh', 14), T('Проверить', 'Check')),
            h('button', { class: 'btn sm', 'data-act': 'fw-open', title: T('Разрешить входящие подключения к портам сервера', 'Allow inbound connections to the server ports'), on: { click: runElevated(T('Открыть порты в брандмауэре?', 'Open the ports in the firewall?'), T('Windows покажет запрос прав администратора. Hearth добавит правила «Hearth: …» для портов этого сервера.', 'Windows will ask for administrator rights. Hearth adds “Hearth: …” rules for this server’s ports.'), `/api/servers/${s.id}/firewall`, { action: 'open' }, T('Порты открыты в брандмауэре', 'Ports opened in the firewall')) } }, icon('shield', 14), T('Открыть порты', 'Open ports')),
            h('button', { class: 'btn sm ghost', 'data-act': 'fw-close', on: { click: runElevated(T('Закрыть порты?', 'Close the ports?'), T('Правила «Hearth: …» этого сервера будут удалены.', 'This server’s “Hearth: …” rules will be removed.'), `/api/servers/${s.id}/firewall`, { action: 'close' }, T('Правила удалены', 'Rules removed')) } }, T('Закрыть порты', 'Close ports')))),
        nameEditor(s),
        s.netName && primary ? h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm', 'data-act': 'name-hosts', title: `${primary.ip} ${s.netName}`, on: { click: runElevated(T('Включить имя на этом ПК?', 'Enable the name on this PC?'), T(`В hosts будет добавлена строка «${primary.ip} ${s.netName}». Windows спросит права администратора.`, `The line “${primary.ip} ${s.netName}” is added to hosts. Windows asks for administrator rights.`), '/api/network/hosts', { ip: primary.ip, action: 'add', name: s.netName }, T('Имя добавлено в hosts', 'Name added to hosts')) } }, icon('link', 14), T('Включить имя на этом ПК', 'Enable the name on this PC')),
          h('button', { class: 'btn sm ghost', 'data-act': 'name-line', on: { click: (e) => copy(`${primary.ip} ${s.netName} # Hearth`, e.currentTarget) } }, icon('copy', 14), T('Строка для hosts друга', 'hosts line for a friend'))) : null,
        rows
          ? h('ul', { class: 'ports' }, rows.map((p) => {
            const [label, tone] = STATUS()[p.status] || [p.status, 'dim'];
            const tip = advice(s, p.status);
            return h('li', { class: 'port', 'data-status': p.status },
              h('span', { class: 'mono' }, `${p.port}/${p.proto}`), h('small', {}, lab(p.label)),
              h('span', { class: 'st tone-' + tone }, label),
              primary && p.proto !== 'http' ? h('span', { class: 'conn' }, copyBtn(`${hostOf(s)}:${p.port}`, T('По имени', 'By name')), copyBtn(`${primary.ip}:${p.port}`, 'IP:порт')) : null,
              tip ? h('small', { class: 'tip' }, tip) : null);
          }))
          : h('p', { class: 'muted' }, r && r.error ? r.error : live ? T('Проверяю…', 'Checking…') : T('Запустите сервер и нажмите «Проверить».', 'Start the server and press “Check”.')));
    }) : h('p', { class: 'muted' }, T('Серверов пока нет.', 'No servers yet.')));
  }

  function draw() {
    const primary = net.addresses.find((a) => a.primary);
    fill(page,
      h('h1', {}, T('Сеть и имена', 'Network and names')),
      Object.values(net.hosts || {}).includes('stale') ? h('div', { class: 'net-banner', role: 'alert' }, icon('refresh', 16), T(`IP этого ПК изменился (теперь ${(primary || {}).ip || '—'}). Имена в hosts ведут на старый адрес: нажмите «Включить имя на этом ПК», а друзьям отправьте новую строку для hosts.`, `This PC’s IP changed (now ${(primary || {}).ip || '—'}). Names in hosts point to the old address: press “Enable the name on this PC” and send friends the new hosts line.`)) : null,
      h('p', { class: 'lead' }, T('Hearth показывает адреса вашего ПК, превращает IP в короткое имя вида sajiba-feleesee.hearth и проверяет, что сервер действительно доступен в сети.', 'Hearth lists your PC’s addresses, turns an IP into a short name like sajiba-feleesee.hearth and checks that a server is really reachable on the network.')),
      h('h2', {}, T('Адреса этого ПК', 'This PC’s addresses')),
      h('div', { class: 'addr-cards' }, addrCards()),
      primary ? h('div', { class: 'row-actions' },
        h('button', { class: 'btn', 'data-act': 'hosts-add', title: primary.fqdn, on: { click: runElevated(T('Добавить имя на этом ПК?', 'Add the name on this PC?'), T(`В файл hosts будет добавлена строка «${primary.ip} ${primary.fqdn}». Windows спросит права администратора. После этого ${primary.fqdn} открывается на этом ПК.`, `The line “${primary.ip} ${primary.fqdn}” is added to the hosts file. Windows asks for administrator rights. After that ${primary.fqdn} works on this PC.`), '/api/network/hosts', { ip: primary.ip, action: 'add' }, T('Имя добавлено в hosts', 'Name added to hosts')) } }, icon('link', 16), T('Включить имя на этом ПК', 'Enable the name on this PC')),
        h('button', { class: 'btn ghost', 'data-act': 'hosts-line', on: { click: (e) => copy(`${primary.ip} ${primary.fqdn} # Hearth`, e.currentTarget) } }, icon('copy', 16), T('Строка для hosts друга', 'hosts line for a friend'))) : null,
      h('h2', {}, T('Имя → IP', 'Name → IP')),
      h('p', { class: 'muted' }, T('Друг прислал имя? Вставьте, и Hearth покажет адрес.', 'Did a friend send a name? Paste it and Hearth shows the address.')),
      h('div', { class: 'name-tool' }, h('div', { class: 'searchbar grow' }, icon('link', 16), nameIn), decoded),
      h('h2', {}, T('Доступ к серверам', 'Server access')),
      h('label', { class: 'beta-switch' }, h('input', { type: 'checkbox', 'data-role': 'beta-zone', checked: !!(net.beta && net.beta.anyZone), on: { change: async (e) => { net.beta = await api('PUT', '/api/beta', { anyZone: e.currentTarget.checked }); draw(); } } }), h('span', {}, T('Бета для администратора: разрешить свои зоны (soskacraft.mc). Обычным пользователям доступны только имена .', 'Admin beta: allow custom zones (soskacraft.mc). Regular users only get names ending in .') + net.suffix)),
      srvHost,
      h('details', { class: 'help' }, h('summary', {}, T('Как это работает и где имя откроется', 'How it works and where the name opens')),
        h('p', { class: 'muted' }, T('Имя считается из IP-адреса и однозначно расшифровывается обратно, поэтому ему не нужен ни сервер имён, ни регистрация. Но .hearth не настоящий домен интернета: имя открывается там, где его знают. На этом ПК нажмите «Включить имя»; у друга добавьте строку hosts (кнопка выше) или просто введите IP. Из интернета, через роутер без проброса портов, подключаются по публичному адресу туннеля.', 'The name is computed from the IP address and decodes back unambiguously, so it needs neither a name server nor registration. But .hearth is not a real internet domain: the name opens where it is known. On this PC press “Enable the name”; for a friend add the hosts line (button above) or just type the IP. From the internet, with a router and no port forwarding, friends use the tunnel’s public address.')),
        h('p', { class: 'muted' }, T('Адрес в домашней сети (192.168.…) работает только внутри этой сети. Если у провайдера CGNAT или нет белого IP, используйте туннель.', 'An address on the home network (192.168.…) works inside that network only. With carrier-grade NAT or no public IP, use the tunnel.')),
        h('div', { class: 'row-actions' }, h('button', { class: 'btn', on: { click: () => go('tunnels') } }, icon('tunnel', 16), T('Открыть «Туннели»', 'Open “Tunnels”')))));
    drawServers();
  }

  fill(page, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', T('Загрузка…', 'Loading…')));
  try {
    net = await api('GET', '/api/network');
    S.net = net;
  } catch (e) {
    return fill(page, h('p', { class: 'muted' }, e.message));
  }
  if (!alive()) return;
  draw();
  for (const s of S.servers) if (['running', 'starting'].includes(s.state)) check(s.id);
}
