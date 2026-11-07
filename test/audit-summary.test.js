const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditSummary, buildAuditBrief } = require('../src/bot/audit-summary');
const { compactVisit, addOrganization } = require('./helpers/audit-v5');
const { splitTelegramHtml } = require('../src/bot/audit-delivery');
const copy = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('summary leads with outcome and keeps explicit handoff identity without repeating manager instructions or file names', () => {
  const data = compactVisit('catering', 'Продление');
  data.inspection.visit_date = '2026-11-02'; data.inspection.alcohol_present = 'Да'; data.inspection.alcohol_within_licensed = 'Да';
  data.request_packet.zones_info = 'МЕНЕДЖЕРСКАЯ ДЛИННАЯ ЗАДАЧА'; data.request_packet.contacts = 'ЛИЧНЫЙ КОНТАКТ';
  data.request_packet.archive_url = 'https://disk.yandex.ru/d/ARCHIVE-EXACT';
  data.workflow.video_url = 'https://disk.yandex.ru/d/VIDEO-EXACT'; data.inspection.video_status = 'Сделано';
  const result = buildAuditSummary(data, '@auditor');
  assert.match(result.html, /^<b>ООО Пример · отчёт №58<\/b>/);
  assert.match(result.html, /Продление · алкоголь · общепит/);
  assert.match(result.html, /02\.11\.2026 · аудитор @auditor/);
  assert.ok(result.html.indexOf('Итог аудитора:') < result.html.indexOf('По осмотру'));
  assert.match(result.html, /Алкоголь в лицензированной зоне/);
  assert.doesNotMatch(result.html, /МЕНЕДЖЕРСКАЯ|ЛИЧНЫЙ КОНТАКТ|Поэтажный план\.pdf|Карта\.png|VIDEO-EXACT|ARCHIVE-EXACT/);
  assert.match(result.plain, /^Организация: ООО Пример$/m);
  assert.match(result.plain, /^Адрес: Москва, Никольская, 1$/m);
  assert.match(result.plain, /^Услуга: Продление$/m);
  assert.match(result.plain, /Видео: https:\/\/disk\.yandex\.ru\/d\/VIDEO-EXACT/);
  assert.match(result.plain, /Архивная папка: https:\/\/disk\.yandex\.ru\/d\/ARCHIVE-EXACT/);
});

test('an actions outcome without recorded concrete tasks or mitigation says so instead of inventing a reason', () => {
  const data = compactVisit(); data.workflow.conclusion_status = 'actions';
  data.conclusion = 'Помещение без изменений с последней проверки.';
  const result = buildAuditSummary(data, 'Саша');
  assert.match(result.html, /Итог аудитора: нужны действия/);
  assert.match(result.html, /Конкретное действие не указано\./);
  assert.match(result.html, /Помещение без изменений с последней проверки\./);
  data.workflow.mitigation = 'Получить актуальную поэтажку';
  const withMitigation = buildAuditSummary(data, 'Саша');
  assert.match(withMitigation.html, /Предлагаемые действия: Получить актуальную поэтажку/);
  assert.doesNotMatch(withMitigation.html, /Конкретное действие не указано/);
});

test('discrepancies and follow-up actions appear first without changing the recorded answers', () => {
  const data = compactVisit('retail', 'Продление'); data.workflow.conclusion_status = 'actions';
  Object.assign(data.inspection, { floor_actual: '2', cadastral_count: '2', inter_cadastral_boundary: 'Объединены',
    rooms_complete: 'Нет', within_cadastral: 'Нет', kkt_count: '2', kkt_ip: 'Да', alcohol_present: 'Да', alcohol_within_licensed: 'Нет',
    archive_match: 'Нет', licensed_boundaries_match: 'Нет', plan_note: 'Убрана стена между залами' });
  data.bti = 'Нет'; data.to = 'Нужно'; data.workflow.mitigation = 'Сверить границы с клиентом';
  const before = copy(data), result = buildAuditSummary(freeze(data), '@audit');
  assert.deepEqual(copy(data), before);
  for (const text of ['Этаж на плане и фактический этаж различаются', 'Не все комнаты из плана входят в объект',
    'Убрана стена между залами', 'Алкоголь находится за пределами лицензированной зоны', 'Сверить границы с клиентом']) {
    assert.ok(result.html.includes(text), text);
    assert.ok(result.html.indexOf(text) < result.html.indexOf('<b>По осмотру</b>'), text + ' must be in the lead');
  }
  for (const text of ['2 кадастра', 'не вся площадь входит в объект', 'Границы нарушены', 'ТО требуется', '2 кассы', 'есть касса ИП', 'Архив: есть расхождения']) assert.ok(result.html.includes(text), text);
  assert.doesNotMatch(result.html, /Конкретное действие не указано/);
});

test('HTML safely escapes every user-authored field and licenses use a labeled HTTP link', () => {
  const data = addOrganization(compactVisit(), { name: 'Школа <script>alert(1)</script>', status: 'licensed', source: 'https://example.org/license?q=a&name=%22one%22', note: 'Аудитор: <b>проверено</b>' });
  data.inspection.org = '<ООО & Объект>'; data.inspection.address = '<Адрес>'; data.conclusion = 'Комментарий <img src=x> & текст';
  data.workflow.territory_notes = '<Территория>'; data.workflow.followup_notes = '<Договорённости>';
  const result = buildAuditSummary(data, '<actor>');
  assert.doesNotMatch(result.html, /<script>|<img |<actor>|<Адрес>|<Договорённости>/);
  assert.match(result.html, /&lt;ООО &amp; Объект&gt;/);
  assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(result.html, />Источник сведений<\/a>/);
  assert.doesNotMatch(result.html, />https:\/\/example\.org/);
  assert.match(result.plain, /Источник: https:\/\/example\.org\/license/);
  data.zones[0].source = 'javascript:alert(1)';
  assert.doesNotMatch(buildAuditSummary(data, 'аудитор').html, /href="javascript:/);
});

test('acquisition states alcohol presence without carrying over hidden renewal comparisons', () => {
  const data = compactVisit('retail', 'Получение'); data.workflow.conclusion_status = 'actions';
  Object.assign(data.inspection, { alcohol_present: 'Да', alcohol_within_licensed: 'Да', archive_match: 'Нет', licensed_boundaries_match: 'Нет' });
  const result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Получение: на объекте есть алкоголь/);
  assert.match(result.html, /Алкоголь на объекте есть/);
  assert.doesNotMatch(result.html, /Алкоголь в лицензированной зоне|Архив:|Лицензированные границы:/);
});

test('tobacco summary has its three checks and no stale alcohol observation', () => {
  const data = compactVisit('tobacco'); data.workflow.conclusion_status = 'insufficient';
  Object.assign(data.inspection, { tobacco_display: 'Открытая', tobacco_price_list: 'Нет', tobacco_advertising: 'Не проверено', alcohol_present: 'Да', alcohol_within_licensed: 'Нет' });
  const result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Табак: выкладка — открытая; перечень цен — нет; реклама — не проверено/);
  assert.match(result.html, /Зафиксирована открытая выкладка/);
  assert.match(result.html, /Перечень продукции с ценами отсутствует/);
  assert.doesNotMatch(result.html, /Алкоголь|Алкоголя|алкоголь/);
});

test('archive skip and unverified answers stay explicit and are never reported as a completed comparison', () => {
  const data = compactVisit('catering', 'Продление'); data.workflow.conclusion_status = 'insufficient';
  data.workflow.archive_skipped = 'Да'; data.inspection.alcohol_present = 'Не проверено';
  let result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Архив не предоставлен; сверка с архивом не выполнена/);
  assert.match(result.html, /Архив: сверка пропущена/);
  assert.match(result.html, /Наличие алкоголя не проверено/);
  assert.doesNotMatch(result.html, /Лицензированные границы: сохранены|Алкоголь в лицензированной зоне/);
  data.workflow.archive_skipped = ''; data.inspection.archive_match = 'Не проверено'; data.inspection.licensed_boundaries_match = 'Не проверено';
  result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Архив: сверка не выполнена/);
  assert.match(result.html, /Лицензированные границы: не проверены/);
  data.inspection.archive_match = ''; data.inspection.licensed_boundaries_match = '';
  assert.match(buildAuditSummary(data, 'аудитор').html, /результат сверки не отмечен/);
});

test('territory keeps drawing codes, measured endpoints and distinct notes without claiming no restriction from an empty list', () => {
  const data = addOrganization(compactVisit(), { id: 'org-4', code: 'О4', status: 'disputed', source: 'Запрос в реестр', note: 'Назначение уточняется', name: 'Организация А' });
  data.workflow.conclusion_status = 'insufficient'; data.map.annotations[0].code = 'В3'; data.entrances[0].label = 'Вход 1';
  data.map.annotations.push({ id: 'measure', code: 'М2', tool: 'straight', distance: '12,5', fromEntranceId: data.entrances[0].id, toObjectId: 'org-4', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] });
  data.zones[0].dist = '12,5'; data.zones[0].resolution = data.zones[0].note; data.zones[0].info = 'Второй важный факт';
  let result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Вход: В3\n/); assert.doesNotMatch(result.html, /Вход: В1|Вход: В3 — Вход 1/);
  assert.match(result.html, /О4 · Организация А — спорное место/);
  assert.match(result.html, /М2 · В3 → О4 · 12,5 м · прямая линия/);
  assert.match(result.html, /Второй важный факт/);
  assert.equal(result.html.match(/^  Назначение уточняется$/gm)?.length, 1, 'mirrored fields are not repeated in the organization description');
  data.zones = []; data.map.annotations = data.map.annotations.filter(mark => mark.tool === 'entrance');
  data.workflow.territory_notes = 'Зон не обнаружено'; result = buildAuditSummary(data, 'аудитор');
  assert.match(result.html, /Организации не перечислены/);
  assert.match(result.html, /Аудитор сообщил: Зон не обнаружено/);
  assert.doesNotMatch(result.html, /Зоны запрета отсутствуют|Зон нет/);
});

test('a long auditor comment survives unchanged and remains splittable into valid Telegram message sizes', () => {
  const data = compactVisit(); data.conclusion = 'Начало <важного> комментария\n' + 'Полный текст замечания. '.repeat(240) + '\nПоследняя строка';
  const before = copy(data), result = buildAuditSummary(data, '@audit');
  assert.ok(result.plain.includes(data.conclusion));
  assert.ok(result.html.includes(data.conclusion.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.ok(result.html.endsWith('Последняя строка'));
  const parts = splitTelegramHtml(result.html);
  assert.ok(parts.length > 1); assert.ok(parts.every(part => part.length <= 3500));
  assert.ok(parts.at(-1).includes('Последняя строка')); assert.deepEqual(copy(data), before);
});

test('no image-address conclusion is invented from document names, video folder names or an unrelated packet field', () => {
  const data = compactVisit(); data.evidence[0].name = 'Лесная-5.pdf'; data.workflow.video_url = 'https://disk.yandex.ru/d/Lesnaya-5';
  const result = buildAuditSummary(data, '@audit');
  assert.match(result.html, /Москва, Никольская, 1/);
  assert.doesNotMatch(result.html, /Лесная|Lesnaya|адрес.*не совпад|друг.*адрес/);
});

test('a Unicode source URL that expands past a Telegram message remains fully readable without an oversized HTML tag', () => {
  const data = addOrganization(compactVisit());
  const source = 'https://example.invalid/?q=' + 'кириллица'.repeat(80);
  assert.ok(source.length < 1000); assert.ok(new URL(source).href.length > 3500);
  data.zones[0].status = 'licensed'; data.zones[0].source = source;
  const result = buildAuditSummary(data);
  const parts = splitTelegramHtml(result.html);
  assert.ok(parts.length > 0); assert.ok(parts.every(part => part.length <= 3500));
  assert.ok(result.plain.includes(source));
  assert.ok(parts.join('').includes(source));
});

test('brief leads with the exact object, service, outcome and critical recorded facts while preserving the full report', () => {
  const data=compactVisit('catering','Получение');data.workflow.conclusion_status='actions';data.workflow.territory_result='clear';
  data.map={annotations:[]};data.inspection.visit_date='2026-11-07';data.to='Нужно';data.inspection.alcohol_present='Да';
  data.bti='Нет';data.inspection.plan_note='Снесена перегородка между залом и складом';
  const before=copy(data),full=buildAuditSummary(data,'@audit'),brief=buildAuditBrief(freeze(data),'@audit');
  assert.match(brief.html,/^<b>ООО Пример · отчёт №58<\/b>/);assert.match(brief.plain,/Получение · алкоголь · общепит/);assert.match(brief.plain,/Москва, Никольская, 1/);
  assert.match(brief.plain,/Итог аудитора: нужны действия/);assert.match(brief.plain,/Здание: жилое/);assert.match(brief.plain,/ТО: требуется/);assert.match(brief.plain,/Алкоголь: есть/);
  assert.match(brief.plain,/Снесена перегородка между залом и складом/);assert.match(brief.plain,/07\.11\.2026/);assert.match(brief.plain,/@audit/);
  assert.ok(brief.html.length<=2600);assert.equal(splitTelegramHtml(brief.html).length,1);assert.deepEqual(copy(data),before);assert.deepEqual(buildAuditSummary(data,'@audit'),full);
});

test('brief separates unresolved facts from recorded discrepancies and names the actual floor values', () => {
  const data=compactVisit('retail','Продление');data.workflow.conclusion_status='insufficient';data.inspection.floor_actual='2';
  data.workflow.archive_skipped='Да';data.inspection.alcohol_present='Не проверено';data.workflow.territory_result='clear';data.map={annotations:[]};
  const brief=buildAuditBrief(data,'аудитор');
  assert.match(brief.plain,/Этаж: по плану 1, фактически 2/);assert.match(brief.plain,/Уточнить юристу/);assert.match(brief.plain,/Архив не предоставлен|сверка с архивом не выполнена/);assert.match(brief.plain,/Наличие алкоголя не установлено|наличие алкоголя/i);
  assert.doesNotMatch(brief.plain,/Архив свер[её]н|Алкоголь: нет|без замечаний/i);
});

test('brief caps concrete action and lawyer-question lists and explicitly points to omitted items in the full report', () => {
  const data=addOrganization(compactVisit('catering','Продление'),{status:'pending',name:'Учебный центр',note:'Нужно уточнить назначение'});
  Object.assign(data.inspection,{floor_actual:'2',rooms_complete:'Нет',within_cadastral:'Нет',alcohol_present:'Не проверено'});data.to='Нужно';data.bti='Нет';data.inspection.plan_note='Изменена перегородка';data.workflow.archive_skipped='Да';data.workflow.conclusion_status='actions';
  const brief=buildAuditBrief(data,'аудитор'),actions=brief.plain.split('Замечания / действия\n')[1].split('\n\n')[0],questions=brief.plain.split('Уточнить юристу\n')[1].split('\n\n')[0];
  assert.equal(actions.split('\n').filter(line=>line.startsWith('• ')).length,3);assert.equal(questions.split('\n').filter(line=>line.startsWith('• ')).length,2);assert.match(actions,/Ещё \d+.*полном отч[её]те/);assert.match(questions,/Ещё \d+.*полном отч[её]те/);assert.ok(brief.html.length<=2600);
});

test('brief never invents tasks from a free-text comment and keeps an unexplained action outcome explicit', () => {
  const data=compactVisit();data.workflow.territory_result='clear';data.map={annotations:[]};data.workflow.conclusion_status='actions';data.conclusion='Клиент сообщил: перегородка может быть временной.';
  const brief=buildAuditBrief(data,'аудитор');assert.match(brief.plain,/Конкретные действия не указаны/);assert.match(brief.plain,/Уточнить причину выбранного итога/);assert.match(brief.plain,/Комментарий аудитора: Клиент сообщил: перегородка может быть временной/);
  assert.doesNotMatch(brief.plain,/Снести|Убрать перегородку|нарушение границ/);
});

test('brief does not claim full inspection for an uninspected entrance or an unspecified territory result', () => {
  const data=compactVisit();data.entrances[0].access='Не осмотрен';data.workflow.conclusion_status='insufficient';delete data.workflow.territory_result;
  const brief=buildAuditBrief(data,'аудитор');assert.match(brief.plain,/входы 0 из 1/i);assert.match(brief.plain,/территория: результат не отмечен/i);assert.doesNotMatch(brief.plain,/все входы осмотрены|зон нет|ограничений нет|без замечаний/i);
});

test('tobacco brief shows its recorded checks without carrying stale alcohol or renewal answers into the outcome', () => {
  const data=compactVisit('tobacco');Object.assign(data.inspection,{tobacco_display:'Открытая',tobacco_price_list:'Нет',tobacco_advertising:'Не проверено',alcohol_present:'Да',alcohol_within_licensed:'Нет',archive_match:'Нет'});data.workflow.conclusion_status='actions';
  const brief=buildAuditBrief(data,'аудитор');assert.match(brief.plain,/табак/i);assert.match(brief.plain,/открытая выкладка|Выкладка: открытая/i);assert.match(brief.plain,/ценами отсутствует|Перечень цен: нет/i);assert.match(brief.plain,/Реклама: не проверена/);assert.doesNotMatch(brief.plain,/Алкоголь|алкоголь|Архив/);
});

test('generic brief attributes the written outcome and optional facts without manufacturing a licence conclusion or tasks', () => {
  const data={ui_version:5,object_category:'other',order_id:62,inspection:{org:'Другой объект',address:'Москва, Тестовая, 62'},workflow:{conclusion_status:'ready'},building_type:'Нежилое',to:'Не обязательно',conclusion:'Владелец уточнит назначение помещения; документы не представлены.',entrances:[],zones:[]};
  const brief=buildAuditBrief(freeze(data),'@audit');assert.match(brief.plain,/Общий осмотр · Другое/);assert.match(brief.plain,/Владелец уточнит назначение помещения; документы не представлены/);assert.match(brief.plain,/ТО: не обязательно/);assert.doesNotMatch(brief.plain,/соответствует по проверенным|Алкоголь|Замечания \/ действия|Замечаний.*не отмечено/i);
});

test('brief bounds escaped Unicode and long comments without losing any full-report observations or inventing media links', () => {
  const data=compactVisit();data.inspection.org='&<😀>'.repeat(200);data.inspection.address='&<Адрес😀>'.repeat(200);data.workflow.mitigation='&<Действие😀>'.repeat(300);data.conclusion='&<Комментарий😀>'.repeat(600);data.workflow.followup_notes='ЛИЧНЫЕ ДОГОВОРЁННОСТИ';data.request_packet.contacts='ПРИВАТНЫЕ КОНТАКТЫ';
  const full=buildAuditSummary(data,'@audit'),brief=buildAuditBrief(freeze(data),'<actor😀>');
  assert.ok(brief.html.length<=2600,brief.html.length);assert.equal(splitTelegramHtml(brief.html).length,1);assert.doesNotMatch(brief.html,/<actor|<Адрес|<Комментарий|ПРИВАТНЫЕ КОНТАКТЫ|ЛИЧНЫЕ ДОГОВОРЁННОСТИ|href=/);assert.match(brief.html,/&lt;/);assert.match(brief.plain,/…/);assert.match(brief.plain,/полный|полном/i);assert.ok(full.plain.includes(data.conclusion));assert.deepEqual(buildAuditSummary(data,'@audit'),full);
});

test('the largest escaped identity, lists, comment and attribution still fit one brief without splitting emoji or HTML entities', () => {
  const data=compactVisit('catering','Продление'),long='&<😀>'.repeat(500);
  Object.assign(data.inspection,{org:long,address:long,floor_actual:'2',rooms_complete:'Нет',within_cadastral:'Нет',alcohol_present:'Не проверено',licensed_boundaries_match:'Не проверено'});data.to='Нужно';data.bti='Нет';data.inspection.plan_note=long;
  data.workflow.archive_skipped='Да';data.workflow.conclusion_status='actions';data.workflow.mitigation=long;data.conclusion=long;
  for(let i=0;i<8;i++)addOrganization(data,{id:'org-'+i,code:'О'+i,status:'confirmed',name:long,note:long});
  const brief=buildAuditBrief(freeze(data),long);assert.ok(brief.html.length<=2600,brief.html.length);assert.equal(splitTelegramHtml(brief.html).length,1);
  assert.ok(brief.plain.includes('Ещё '));assert.equal(Array.from(brief.html).some(character=>character.length===1&&/[\uD800-\uDFFF]/.test(character)),false);
  assert.equal((brief.html.match(/<b>/g)||[]).length,(brief.html.match(/<\/b>/g)||[]).length);assert.doesNotMatch(brief.html,/&(?:am|l|g)$/);
});
