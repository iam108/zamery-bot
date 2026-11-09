'use strict';

const LEASE_MS = 2 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const validReceipt = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
function matchesRecipient(message, expectedChat) {
  if (expectedChat == null || message?.chat == null) return true;
  if (typeof message.chat !== 'object' || Array.isArray(message.chat)) return false;
  const target = String(expectedChat);
  if (target.startsWith('@')) return typeof message.chat.username === 'string' && message.chat.username.toLowerCase() === target.slice(1).toLowerCase();
  return ['number', 'string'].includes(typeof message.chat.id) && String(message.chat.id) === target;
}
const { calendarDate: dateOnly } = require('../calendar-date');
const retryDelay = attempt => Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(6, Math.max(0, attempt-1)));

function createReminderDelivery(options = {}) {
  // Keep only acknowledgements, never messages or recipient objects. A
  // process restart loses this cache; its durable intent then becomes unknown.
  const pending = new Map(), maximum = options.cacheLimit == null ? 1000 : options.cacheLimit;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid reminder acknowledgement cache limit');
  function remember(key, receipt, now) {
    for (const [id, entry] of pending) if (entry.until <= now) pending.delete(id);
    pending.delete(key); pending.set(key, { receipt, until: now + 24 * 60 * 60 * 1000 });
    while (pending.size > maximum) pending.delete(pending.keys().next().value);
  }
  async function deliverRecipient({ key, slot, window, delivery, acknowledged, acknowledge, persist, send, beforeSend, expectedChat, now = Date.now(), nextRetryAt = time => time }) {
    delivery._attempts ||= {};
    let attempt = delivery._attempts[slot];
    if (!attempt || attempt.window !== window) attempt = { window, count: 0 };
    const save = async () => await persist() !== false;
    const saveReceipt = async messageId => {
      acknowledge(messageId);
      attempt = { ...attempt, state: 'confirmed', message_id: messageId, lease_until: null, next_at: null };
      delivery._attempts[slot] = attempt;
      // Retry this receipt rather than Telegram when storage briefly fails.
      for (let retry = 0; retry < 3; retry++) {
        try {
          if (!await save()) return 'inactive';
          pending.delete(key); return 'confirmed';
        } catch (_) {}
      }
      return 'unknown';
    };
    const cached = pending.get(key);
    if (cached && cached.until > now) return saveReceipt(cached.receipt);
    if (cached) pending.delete(key);
    // An earlier failed save may have placed the ACK in this same mutable
    // object. Its cache entry must be persisted before trusting that value.
    if (acknowledged()) return 'confirmed';
    if (attempt.state === 'sending') {
      if (attempt.lease_until > now) return 'sending';
      attempt = { ...attempt, state: 'unknown', lease_until: null, next_at: nextRetryAt(now + retryDelay(attempt.count)), duplicate_possible: true };
      delivery._attempts[slot] = attempt;
      return await save() ? 'unknown' : 'inactive';
    }
    if (attempt.next_at > now) return attempt.state || 'retrying';
    attempt = { ...attempt, state: 'sending', count: attempt.count+1, started_at: now, lease_until: now+LEASE_MS, next_at: null };
    delivery._attempts[slot] = attempt;
    if (!await save()) return 'inactive'; // No Telegram call without a durable intent.
    if (beforeSend && !await beforeSend()) {
      attempt = { ...attempt, state: 'blocked', lease_until: null, next_at: nextRetryAt(now+RETRY_MS) };
      delivery._attempts[slot] = attempt;
      return await save() ? 'blocked' : 'inactive';
    }
    let message;
    try {
      message = await send();
      if (!validReceipt(message && message.message_id) || !matchesRecipient(message, expectedChat)) throw new Error('Missing Telegram receipt for the intended recipient');
    } catch (error) {
      const code = Number(error?.response?.error_code);
      const rejected = code >= 400 && code < 500;
      attempt = { ...attempt, state: rejected ? 'retrying' : 'unknown', lease_until: null,
        next_at: nextRetryAt(now+retryDelay(attempt.count)), duplicate_possible: attempt.duplicate_possible || !rejected };
      delivery._attempts[slot] = attempt;
      return await save() ? attempt.state : 'inactive';
    }
    remember(key, Number(message.message_id), now);
    return saveReceipt(Number(message.message_id));
  }
  return { deliverRecipient };
}

function summarize(delivery, recipients, { sent = false, scheduledAt = 0, now = Date.now(), nextRetryAt = time => time } = {}) {
  const confirmed = recipients.filter(recipient => recipient.confirmed).length;
  const attempts = recipients.filter(recipient => !recipient.confirmed).map(recipient => {
    const attempt = delivery?._attempts?.[recipient.slot];
    return attempt && attempt.window === recipient.window ? attempt : {};
  });
  let state = sent || recipients.length > 0 && confirmed === recipients.length ? 'confirmed'
    : attempts.some(attempt => attempt.state === 'unknown' || attempt.state === 'sending' && attempt.lease_until <= now) ? 'unknown'
    : attempts.some(attempt => attempt.state === 'sending') ? 'sending'
    : confirmed > 0 ? 'partial'
    : attempts.some(attempt => attempt.next_at) ? 'retrying'
    : scheduledAt > now ? 'scheduled' : 'pending';
  const retryTimes = attempts.map(attempt => attempt.next_at || (attempt.state === 'sending' && attempt.lease_until <= now ? nextRetryAt(now+retryDelay(attempt.count)) : 0)).filter(Boolean);
  return { state, confirmed, total: recipients.length, nextAt: retryTimes.length ? new Date(Math.min(...retryTimes)).toISOString() : null,
    duplicatePossible: attempts.some(attempt => attempt.duplicate_possible || attempt.state === 'sending' && attempt.lease_until <= now) };
}

function accessProblem(access) {
  if (!access) return null;
  if (!access.checked || !access.allowed.length) return {
    state: access.checked ? 'no_recipient' : 'recipient_check_failed', confirmed: 0, total: 0,
    nextAt: access.next_at ? new Date(access.next_at).toISOString() : null, duplicatePossible: false,
  };
  return null;
}

function caseReminderStatus(reminder, lawyer, now = Date.now(), nextRetryAt, access) {
  const delivery = reminder.delivery || {}, window = dateOnly(reminder.remind_on);
  access ||= delivery._access;
  const blocked = accessProblem(access);
  if (blocked) return blocked;
  let recipients = [...new Set([lawyer,reminder.created_by].filter(value => /^[1-9]\d*$/.test(String(value))).map(String))]
    .filter(chat => !access || access.allowed.includes(chat));
  // Completion describes the lawful recipient set at delivery time. A former
  // creator regaining access later does not invent an acknowledgement for them.
  if (reminder.sent_at && delivery._access?.checked && delivery._access.allowed.length) {
    recipients = delivery._access.allowed.filter(chat => validReceipt(delivery[chat]));
  }
  return summarize(delivery, recipients.map(chat => ({ slot: chat, window, confirmed: validReceipt(delivery[chat]) })),
    { sent: !!reminder.sent_at, now, nextRetryAt, scheduledAt: Date.parse(window+'T06:00:00Z') });
}

function decisionReminderStatus(client, group, now = Date.now(), nextRetryAt, access) {
  if (!client.decision_due || !['Подано','Выездная проверка'].includes(client.data?._stage)) return null;
  const today = new Date(now+3*3600000).toISOString().slice(0,10), due = dateOnly(client.decision_due);
  if (due > today) return null;
  const delivery = client.decision_reminder_delivery?.due === due ? client.decision_reminder_delivery : {};
  const blocked = accessProblem(access || delivery._access);
  if (blocked) return blocked;
  const lawyer = String(client.lawyer_tg_id || ''), recipients = [{ slot: 'dm:'+lawyer, window: today,
    confirmed: delivery.dm?.on === today && delivery.dm?.chat === lawyer && validReceipt(delivery.dm?.message_id) }];
  const required = delivery.group_required ?? (!client.reminded_on && !!group);
  if (required) recipients.push({ slot: 'group:'+String(group), window: due, confirmed: validReceipt(delivery.group?.message_id) });
  return summarize(delivery, recipients, { now, nextRetryAt, sent: dateOnly(client.reminded_on) === today, scheduledAt: Date.parse(today+'T06:00:00Z') });
}

module.exports = { ...createReminderDelivery(), createReminderDelivery, caseReminderStatus, decisionReminderStatus, LEASE_MS, RETRY_MS };
