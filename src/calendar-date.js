// PostgreSQL DATE is a calendar value, not a timestamp. pg returns it as a
// Date at local midnight; converting that value to UTC can change the day.
function calendarDate(value) {
  let text;
  if (typeof value === 'string') text = value.slice(0,10);
  else if (value && typeof value.getFullYear === 'function' && typeof value.getTime === 'function' && Number.isFinite(value.getTime()))
    text = String(value.getFullYear()).padStart(4,'0')+'-'+String(value.getMonth()+1).padStart(2,'0')+'-'+String(value.getDate()).padStart(2,'0');
  else return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const check = new Date(text+'T12:00:00Z');
  return Number.isFinite(check.getTime()) && check.toISOString().slice(0,10) === text ? text : '';
}
const moscowDay = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
function moscowToday(now = Date.now()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(moscowDay.formatToParts(date).map(part=>[part.type,part.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function calendarRu(value) {
  const day = calendarDate(value);
  return day ? day.slice(8,10)+'.'+day.slice(5,7)+'.'+day.slice(0,4) : '—';
}
function isOrderOverdue(order, now = Date.now()) {
  const day = calendarDate(order.deadline);
  return !!day && !['done','cancelled'].includes(order.status) && day < moscowToday(now);
}
module.exports = { calendarDate, calendarRu, moscowToday, isOrderOverdue };
