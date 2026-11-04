import { createHash } from 'node:crypto';

const TYPES = new Set(['write_verified', 'processing_error', 'telegram_error', 'telegram_recovered', 'worker_error',
  'startup_failed', 'runtime_failed', 'api_blocked', 'review_required', 'runtime_initialized',
  'contact_write_verified','contact_review_required','contact_source_error']);
const COLUMNS = Object.freeze({ E: 'организация', G: 'ИНН', H: 'номер лицензии', I: 'дата выдачи',
  J: 'дата окончания', K: 'вид деятельности', L: 'адрес объекта', M: 'имя контакта', N: 'телефон', O: 'Telegram', P: 'email' });
const REASONS = Object.freeze({
  contacts_source_failed: 'Не удалось прочитать заявки бота замеров. Обработчик повторит попытку.',
  contacts_source_report_review: 'В исходной заявке неоднозначные контактные данные.',
  contact_source_ambiguous: 'Для этого объекта найдены разные контакты.',
  contact_source_invalid: 'Контакт из заявки не прошёл проверку.',
  contact_existing_conflict: 'Контакт из заявки расходится с заполненными полями реестра.',
  contact_existing_value_unverified: 'Не удалось сопоставить контакт с уже заполненными полями.',
  contact_role_not_client: 'В заявке указан служебный контакт, а не контакт клиента.',
  contact_row_ambiguous: 'В реестре несколько действующих строк этого объекта.',
  contact_row_moved: 'Строка реестра переместилась во время проверки.',
  contact_cell_conflict: 'Контакт в реестре изменился во время записи.',
  contact_cell_protected: 'В ячейке контакта есть формула или примечание.',
  contact_source_changed: 'Контакт в заявке изменился после подготовки записи.',
  access_ip_blocked: 'API-ФНС отклонил исходящий IP сервера.',
  fsrar_access_ip_blocked: 'API-ФНС отклонил исходящий IP сервера.',
  authentication_failed: 'Сервис отклонил ключ доступа.',
  fsrar_authentication_failed: 'API-ФНС отклонил ключ доступа.',
  quota_exhausted: 'Исчерпан лимит запросов API-ФНС.',
  fsrar_quota_exhausted: 'Исчерпан лимит запросов API-ФНС.',
  insufficient_api_quota: 'Достигнут резерв лимита запросов API-ФНС.',
  fsrar_method_unavailable: 'В доступе API-ФНС отсутствует метод лицензий.',
  fsrar_stat_network_error: 'Не удалось связаться с API-ФНС.',
  fsrar_stat_http_error: 'API-ФНС вернул ошибку при проверке доступа.',
  fsrar_stat_invalid_response: 'API-ФНС вернул неподтверждённые сведения о доступе.',
  fsrar_stat_invalid_quota: 'Не удалось подтвердить лимит API-ФНС.',
  fsrar_stat_unsupported_limit: 'У API-ФНС изменился формат лимита.',
  fsrar_key_invalid: 'Нужна проверка ключа API-ФНС.',
  fsrar_key_permissions: 'Нужна проверка защиты файла ключа API-ФНС.',
  fsrar_transport_error: 'Не удалось связаться с API-ФНС.',
  network_error: 'Не удалось связаться с внешним сервисом.',
  invalid_api_response: 'Получен неподтверждённый ответ API-ФНС.',
  incomplete_api_pagination: 'API-ФНС вернул неполный набор лицензий.',
  google_access_denied: 'Google не разрешил доступ к реестру.',
  google_authentication_failed: 'Нужна проверка серверного входа в Google.',
  google_credentials_missing_or_invalid: 'Не настроен серверный доступ к Google.',
  google_network_error: 'Не удалось связаться с Google.',
  google_request_failed: 'Google отклонил запрос к реестру.',
  google_token_unavailable: 'Не удалось подтвердить серверный вход в Google.',
  google_write_failed: 'Запись в Google-реестре пока не подтверждена.',
  sheet_plan_stale: 'Строка реестра изменилась во время обработки.',
  sheet_readback_mismatch: 'Обратное чтение Google не подтвердило запись.',
  sheet_structure_changed: 'Изменилась структура Google-реестра.',
  sheet_append_template_missing: 'Не найден образец формата новой строки реестра.',
  invalid_sheet_activity: 'Вид деятельности не соответствует настройкам реестра.',
  invalid_sheet_date: 'Не удалось проверить дату для реестра.',
  invalid_sheet_identity: 'Не удалось подтвердить организацию и лицензию в строке.',
  invalid_sheet_plan: 'Не удалось подтвердить состав изменений реестра.',
  invalid_spreadsheet_id: 'Не удалось подтвердить адрес Google-реестра.',
  organization_not_identified: 'Не удалось определить организацию по сообщению.',
  organization_name_is_ambiguous: 'Названию соответствуют несколько организаций.',
  organization_name_required: 'Не подтверждено название организации.',
  invalid_explicit_inn: 'В сообщении указан некорректный ИНН.',
  multiple_organizations_in_one_message: 'Сообщение содержит несколько организаций.',
  positive_result_is_a_question: 'Положительный результат сформулирован как вопрос.',
  multiple_licenses_or_objects: 'Найдены несколько подходящих лицензий или объектов.',
  duplicate_or_ambiguous_sheet_records: 'В реестре есть неоднозначные строки организации.',
  incomplete_existing_sheet_record: 'Существующая строка реестра заполнена недостаточно для точного сопоставления.',
  license_number_belongs_to_other_inn: 'Номер лицензии в реестре связан с другим ИНН.',
  object_address_conflict: 'Адрес объекта расходится с существующей строкой.',
  conflicting_api_records: 'В ответе API-ФНС есть противоречивые записи.',
  invalid_license_fields: 'Не удалось подтвердить реквизиты лицензии.',
  invalid_api_record: 'В ответе API-ФНС есть некорректная запись.',
  invalid_or_incomplete_api_response: 'Получен неполный ответ API-ФНС.',
  event_inn_required: 'Не подтверждён ИНН события.',
  event_inn_mismatch: 'ИНН события и лицензии не совпадают.',
  event_date_required: 'Не подтверждена дата события.',
  missing_message_identity: 'Не подтверждён номер исходного сообщения.',
  missing_or_invalid_message_date: 'Не подтверждена дата исходного сообщения.',
  row_number_required: 'Не подтверждена строка реестра.',
  unsupported_activity_for_sheet: 'Вид деятельности не соответствует реестру.',
  api_operation_does_not_match_renewal: 'Ответ API-ФНС не подтверждает продление.',
  api_issueDate_older_than_existing: 'Дата выдачи в API-ФНС старее существующей записи.',
  api_expiryDate_older_than_existing: 'Дата окончания в API-ФНС старее существующей записи.',
  maximum_attempts_reached: 'Повторные проверки не подтвердили актуальную лицензию.',
  access_denied: 'Telegram не разрешил доступ к группе.',
  polling_conflict: 'Для этого Telegram-бота уже работает другой получатель сообщений.',
  rate_limited: 'Telegram временно ограничил частоту запросов.',
  existing_webhook: 'У Telegram-бота уже настроен webhook.',
  bot_not_a_member: 'Telegram-бот отсутствует в целевой группе.',
  group_messages_not_available: 'Telegram-бот не получает обычные сообщения группы.',
  target_chat_mismatch: 'Не подтверждён ID целевой Telegram-группы.',
  target_title_mismatch: 'Название целевой Telegram-группы не совпадает.',
  target_chat_id_required: 'Не настроен ID целевой Telegram-группы.',
  bot_token_required: 'Не настроен доступ Telegram-бота.',
  invalid_bot_identity: 'Не подтверждена личность Telegram-бота.',
  membership_identity_mismatch: 'Не подтверждено членство Telegram-бота в группе.',
  invalid_webhook_response: 'Не удалось проверить webhook Telegram-бота.',
  invalid_telegram_updates: 'Не удалось проверить полученные события Telegram.',
  invalid_updates: 'Не удалось проверить полученные события Telegram.',
  invalid_update_date: 'Telegram вернул неподтверждённую дату события.',
  invalid_message_identity: 'Telegram вернул неподтверждённый номер сообщения.',
  response_too_large: 'Внешний сервис превысил допустимый размер ответа.',
  invalid_response: 'Внешний сервис вернул неподтверждённый ответ.',
  timeout: 'Внешний сервис не ответил вовремя.',
  missing_bot_token: 'Не настроен доступ Telegram-бота.',
  missing_target_chat_id: 'Не настроен ID целевой Telegram-группы.',
  missing_google_credentials: 'Не настроен серверный доступ к Google.',
  config_file_missing_or_invalid: 'Не удалось прочитать настройки обработчика.',
  initial_state_invalid: 'Не удалось проверить перенесённую очередь.',
  initial_state_required: 'Для запуска нужно перенести существующую очередь лицензий.',
  source_message_edited: 'Исходное сообщение изменено; перед продолжением нужно проверить событие.',
  state_destination_mismatch: 'Очередь относится к другому Google-реестру.',
  processing_failed: 'Обработка события прервана; нужна проверка журнала сервера.',
  worker_tick_failed: 'Обработчик очереди прервался; нужна проверка сервера.',
  telegram_poll_failed: 'Получение сообщений Telegram прервалось.',
  state_locked: 'Сохранение очереди временно недоступно: файл состояния занят. Обработчик повторит попытку.',
  telegram_persist_failed: 'Новые сообщения пока не удалось сохранить в очередь. Обработчик повторит попытку.',
  startup_failed: 'Обработчик пока не прошёл проверку запуска.',
  runtime_failed: 'Работа обработчика прервана.',
  unknown_error: 'Нужна проверка состояния обработчика.',
});
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = (now) => new Date(now()).toISOString();
const safeCode = (value) => typeof value === 'string' && Object.hasOwn(REASONS, value) ? value : 'unknown_error';
const safeJobId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/u.test(value) ? value : null;
function safeIncidentId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return /^(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/u.test(normalized)
    ? normalized : null;
}
function safeOrganization(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > 160 || /https?:|www\.|@|-----BEGIN|[A-Za-z0-9_-]{32,}|\d[\d ()+-]{7,}\d/iu.test(text)) return null;
  return text;
}
function normalizeEvent(event) {
  if (!event || !TYPES.has(event.type)) return null;
  if (event.type === 'write_verified' && !['append', 'update'].includes(event.action)) return null;
  if (event.type === 'contact_write_verified' && event.action !== 'update') return null;
  const incidentId = safeIncidentId(event.incidentId);
  // Recovery is an explicit event from the polling monitor, never inferred
  // from a routine successful send, flush, or startup notification.
  if (event.type === 'telegram_recovered' && !incidentId) return null;
  return {
    type: event.type, jobId: safeJobId(event.jobId),
    ...(incidentId ? { incidentId } : {}),
    ...(['write_verified','contact_write_verified'].includes(event.type) ? {
      action: event.action,
      columns: [...new Set((Array.isArray(event.cells) ? event.cells : [])
        .filter((value) => typeof value === 'string' && /^[A-Q][1-9]\d{0,7}$/u.test(value))
        .map((value) => value[0]).filter((column) => Object.hasOwn(COLUMNS, column)
          && (event.type!=='contact_write_verified'||['M','N','O'].includes(column))))].sort(),
    } : ['runtime_initialized', 'telegram_recovered'].includes(event.type) ? {} : { code: safeCode(event.code) }),
    organization: safeOrganization(event.organization),
  };
}
function metadata(event, at) {
  // Organization text, source messages, provider bodies, contacts and credentials
  // never enter structured console logs.
  const { organization: _organization, ...identifiers } = event;
  return { at, ...identifiers };
}
function messageOf(event) {
  if (event.type === 'telegram_recovered') return 'Получение сообщений Telegram восстановлено. Очередь сохранена.';
  const organization = event.organization ? `Организация: ${event.organization}.` : '';
  const job = event.jobId ? `Событие: ${event.jobId}.` : '';
  if(event.type==='contact_write_verified')return ['Заполнен контакт в реестре лицензий.',organization,
    event.columns.length?`Поля: ${event.columns.map((column)=>COLUMNS[column]).join(', ')}.`:'',
    'Запись подтверждена обратным чтением Google.'].filter(Boolean).join('\n');
  if(event.type==='contact_review_required')return ['Нужна проверка контакта в реестре лицензий.',organization,
    REASONS[event.code]??'Однозначное совпадение контакта не подтверждено.'].filter(Boolean).join('\n');
  if(event.type==='contact_source_error')return ['Автозаполнение контактов временно недоступно.',
    REASONS[event.code]??REASONS.contacts_source_failed].join('\n');
  if (event.type === 'write_verified') {
    const action = event.action === 'append' ? 'Добавлена запись в реестр лицензий.' : 'Обновлена запись в реестре лицензий.';
    const columns = event.columns.length ? `Поля: ${event.columns.map((column) => COLUMNS[column]).join(', ')}.` : '';
    return [action, organization, columns, 'Запись подтверждена обратным чтением Google.', job].filter(Boolean).join('\n');
  }
  const heading = event.type === 'review_required' ? 'Нужна проверка события лицензии.'
    : event.type === 'api_blocked' ? 'Проверки API-ФНС остановлены.' : 'Ошибка автономного обработчика лицензий.';
  return [heading, organization, REASONS[event.code] ?? REASONS.unknown_error, job].filter(Boolean).join('\n');
}
function failure(code) { return Object.assign(new Error(code), { code }); }

/** Durable owner-only delivery. The caller invokes flush periodically for retries. */
export function createNotifier({ telegram, store, ownerChatId, now = () => new Date(),
  log = (entry) => console.log(JSON.stringify(entry)) } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('Notifier requires a durable store');
  const owner = ownerChatId == null || ownerChatId === '' ? null : String(ownerChatId);
  if (owner && (!/^[1-9]\d*$/u.test(owner) || !Number.isSafeInteger(Number(owner)))) throw failure('notification_owner_invalid');
  if (owner && typeof telegram?.call !== 'function') throw new TypeError('Configured notifier requires Telegram client');
  const destinationHash = digest(owner ?? 'log_only');
  let verifiedOwner = false;
  let flushing = null;

  async function verifyOwner() {
    if (!owner) return { configured: false, verified: false, delivery: 'log_only' };
    if (verifiedOwner) return { configured: true, verified: true, id: owner, type: 'private' };
    let chat;
    try { chat = await telegram.call('getChat', { chat_id: owner }); }
    catch { throw failure('notification_owner_unavailable'); }
    if (String(chat?.id) !== owner || chat?.type !== 'private') throw failure('notification_owner_not_private');
    verifiedOwner = true;
    return { configured: true, verified: true, id: owner, type: 'private' };
  }
  async function pendingFailure(key, error) {
    const time = new Date(now());
    const delay = Math.max(60_000, Number.isFinite(error?.retryAfter) ? error.retryAfter * 1000 : 0);
    const code = ['notification_owner_unavailable', 'notification_owner_not_private'].includes(error?.code)
      ? error.code : 'notification_delivery_failed';
    await store.update((state) => {
      const item = state.runtime?.notifications?.[key];
      if (!item || item.status !== 'pending') return;
      item.attempts = (item.attempts ?? 0) + 1;
      item.lastAttemptAt = time.toISOString();
      item.nextAttemptAt = new Date(+time + delay).toISOString();
      item.lastError = code;
    });
    log({ at: time.toISOString(), type: 'notification_error', code });
  }
  async function flushPending() {
    if (!owner) return { delivery: 'log_only', sent: 0, pending: 0 };
    const state = await store.read();
    const pending = Object.entries(state.runtime?.notifications ?? {}).filter(([, item]) => item.status === 'pending'
      && item.destinationHash === destinationHash);
    const due = pending.filter(([, item]) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= +new Date(now()));
    if (!due.length) return { sent: 0, pending: pending.length };
    try { await verifyOwner(); }
    catch (error) {
      for (const [key] of due) await pendingFailure(key, error);
      return { sent: 0, pending: pending.length };
    }
    let sent = 0;
    for (const [key] of due.slice(0, 3)) {
      const item = (await store.read()).runtime?.notifications?.[key];
      if (!item || item.status !== 'pending') continue;
      try {
        const message = await telegram.call('sendMessage', { chat_id: owner, text: messageOf(item.event),
          link_preview_options: { is_disabled: true } });
        if (!Number.isSafeInteger(message?.message_id) || message.message_id < 1
          || String(message.chat?.id) !== owner || message.chat?.type !== 'private') {
          throw failure('notification_delivery_unverified');
        }
      } catch (error) { await pendingFailure(key, error); continue; }
      // A failed or uncertain send is never recorded as delivered. If Telegram
      // accepted a send but its response was lost, a retry can repeat the alert.
      await store.update((current) => {
        const entry = current.runtime?.notifications?.[key];
        if (entry?.status !== 'pending') return;
        entry.status = 'sent'; entry.sentAt = stamp(now); entry.lastError = null;
        entry.attempts = (entry.attempts ?? 0) + 1; entry.lastAttemptAt = entry.sentAt;
      });
      sent++;
    }
    return { sent, pending: pending.length - sent };
  }
  async function flush() {
    if (flushing) return flushing;
    flushing = flushPending();
    try { return await flushing; } finally { flushing = null; }
  }
  async function report(raw) {
    const event = normalizeEvent(raw);
    if (!event) return { delivery: 'ignored' };
    const logOnly = !owner || event.type === 'runtime_initialized';
    const fingerprint = digest({ destinationHash, type: event.type, jobId: event.jobId,
      code: event.code ?? null, action: event.action ?? null,
      // Preserve the pre-incident fingerprint for all existing notifications.
      ...(event.incidentId ? { incidentId: event.incidentId } : {}) });
    const created = await store.update((state) => {
      state.runtime ??= {}; state.runtime.notifications ??= {};
      if (event.type === 'telegram_recovered') {
        // Once recovery is durably queued, an unsent outage notice for this
        // incident must not appear later as though the outage were still live.
        for (const item of Object.values(state.runtime.notifications)) {
          if (item.status === 'pending' && item.destinationHash === destinationHash
            && item.event?.type === 'telegram_error' && item.event.incidentId === event.incidentId) {
            item.status = 'superseded'; item.supersededAt = stamp(now);
            item.supersededBy = fingerprint;
          }
        }
      }
      if (state.runtime.notifications[fingerprint]) return false;
      state.runtime.notifications[fingerprint] = { status: logOnly ? 'logged' : 'pending',
        destinationHash, event, createdAt: stamp(now), attempts: 0 };
      return true;
    });
    if (created) log({ ...metadata(event, stamp(now)), delivery: logOnly ? 'log_only' : 'pending' });
    if (logOnly) return { delivery: created ? 'log_only' : 'duplicate', fingerprint };
    await flush();
    const entry = (await store.read()).runtime?.notifications?.[fingerprint];
    if (entry?.status === 'superseded') return { delivery: 'superseded', fingerprint };
    return { delivery: !created && entry?.status === 'sent' ? 'duplicate' : entry?.status === 'sent' ? 'sent' : 'pending', fingerprint };
  }
  report.verifyOwner = verifyOwner;
  report.flush = flush;
  return report;
}
