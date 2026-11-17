'use strict';

const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

function technicalDescriptionPaymentLabel(value) {
  if (value === 'paid') return 'оплачено';
  if (value === 'unpaid') return 'не оплачено';
  return '';
}

// The client card is the manager's confirmed legal entity. Keep it separate
// from the historical object/brand in the auditor's source order and report.
function savedCaseProfile(row) {
  if (!row || !text(row.org)) return null;
  const profile = {};
  for (const key of ['org','address','inn','region','kind','service']) profile[key] = text(row[key]);
  if (text(row.comment)) profile.comment = text(row.comment);
  if (text(row.priority)) profile.priority = text(row.priority);
  const fields = row.data?._handoff?.fields;
  profile.cad_num = text(fields?.cad_num);
  if (technicalDescriptionPaymentLabel(fields?.technical_description_payment)) {
    profile.technical_description_payment = fields.technical_description_payment;
  }
  profile.contacts = Array.isArray(row.contacts) ? row.contacts.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => Object.fromEntries(['name','phone','tg','comment'].map(key => [key,text(item[key])]))).filter(item => Object.values(item).some(Boolean)) : [];
  return profile;
}

module.exports = { savedCaseProfile, technicalDescriptionPaymentLabel };
