'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('./helpers');
let service;
before(async()=>{service=await createService();});
after(async()=>{await service?.close();});

test('expired admin API sessions return an explicit login error and never publish a changed card', {timeout:30000}, async()=>{
    const response=await fetch(service.origin+'/admin/api/status',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:58,status:'done'})});
    assert.equal(response.status,401);const result=await response.json();assert.equal(result.code,'ADMIN_LOGIN_REQUIRED');assert.match(result.error,/войти/i);
    assert.equal((await service.pool.query('SELECT status FROM orders WHERE id=58')).rows[0].status,'in_progress');assert.equal(service.messages.length,0);
    const page=await fetch(service.origin+'/admin',{redirect:'manual'});assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/admin/login');
});

test('the obsolete report form redirects to the durable form and direct submissions cannot publish untracked messages', {timeout:30000}, async()=>{
    const query=service.keyQuery(1001)+'&order_id=58';
    const page=await fetch(service.origin+'/audit/legacy?'+query,{redirect:'manual'});assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/audit?'+query);
    const auth=new URLSearchParams(service.keyQuery(1001));
    const response=await fetch(service.origin+'/api/audit',{method:'POST',headers:{'Content-Type':'application/json','X-Tg-U':auth.get('u'),'X-Tg-K':auth.get('k')},body:JSON.stringify({conclusion:'Старая форма без сохранённого черновика',org:'Синтетический объект'})});
    assert.equal(response.status,409);const result=await response.json();assert.equal(result.code,'AUDIT_DRAFT_REQUIRED');assert.match(result.error,/форм/);
    assert.equal(service.messages.length,0);assert.equal((await service.pool.query('SELECT id FROM audits')).rows.length,0);
});
