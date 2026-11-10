import { InlineKeyboard } from 'grammy/web';
import type { Player } from '../clients/clash';

export const menu = () => new InlineKeyboard()
  .text('👤 Мой профиль', 'profile').text('🔗 Привязать аккаунт', 'link').row()
  .text('🔄 Обновить данные', 'refresh').text('⚙️ Настройки', 'settings');

export function profileText(p: Player): string {
  const roles: Record<string, string> = { leader: 'Глава', coLeader: 'Соруководитель', admin: 'Старейшина', member: 'Участник' };
  return [p.name, p.tag, '', `Клан: ${p.clan?.name ?? 'не состоит в клане'}`,
    `Ратуша: ${p.townHallLevel}`, `Уровень: ${p.expLevel}`, `Кубки: ${p.trophies}`,
    `Отдано войск: ${p.donations}`, `Получено войск: ${p.donationsReceived}`,
    `Роль: ${p.role ? roles[p.role] ?? p.role : '—'}`].join('\n');
}
