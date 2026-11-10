/* Telegram launch data stays in memory and is sent only to the same-origin API. */
const tg = window.Telegram?.WebApp;
const launchData = tg?.initData || '';
const $ = (id) => document.getElementById(id);
let state = null;
let currentTab = 'profile';
let busy = false;
let noticeTimer;
const number = (value) => value == null ? '—' : new Intl.NumberFormat('ru-RU').format(value);
function text(id, value) { $(id).textContent = value; }
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  text('notice', message);
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 6500);
}
function navigate(tab) {
  currentTab = tab;
  for (const name of ['profile', 'sync', 'settings']) $('view-' + name).hidden = name !== tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  tg?.HapticFeedback?.selectionChanged();
}
function groups() {
  const container = $('groups');
  container.replaceChildren();
  const outcomes = {
    ok: 'Тег соответствует игровому нику', administrator: 'Администратор: Telegram не меняет тег через бота',
    missing_rights: 'Боту нужно право управлять тегами', telegram_error: 'Не удалось обновить тег. Администратор может запустить /sync',
    rate_limited: 'Telegram попросил подождать. Проверим позже',
  };
  if (!state.groups?.length) {
    const empty = document.createElement('p');
    empty.className = 'card empty-groups';
    empty.textContent = 'Пока нет проверенных групп. Администратору нужно подключить клан через /setup и выдать боту право управлять тегами. После привязки первая проверка запускается автоматически.';
    container.append(empty);
    return;
  }
  for (const group of state.groups) {
    const row = document.createElement('article');
    row.className = 'card group-row';
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = group.clan_name;
    const description = document.createElement('p');
    description.textContent = outcomes[group.outcome] || 'Проверка сохранена. Следующее обновление — автоматически.';
    const time = document.createElement('p');
    time.textContent = new Date(group.checked_at * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    content.append(title, description, time);
    row.append(content);
    container.append(row);
  }
}
function render(data) {
  state = data;
  $('loading').hidden = true;
  $('gate').hidden = true;
  $('content').hidden = false;
  $('onboarding').hidden = data.linked;
  $('linked-content').hidden = !data.linked;
  $('navigation').hidden = !data.linked;
  if (!data.linked) { $('player-tag').value = ''; return; }
  const player = data.player;
  text('player-name', player?.name || 'Игровой аккаунт');
  text('player-id', player?.tag || '—');
  text('clan-name', player?.clan?.name || 'Без клана');
  text('townhall', number(player?.townHallLevel));
  text('trophies', number(player?.trophies));
  text('level', number(player?.expLevel));
  const initials = Array.from(player?.name || 'C').slice(0, 1).join('').toUpperCase();
  text('avatar', initials); text('mini-avatar', initials);
  text('telegram-name', data.user.firstName);
  text('group-tag', data.tagPreview || player?.name || '—');
  text('summary-status', data.syncEnabled ? 'Синхронизация включена' : 'Синхронизация на паузе');
  text('summary-detail', data.syncEnabled ? 'Проверяем ник раз в час' : 'Включить можно в настройках');
  text('sync-title', data.syncEnabled ? 'Всё под контролем' : 'Пауза по твоему выбору');
  text('sync-description', data.syncEnabled ? 'Проверяем раз в час. Меняем только отличающийся тег.' : 'Бот не будет менять тег, пока синхронизация выключена.');
  $('sync-pill').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'dot';
  $('sync-pill').append(dot, document.createTextNode(data.syncEnabled ? 'Автосинхронизация включена' : 'Автосинхронизация выключена'));
  $('sync-toggle').checked = data.syncEnabled;
  text('settings-name', player?.name || 'Игровой аккаунт');
  text('settings-tag', player?.tag || '—');
  groups(); navigate(currentTab);
  if (data.notice) notice(data.notice + (data.updatedAt ? ' Обновлено: ' + new Date(data.updatedAt*1000).toLocaleString('ru-RU') : ''));
}
async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Telegram-Init-Data': launchData, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(55000),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { showGate(result.error, false); }
    throw new Error(result.error || 'Не получилось выполнить действие. Попробуй ещё раз.');
  }
  return result;
}
function showGate(message, retry = false) {
  $('loading').hidden = true; $('content').hidden = true; $('navigation').hidden = true;
  $('gate').hidden = false; text('gate-message', message); $('retry').hidden = !retry;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button,input')];
  controls.forEach((control) => { control.disabled = true; });
  try { await fn(); }
  catch (error) { notice(error instanceof Error ? error.message : 'Сеть недоступна. Попробуй ещё раз.', true); }
  finally { busy = false; controls.forEach((control) => { control.disabled = false; }); if (state) $('sync-toggle').checked = state.syncEnabled; }
}
function syncFeedback(result) {
  if (!result) return;
  if (result.busy || result.partial || result.failed) notice('Аккаунт привязан. Обновление тегов продолжится автоматически. Подробности — в разделе синхронизации.');
  else if (result.updated) notice('Аккаунт привязан, ник в группе обновлён.');
  else notice('Аккаунт привязан. Статус тега — в разделе синхронизации.');
}
$('link-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => { const data = await api('link', { tag: $('player-tag').value.trim() }); currentTab = 'profile'; render(data); syncFeedback(data.result); tg?.HapticFeedback?.notificationOccurred('success'); });
});
$('refresh-profile').addEventListener('click', () => { void action(async () => { render(await api('me')); notice('Данные профиля обновлены. Тег в группе проверяется раз в час.'); }); });
$('sync-toggle').addEventListener('change', () => {
  const enabled = $('sync-toggle').checked;
  void action(async () => { render(await api('settings', { syncEnabled: enabled })); notice(enabled ? 'Синхронизация включена. Бот обновит тег при следующей проверке.' : 'Синхронизация выключена. Текущий тег останется.'); });
});
$('unlink').addEventListener('click', () => $('unlink-dialog').showModal());
$('cancel-unlink').addEventListener('click', () => $('unlink-dialog').close());
$('confirm-unlink').addEventListener('click', () => {
  void action(async () => { const data = await api('unlink', { confirm: true }); $('unlink-dialog').close(); currentTab = 'profile'; render(data); notice(data.cleanupIncomplete ? 'Привязка удалена, но очистка тега не завершена. Обратись к администратору.' : 'Аккаунт отвязан. Можно привязать другой.'); });
});
for (const button of document.querySelectorAll('[data-tab],[data-navigate]')) button.addEventListener('click', () => navigate(button.dataset.tab || button.dataset.navigate));
async function load() {
  if (!launchData) { showGate('Открой приложение через бота, чтобы войти в свой аккаунт Telegram.'); return; }
  try { render(await api('me')); }
  catch (error) { showGate(error instanceof Error ? error.message : 'Не удалось подключиться. Проверь сеть.', true); }
}
$('retry').addEventListener('click', () => { void action(load); });
tg?.ready(); tg?.expand(); tg?.setHeaderColor?.('#10141b'); tg?.setBackgroundColor?.('#10141b'); tg?.setBottomBarColor?.('#141922');
void load();
