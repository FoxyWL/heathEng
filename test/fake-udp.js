'use strict';
// Имитация игрового сервера: слушает UDP на port и port+1, отвечает "echo:<данные>", пишет строку готовности.
const dgram = require('dgram');
const argv = process.argv.slice(2);
const pi = argv.findIndex((a) => a === '-port' || a === '+port');
const eq = argv.find((a) => /^-port=/.test(a));
const port = pi >= 0 ? +argv[pi + 1] : eq ? +eq.split('=')[1] : 27015;
console.log('ARGS ' + argv.join(' '));
let bound = 0;
for (const p of [port, port + 1]) {
  const s = dgram.createSocket('udp4');
  s.on('message', (m, r) => s.send('echo:' + m, r.port, r.address));
  s.on('error', (e) => console.error('udp error ' + e.message));
  s.bind(p, '127.0.0.1', () => {
    if (++bound === 2) console.log('Game server connected');
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d.split('\n').includes('stop')) process.exit(0);
});
setInterval(() => {}, 1000);
