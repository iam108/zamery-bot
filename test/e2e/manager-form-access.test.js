'use strict';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, LAWYER } = require('./helpers');
let service,browser;
before(async()=>{service=await createService({master:true});browser=await chromium.launch();});
after(async()=>{await browser?.close();await service?.close();});

test('the order form checks access before typing and retains the lawyer files through failed authentication and retry', { timeout: 90000 }, async () => {
    const visit=await openPage(browser,service,LAWYER,{pathname:'/form',mobile:false}),page=visit.page;
    await page.waitForFunction(()=>managerAccessReady===true);
    // Remove every source of credentials in an independent browser session.
    const anonymous=await browser.newContext();
    await anonymous.route('https://telegram.org/js/**',route=>route.fulfill({contentType:'application/javascript',body:'window.Telegram={WebApp:{initData:"",initDataUnsafe:{},ready(){},expand(){}}};'}));
    const anon=await anonymous.newPage();let unauthenticatedPosts=0;
    anon.on('request',request=>{if(request.method()==='POST')unauthenticatedPosts++;});
    await anon.goto(service.origin+'/form');
    await anon.locator('#form-access-open').waitFor({state:'visible'});
    assert.equal(await anon.locator('#address').isDisabled(),true);
    assert.equal(await anon.locator('#submit-btn').isDisabled(),true);
    assert.match(await anon.locator('#form-access-message').innerText(),/не передал данные для входа/);
    assert.equal(unauthenticatedPosts,0);
    await anonymous.close();

    await page.locator('#address').fill('Москва, Синтетическая улица, 9');
    await page.locator('#owner_name').fill('Тестовый клиент юриста');
    await page.locator('#object_type').selectOption({label:'🍺 Общепит алкоголь'});
    await page.locator('#service').selectOption('Получение');
    const pdf=multiPagePdf();
    await page.locator('#attachments').setInputFiles({name:'План.pdf',mimeType:'application/pdf',buffer:pdf});
    const originalSubmitId=await page.evaluate(()=>submitId);
    const postPattern=service.origin+'/api/order';
    const denied=route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,error:'Synthetic expired authentication'})});
    await page.route(postPattern,denied);
    await page.locator('#submit-btn').click();
    await page.locator('#form-access-open').waitFor({state:'visible'});
    assert.equal(await page.locator('#address').inputValue(),'Москва, Синтетическая улица, 9');
    assert.equal(await page.locator('#submit-btn').isDisabled(),true);
    assert.equal(await page.locator('#submit-btn').innerText(),'Отправить заявку');
    assert.equal(await page.evaluate(()=>attachedFiles.length),1);
    assert.equal(await page.evaluate(()=>submitId),originalSubmitId);
    assert.equal(await page.evaluate(async()=>Array.from(new Uint8Array(await attachedFiles[0].arrayBuffer())).join(',')),Array.from(pdf).join(','));
    assert.equal((await service.pool.query('SELECT count(*) AS n FROM orders')).rows[0].n,5);
    await page.unroute(postPattern,denied);

    // A successful HTTP status with a protection page must not unlock the form.
    const accessPattern=service.origin+'/api/order/access';
    const protection=route=>route.fulfill({status:200,contentType:'text/html',body:'<html>Checking browser</html>'});
    await page.route(accessPattern,protection);await page.locator('#form-access-retry').click();
    await page.locator('#form-access-retry').waitFor({state:'visible'});
    assert.equal(await page.locator('#submit-btn').isDisabled(),true);
    assert.match(await page.locator('#form-access-message').innerText(),/Не удалось проверить вход/);
    await page.unroute(accessPattern,protection);

    // Actual current approval, not just a valid key, is required on retry.
    await service.pool.query('UPDATE staff SET approved=false WHERE tg_id=$1',[LAWYER]);
    await page.locator('#form-access-retry').click();
    await page.waitForFunction(()=>document.querySelector('#form-access-message').textContent.includes('Обратитесь к администратору'));
    assert.equal(await page.locator('#address').isDisabled(),true);
    await service.pool.query('UPDATE staff SET approved=true WHERE tg_id=$1',[LAWYER]);
    await page.locator('#form-access-retry').click();
    await page.waitForFunction(()=>managerAccessReady===true);
    assert.equal(await page.locator('#address').isDisabled(),false);
    assert.equal(await page.locator('#address').inputValue(),'Москва, Синтетическая улица, 9');
    assert.equal(await page.evaluate(()=>attachedFiles.length),1);
    assert.equal(await page.evaluate(()=>submitId),originalSubmitId);
    const saved=page.waitForResponse(response=>response.url()===postPattern&&response.request().method()==='POST');
    await page.locator('#submit-btn').click();const result=await saved;
    assert.equal(result.status(),200);assert.equal((await result.json()).ok,true);
    assert.equal((await service.pool.query('SELECT count(*) AS n FROM orders')).rows[0].n,6);
    assert.equal(service.egrnRequests.length,0);assert.deepEqual(visit.errors,[]);assert.deepEqual(visit.blocked,[]);
});

test('an edit form denied on its first access check loads its existing packet after authentication retry', {timeout:30000},async()=>{
  const context=await browser.newContext();let deny=true,packetReads=0;
  try {
    await context.route('**/*',route=>{
      const url=route.request().url();
      if(url.startsWith('https://telegram.org/js/'))return route.fulfill({contentType:'application/javascript',body:'window.Telegram={WebApp:{initData:"",initDataUnsafe:{},ready(){},expand(){},showAlert(){}}};'});
      if(url===service.origin+'/api/order/access'&&deny)return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,error:'Synthetic initial authentication denial'})});
      if(url.startsWith(service.origin+'/'))return route.continue();
      return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(10000);
    page.on('request',request=>{if(request.url()===service.origin+'/api/order/58')packetReads++;});
    await page.goto(service.origin+'/form?order_id=58&'+service.keyQuery(2001));
    await page.locator('#form-access-retry').waitFor({state:'visible'});
    assert.equal(packetReads,0);assert.equal(await page.locator('#address').isDisabled(),true);
    deny=false;await page.locator('#form-access-retry').click();
    await page.waitForFunction(()=>managerAccessReady===true&&packetReady===true);
    assert.equal(packetReads,1);assert.equal(await page.locator('#address').isDisabled(),false);
    assert.equal(await page.locator('#address').inputValue(),'Москва, Тестовая улица, 58');
    assert.equal(await page.locator('#owner_name').inputValue(),'Synthetic client');
    assert.equal(await page.locator('#submit-btn').isDisabled(),false);
    assert.equal(await page.locator('#submit-btn').innerText(),'Сохранить изменения');
    assert.equal(service.egrnRequests.length,0);
  } finally {await context.close();}
});
