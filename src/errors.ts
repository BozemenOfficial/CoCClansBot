export class ServiceError extends Error {
  constructor(readonly code: string, readonly retryAfter = 0) { super(code); }
}

export function userError(error: unknown): string {
  if (error instanceof ServiceError) {
    switch (error.code) {
      case 'not_found': return 'Игрок или клан не найден. Проверь тег.';
      case 'rate_limited': return 'Слишком много запросов. Попробуй через минуту.';
      case 'access_denied': return 'Нет доступа к Clash API. Администратору нужно проверить ключ и разрешённый IP.';
      case 'budget_exhausted': return 'Обработка займёт ещё немного времени. Попробуй позже.';
    }
  }
  return 'Сейчас не получилось получить данные. Попробуй чуть позже.';
}
