const { BOT_TOKEN, WEBHOOK_SECRET, WEBHOOK_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WEBHOOK_URL) {
  console.error('Set BOT_TOKEN, WEBHOOK_SECRET and WEBHOOK_URL in .dev.vars.');
  process.exit(1);
}
const url = new URL(WEBHOOK_URL);
if (url.protocol !== 'https:' || url.pathname !== '/webhook') {
  console.error('WEBHOOK_URL must be an HTTPS URL ending in /webhook.');
  process.exit(1);
}
async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram rejected ${method} (${result.error_code ?? response.status}).`);
  return result.result;
}
try {
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Главное меню' }, { command: 'link', description: 'Привязать аккаунт' },
    { command: 'profile', description: 'Мой профиль' }, { command: 'cancel', description: 'Отменить привязку' },
    { command: 'setup', description: 'Подключить клан: /setup #тег' }, { command: 'status', description: 'Состояние группы' },
    { command: 'sync', description: 'Проверить теги группы' },
  ] });
  await api('setWebhook', {
    url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET, max_connections: 1,
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false,
  });
  const info = await api('getWebhookInfo', {});
  if (info.url !== WEBHOOK_URL) throw new Error('Webhook URL did not match.');
  console.log(`Webhook set. Pending updates: ${info.pending_update_count}.`);
} catch {
  console.error('Could not configure webhook. Check network access, bot token and Worker URL.');
  process.exit(1);
}
