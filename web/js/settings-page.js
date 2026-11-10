'use strict';
// @imports:start
import { T, api, applyTheme, click, fmtMem, guard, h, lang, setLang, toast } from './lib.js';
import { quitApp, render } from './shell.js';
import { S, ui } from './state.js';
// @imports:end

export function settingsPage() {
  const l = h('select', { 'aria-label': T('Язык', 'Language') }, [['ru', 'Русский'], ['en', 'English']].map(([v, n]) => h('option', { value: v, selected: v === lang }, n)));
  l.value = lang;
  l.addEventListener('change', guard(async () => {
    setLang(l.value);
    localStorage.setItem('hearth.lang', lang);
    document.documentElement.lang = lang;
    await api('PUT', '/api/settings', { lang });
    S.anim = true;
    render();
  }));
  const themeSel = h('select', { 'aria-label': T('Тема', 'Theme') }, [['auto', T('Как в системе', 'System')], ['light', T('Светлая', 'Light')], ['dark', T('Тёмная', 'Dark')]].map(([v, n]) => h('option', { value: v }, n)));
  themeSel.value = localStorage.getItem('hearth.theme') || 'auto';
  themeSel.addEventListener('change', () => {
    localStorage.setItem('hearth.theme', themeSel.value);
    applyTheme();
  });
  const ai = S.sys.ai;
  const aiOn = h('input', { type: 'checkbox', checked: ai.enabled });
  const key = h('input', { type: 'password', placeholder: ai.hasKey ? T('сохранён — оставьте пустым, чтобы не менять', 'saved — leave blank to keep') : 'sk-ant-…', autocomplete: 'off' });
  const saveAi = h('button', { class: 'btn primary' }, T('Сохранить', 'Save'));
  saveAi.addEventListener('click', click(async () => {
    await api('PUT', '/api/settings', { ai: { enabled: aiOn.checked, apiKey: key.value } });
    S.sys = await api('GET', '/api/system');
    toast(T('Сохранено', 'Saved'));
    settingsPage();
  }));
  ui.main.replaceChildren(
    h('div', { class: 'page' },
      h('h1', {}, T('Настройки', 'Settings')),
      h('div', { class: 'form', style: 'margin-top:18px' },
        h('div', { class: 'field' }, h('label', {}, T('Язык', 'Language'), l)),
        h('div', { class: 'field' }, h('label', {}, T('Тема оформления', 'Theme'), themeSel))),
      h('div', { class: 'sect' },
        h('h3', {}, T('ИИ-помощник для логов', 'AI log assistant')),
        h('p', { class: 'muted' }, T('По умолчанию выключен и ничего не отправляет. Когда включён, фрагмент журнала уходит в Claude API по вашему ключу только после нажатия «Объяснить ошибки» в консоли. Ответы могут быть неточными — проверяйте перед применением на рабочем сервере.', 'Off by default and sends nothing. When enabled, a log fragment goes to the Claude API with your own key only after you press “Explain errors” in the console. Answers may be inaccurate — verify before applying them on a live server.')),
        h('label', { class: 'check' }, aiOn, h('span', {}, T('Включить ИИ-помощника', 'Enable the AI assistant'))),
        h('div', { class: 'form', style: 'margin-top:8px' }, h('div', { class: 'field wide' }, h('label', {}, T('API-ключ Anthropic', 'Anthropic API key'), key))),
        h('div', { class: 'savebar' }, saveAi)),
      h('div', { class: 'sect' },
        h('h3', {}, T('О системе', 'About')),
        h('p', { class: 'mono muted' }, `Hearth ${S.sys.version} · Node ${S.sys.node} · ${S.sys.platform}`),
        h('p', { class: 'mono muted' }, T('Ядро: ', 'Core: ') + (S.sys.core && S.sys.core.ok ? 'Rust hearth-core' : T('Node (запасной режим)', 'Node (fallback)')) + ` · ${S.sys.cores || '?'} ${T('ядер', 'cores')} · ${S.sys.totalMem ? fmtMem(S.sys.totalMem) : '?'}`),
          h('p', { class: 'mono muted' }, 'Java: ' + (S.sys.java.found ? S.sys.java.major : T('не найдена — будет скачана при установке сервера', 'not found — it will be downloaded when installing a server'))),
        h('p', { class: 'mono muted' }, T('Данные: ', 'Data: ') + S.sys.dataDir)),
      h('div', { class: 'sect' },
        h('h3', {}, T('Выход', 'Quit')),
        h('p', { class: 'muted' }, T('Корректно остановит серверы и закроет Hearth.', 'Stops the servers gracefully and closes Hearth.')),
        h('button', { class: 'btn danger', on: { click: quitApp } }, T('Выйти из Hearth', 'Quit Hearth')))),
  );
}
