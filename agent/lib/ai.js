'use strict';
const store = require('./store');

const SYSTEM = {
  ru: 'Ты помощник администратора игровых серверов. Тебе дают фрагмент консоли или лога. Коротко объясни простыми словами, что произошло, назови наиболее вероятную причину и предложи конкретные шаги исправления (какой параметр или файл изменить). Если данных недостаточно, скажи, чего не хватает. Не выдумывай названия настроек, в которых не уверен. Отвечай на русском, без вступлений.',
  en: 'You are an assistant for game server admins. You get a fragment of a console or log. Briefly explain in plain words what happened, name the most likely cause and give concrete fix steps (which setting or file to change). If the data is not enough, say what is missing. Do not invent setting names you are not sure about. Answer in English, no preamble.',
};

async function explain({ text, question, lang }) {
  const ai = store.config.ai;
  if (!ai.enabled) throw Object.assign(new Error('ИИ-помощник выключен в настройках'), { status: 403 });
  if (!ai.apiKey) throw Object.assign(new Error('не задан API-ключ Anthropic'), { status: 400 });
  const clipped = String(text || '').slice(-12000);
  const user = (question ? `Вопрос: ${question}\n\n` : '') + 'Фрагмент лога:\n```\n' + clipped + '\n```';
  const r = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ai.model || 'claude-sonnet-5-5',
      max_tokens: 900,
      system: SYSTEM[lang] || SYSTEM.ru,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || 'ошибка API ' + r.status), { status: 502 });
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

module.exports = { explain };
