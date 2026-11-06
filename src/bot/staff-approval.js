'use strict';

const ROLES = { manager: 'Менеджер', lawyer: 'Юрист', auditor: 'Аудитор' };
function approvalKeyboard(id, role) {
  return { inline_keyboard: [[
    { text: '✅ Одобрить', callback_data: 'ap:' + id + ':' + role },
    { text: '❌ Отклонить', callback_data: 'rj:' + id + ':' + role },
  ]] };
}

function createStaffApprovalHandler({ pool, approvers, adminIds = () => [] }) {
  async function edit(ctx, text, options) {
    try { await ctx.editMessageText(text, options); }
    catch (error) {
      if (!(error.response?.error_code === 400 && /message is not modified/i.test(error.response.description || ''))) throw error;
    }
  }
  async function allowed(ctx) {
    if ((await approvers()).map(String).includes(String(ctx.from.id))) return true;
    await ctx.answerCbQuery('Одобрять может только администратор', { show_alert: true });
    return false;
  }
  async function refresh(ctx, id, row) {
    if (!row || !Object.hasOwn(ROLES, row.requested_role)) {
      await edit(ctx, 'Запрос уже обработан.');
      return ctx.answerCbQuery('Запрос уже обработан.');
    }
    await edit(ctx, 'Актуальный запрос: ' + row.name + '\nПросит роль: ' + ROLES[row.requested_role] + '\nПроверьте роль перед подтверждением.', {
      reply_markup: approvalKeyboard(id, row.requested_role),
    });
    return ctx.answerCbQuery('Запрос обновлён. Подтвердите актуальную роль.');
  }
  return async ctx => {
    if (!await allowed(ctx)) return;
    const [, action, id, expectedRole] = ctx.match;
    const load = async () => (await pool.query('SELECT * FROM staff WHERE tg_id=$1', [id])).rows[0];
    const row = await load();
    // Legacy buttons do not identify the role shown to the reviewer. Refresh
    // them first instead of approving a later, different request by accident.
    if (!row || !expectedRole || row.requested_role !== expectedRole) return refresh(ctx, id, row);
    const explicitAdmin = adminIds().map(String).includes(String(ctx.from.id));
    const permission = ` AND ($3::boolean OR EXISTS (SELECT 1 FROM staff reviewer
      WHERE reviewer.tg_id=$4 AND reviewer.approved IS TRUE AND reviewer.role='manager'))`;
    const args = [id, expectedRole, explicitAdmin, ctx.from.id];
    let result;
    if (action === 'ap') result = await pool.query(`UPDATE staff SET role=$2,approved=true,requested_role=NULL
      WHERE tg_id=$1 AND requested_role=$2${permission} RETURNING name`, args);
    else if (row.approved === true) result = await pool.query(`UPDATE staff SET requested_role=NULL
      WHERE tg_id=$1 AND requested_role=$2 AND approved IS TRUE${permission} RETURNING name`, args);
    else result = await pool.query(`DELETE FROM staff WHERE tg_id=$1 AND requested_role=$2 AND approved IS NOT TRUE${permission} RETURNING name`, args);
    if (!result.rows.length) {
      if (!await allowed(ctx)) return;
      return refresh(ctx, id, await load());
    }
    const who = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), wanted = ROLES[expectedRole];
    await edit(ctx, action === 'ap'
      ? '✅ ' + result.rows[0].name + ' — ' + wanted + '. Одобрил(а): ' + who
      : '❌ ' + result.rows[0].name + ' — запрос на роль «' + wanted + '» отклонён. ' + who);
    try { await ctx.telegram.sendMessage(id, action === 'ap'
      ? '✅ Доступ открыт: ' + wanted + '. Нажмите /start'
      : '❌ Запрос на роль «' + wanted + '» отклонён.'); } catch (_) {}
    await ctx.answerCbQuery();
  };
}

module.exports = { approvalKeyboard, createStaffApprovalHandler };
