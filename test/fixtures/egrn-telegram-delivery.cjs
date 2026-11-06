// Transport-only VM fixtures deliberately omit SQL leases and staff tables.
// The real durable protocol is exercised by egrn-integrity / telegram-delivery.
'use strict';
exports.createEgrnTelegramDelivery = ({pool}) => ({
  async authorize() {}, assertAvailable() {},
  send(order, operation, run) { return run(); },
  async persist(order,records) {
    await pool.query('UPDATE egrn_orders SET file_msgs=$1,updated_at=NOW() WHERE id=$2 AND processing_token=$3',[JSON.stringify(records),order.id,order.processing_token]);
    order.file_msgs=records;
  },
  async retry(statement) {
    const order=(await pool.query("UPDATE egrn_orders SET files_sent=0, failures=0, retry_at=NULL, error=NULL, updated_at=NOW() WHERE id_statement=$1 AND status='done' AND files_sent<=0 AND created_at > NOW()-INTERVAL '30 days' RETURNING id",[statement])).rows[0];
    return {state:order?'ready':'missing',order};
  },
});
