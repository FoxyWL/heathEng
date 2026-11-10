'use strict';
const fs = require('fs');
const { execFile } = require('child_process');

function rssMb(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(0);
    if (process.platform === 'linux') {
      fs.readFile(`/proc/${pid}/status`, 'utf8', (err, txt) => {
        if (err) return resolve(0);
        const m = /VmRSS:\s+(\d+)\s*kB/.exec(txt);
        resolve(m ? Math.round(+m[1] / 1024) : 0);
      });
    } else if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (err) return resolve(0);
        const cols = String(out).trim().split('","');
        const digits = (cols[4] || '').replace(/\D/g, '');
        resolve(digits ? Math.round(+digits / 1024) : 0);
      });
    } else {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000 }, (err, out) => {
        const n = parseInt(String(out).trim(), 10);
        resolve(err || !n ? 0 : Math.round(n / 1024));
      });
    }
  });
}

module.exports = { rssMb };
