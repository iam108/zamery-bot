'use strict';

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value+'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

// Attention and completion are independent: a document group can contain a
// confirmed missing document while the rest of the group is still unchecked.
function isChecklistItemResolved(item, value, validDate = validCalendarDate) {
  if (!item) return false;
  if (item.t === 'k') return value && ['ok','bad','na'].includes(value.s);
  if (item.t === 'flag') return value && ['yes','no'].includes(value.s);
  if (item.t === 'term') return value && validDate(value.from) && validDate(value.to);
  if (item.t === 'sig') return value && typeof value.at === 'string' && value.at.trim();
  if (item.t === 'docs') return value && value.m && item.o.every(name => ['ok','bad'].includes(value.m[name]));
  if (item.t === 'p' || item.t === 'r') return item.o.includes(value);
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = { isChecklistItemResolved };
