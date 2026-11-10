'use strict';
const net = require('net');
const port = +process.argv[2] || 15555;
const srv = net.createServer((s) => s.on('data', (d) => s.write('world:' + d)));
srv.listen(port, '127.0.0.1', () => console.log('Done (0.5s)! listening on ' + port));
console.error('ERROR sample warning on stderr');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const line of d.split('\n').filter(Boolean)) {
    if (line === 'stop') {
      console.log('stopping');
      process.exit(0);
    } else if (line === 'crash') {
      console.error('java.lang.OutOfMemoryError: Java heap space');
      process.exit(1);
    } else console.log('echo ' + line);
  }
});
