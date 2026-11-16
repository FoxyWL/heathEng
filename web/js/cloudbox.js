'use strict';
// @imports:start
import { T, api, click, h, toast } from './lib.js';
import { S, fill } from './state.js';
// @imports:end
// Облачные бэкапы: любое S3-совместимое хранилище (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO). Ключ после сохранения не показывается.

export function cloudBox() {
  const box = h('div', { class: 'sect', 'data-sect': 'cloud' });
  let v = S.cloud || null;
  const load = (x) => {
    v = x;
    S.cloud = x;
    draw();
  };
  function draw() {
    if (!v) return fill(box, h('h3', {}, T('Облачные бэкапы', 'Cloud backups')), h('p', { class: 'muted' }, T('Загрузка…', 'Loading…')));
    const f = (role, val, ph, type = 'text') => h('input', { type, 'data-role': role, value: val || '', placeholder: ph, spellcheck: false, autocomplete: 'off' });
    const endpoint = f('cloud-endpoint', v.endpoint, 'https://s3.eu-central-1.amazonaws.com');
    const region = f('cloud-region', v.region, 'us-east-1');
    const bucket = f('cloud-bucket', v.bucket, 'my-hearth-backups');
    const ak = f('cloud-ak', v.accessKey, 'Access key');
    const sk = f('cloud-sk', '', v.hasSecret ? T('сохранён — пусто, чтобы не менять', 'saved — blank keeps it') : 'Secret key', 'password');
    const keep = f('cloud-keep', v.keep, '14', 'number');
    const on = h('input', { type: 'checkbox', checked: v.enabled, 'data-role': 'cloud-on' });
    const body = () => ({ endpoint: endpoint.value, region: region.value, bucket: bucket.value, accessKey: ak.value, secretKey: sk.value, keep: +keep.value || 14, enabled: on.checked });
    fill(box,
      h('h3', {}, T('Облачные бэкапы', 'Cloud backups'), v.enabled ? h('span', { class: 'tag ok' }, T('включены', 'on')) : null),
      h('p', { class: 'muted' }, T('Каждый бэкап копируется в ваше S3-хранилище (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO). Если ПК сломается, мир можно вернуть из облака на новом.', 'Every backup is copied to your S3 storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO). If the PC dies, you can bring the world back from the cloud on a new one.')),
      h('div', { class: 'form' },
        h('div', { class: 'field wide' }, h('label', {}, T('Адрес хранилища', 'Storage endpoint'), endpoint)),
        h('div', { class: 'field' }, h('label', {}, T('Регион', 'Region'), region)),
        h('div', { class: 'field' }, h('label', {}, T('Бакет', 'Bucket'), bucket)),
        h('div', { class: 'field' }, h('label', {}, 'Access key', ak)),
        h('div', { class: 'field' }, h('label', {}, 'Secret key', sk)),
        h('div', { class: 'field' }, h('label', {}, T('Хранить в облаке копий на сервер', 'Copies to keep per server'), keep))),
      h('label', { class: 'check' }, on, h('span', {}, T('Отправлять каждый бэкап в облако', 'Upload every backup'))),
      h('div', { class: 'savebar' },
        h('button', { class: 'btn primary', 'data-act': 'cloud-save', on: { click: click(async () => { try { load(await api('PUT', '/api/cloud', body())); toast(T('Сохранено', 'Saved')); } catch (e) { toast(e.message, true); } }) } }, T('Сохранить', 'Save')),
        h('button', { class: 'btn', 'data-act': 'cloud-test', on: { click: click(async () => { try { load(await api('PUT', '/api/cloud', { ...body(), enabled: v.enabled })); await api('POST', '/api/cloud/test'); toast(T('Хранилище отвечает, ключи верные', 'The storage answers, the keys are valid')); } catch (e) { toast(e.message, true); } }) } }, T('Проверить подключение', 'Test connection'))),
      v.last && v.last.ts ? h('p', { class: v.last.ok ? 'mono muted' : 'tone-bad', 'data-role': 'cloud-last' }, `${new Date(v.last.ts).toLocaleTimeString()} ${v.last.name}: ${v.last.ok ? T('загружено', 'uploaded') : v.last.error}`) : null);
  }
  draw();
  api('GET', '/api/cloud').then(load).catch(() => {});
  return box;
}
