'use strict';

// This endpoint is under /api/audit's existing staff authentication. Accept
// an order id only: contacts, device location and arbitrary lookup URLs never
// enter the geocoding request.
function setupOrderRoute(app, options = {}) {
  const getOrder = options.getOrder || require('../db/queries').getOrderById;
  const geocode = options.geocode || (address => require('./route-geocoder').geocodeRouteAddress(address));
  app.get('/api/audit/orders/:id/route', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ok:false,error:'Некорректный номер заявки'});
    try {
      const order = await getOrder(id);
      if (!order) return res.status(404).json({ok:false,error:'Заявка не найдена'});
      if (!String(order.address || '').trim()) return res.status(400).json({ok:false,error:'В заявке не указан адрес объекта'});
      const result = await geocode(order.address);
      return res.json({ok:true,...result});
    } catch (error) {
      const known = error && /^GEOCODER_|^INVALID_ADDRESS$|^INCOMPLETE_ADDRESS$/.test(error.code || '') && [400,429,502,503,504].includes(error.status);
      return res.status(known ? error.status : 502).json({ok:false,code:known ? error.code : 'ROUTE_UNAVAILABLE',error:known ? error.message : 'Не удалось определить адрес. Повторите попытку или откройте адрес в Картах.'});
    }
  });
}

module.exports = { setupOrderRoute };
