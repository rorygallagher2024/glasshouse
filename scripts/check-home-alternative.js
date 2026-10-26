/* Browser regression checks run by check-dashboards.js, with weather and
 * geocoding intercepted: no personal location or external service is used. */
'use strict';
const assert = require('assert');

module.exports = async function checkHomeAlternative(browser, base, problems) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [], opens = [], requests = [], searches = [];
  page.on('pageerror', e => errors.push(e.message));
  const clone = v => JSON.parse(JSON.stringify(v));
  const layout = { rows: ['dev', 'app', 'ch'], order: {app:[],dev:[],ch:[]}, sort:{app:'custom',dev:'custom',ch:'custom'},
    hidden:{app:['hidden-app'],dev:[],ch:[]},channels:[],hintSeen:true,picture:false,fade:false,hideUnused:false,colours:null,
    view:'standard',weather:false };
  let version = 1, forecastMode = 'ok', searchMode = 'ok', heldForecast = null, extraApps = [];
  const catalogue = () => ({ok:true, layout:clone(layout), layoutVersion:String(version),wallpapers:{available:false},
    apps:[{id:'youtube',title:'YouTube'},{id:'prime',title:'Prime Video'},{id:'spotify',title:'Spotify'},
      {id:'homebrew',title:'Homebrew'},{id:'tools',title:'Tools'},{id:'hidden-app',title:'Hidden app'}].concat(extraApps),
    devices:[{id:'hdmi1',name:'HDMI 1',port:1,unused:true},{id:'switch',name:'Nintendo Switch',port:2,unused:false},
      {id:'hdmi3',name:'HDMI 3',port:3,unused:true}],channels:[],sources:{channels:0},
    order:{app:['youtube','prime','spotify','homebrew','tools','hidden-app'].concat(extraApps.map(a=>a.id),['lg-home']),dev:['hdmi1','switch','hdmi3'],ch:[]}});
  const staines = {name:'Staines-upon-Thames',country:'United Kingdom',country_code:'GB',admin1:'England',latitude:51.434,longitude:-0.5114,timezone:'Europe/London'};
  const paris = {name:'Paris',country:'France',country_code:'FR',admin1:'Ile-de-France',latitude:48.8534,longitude:2.3488,timezone:'Europe/Paris'};
  function model(lat) {
    const now = new Date(Date.now()), day = now.toISOString().slice(0,10);
    return {utc_offset_seconds:0,current:{time:day+'T'+now.toISOString().slice(11,16),temperature_2m:lat > 50 ? 12 : 18,
      apparent_temperature:11,is_day:1,weather_code:2,wind_speed_10m:7},current_units:{temperature_2m:'\u00b0C',wind_speed_10m:'mp/h'},
      daily:{time:[0,1,2,3].map(i=>new Date(now.getTime()+i*86400000).toISOString().slice(0,10)),weather_code:[2,3,61,0],
        temperature_2m_max:[14,15,13,16],temperature_2m_min:[8,9,8,10]}};
  }
  const fulfill = (route, body, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  await page.route('**/api/home/**', route => {
    const path = new URL(route.request().url()).pathname;
    let body = {ok:true,build:'test',layoutVersion:String(version),wallpapers:{available:false}};
    if (path === '/api/home/catalogue') body = catalogue();
    if (path === '/api/home/now') body = {kind:'app',title:'YouTube',appId:'youtube'};
    if (path === '/api/home/open') opens.push(route.request().postDataJSON());
    if (path === '/api/home/layout') {
      const patch = route.request().postDataJSON();
      for (const key of ['rows','sort','hidden','hintSeen','view','weather','colours']) if (patch[key] !== undefined) layout[key]=patch[key];
      if(patch.order) Object.assign(layout.order,patch.order);
      version++; body={ok:true,layout:clone(layout),layoutVersion:String(version)};
    }
    if(path === '/api/home/recents') body={ok:true,apps:[]};
    return fulfill(route,body);
  });
  await page.route('https://geocoding-api.open-meteo.com/**', route => {
    const query = new URL(route.request().url()).searchParams.get('name'); searches.push(query);
    if (searchMode === 'error') return fulfill(route,{error:true},429);
    if (searchMode === 'empty') return fulfill(route,{results:[]});
    if (searchMode === 'unsafe') return fulfill(route,{results:[Object.assign({},paris,{name:'<img src=x onerror=alert(1)>'})]});
    return fulfill(route,{results:query.toLowerCase().includes('paris')?[paris]:[staines,Object.assign({},staines,{admin1:'Other region'})]});
  });
  await page.route('https://api.open-meteo.com/**', route => {
    const url=new URL(route.request().url()); requests.push(url.toString());
    if(forecastMode==='hold'){heldForecast=route;return;}
    if(forecastMode==='error') return fulfill(route,{error:true},429);
    return fulfill(route,model(Number(url.searchParams.get('latitude'))));
  });
  let assertions=0;
  function ok(value,message){assertions++;assert.ok(value,message);}
  async function change(patch){Object.assign(layout,patch);version++;const reply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/home/catalogue');await page.evaluate(()=>document.dispatchEvent(new Event('webOSRelaunch')));await reply;await page.waitForTimeout(100);}
  async function key(code){await page.evaluate(code=>{for(const type of ['keydown','keyup'])document.dispatchEvent(new KeyboardEvent(type,{keyCode:code,bubbles:true}));},code);}
  async function search(name){await page.locator('#home-location-query').fill(name);await page.locator('#home-location-search').click();await page.waitForSelector('.home-location-result');}
  try {
    await page.clock.install();
    await page.goto(base+'/assets/home.html'); await page.waitForSelector('.row .tile');
    ok(await page.locator('#home-weather').isHidden(),'Standard weather hidden');
    ok(await page.locator('.row[data-key="app"] > h2').isVisible(),'Standard row label kept');
    ok(await page.locator('#source').isVisible(),'Standard last source kept');
    ok(await page.locator('#clock').evaluate(e=>getComputedStyle(e).fontSize)==='176px','Standard clock unchanged');
    await page.clock.fastForward(16*60000);await page.waitForTimeout(100);
    ok(requests.length===0&&searches.length===0,'No external calls in Standard');
    await change({view:'alternative'});
    ok(await page.locator('#stage').evaluate(e=>e.classList.contains('alternative')),'Alternative class applied');
    ok(await page.locator('#home-weather').isHidden(),'Weather remains opt-in');
    ok(await page.locator('.row[data-key="app"] > h2').isHidden(),'Alternative row labels hidden');
    ok(await page.locator('#source').isHidden(),'Alternative last source hidden');
    ok(await page.locator('#clock').evaluate(e=>getComputedStyle(e).fontSize)==='100px','Alternative smaller clock');
    let bounds=await page.evaluate(()=>{
      const apps=[...document.querySelectorAll('.row[data-key="app"] .tile')].map(e=>e.getBoundingClientRect());
      return {left:apps[0].left,right:apps[apps.length-1].right,bottom:apps[0].bottom,
        clock:document.getElementById('when').getBoundingClientRect().right, count:apps.length};
    });
    ok(Math.abs((bounds.left+bounds.right)/2-960)<3,'Short app row centred');
    ok(bounds.bottom>950&&bounds.bottom<1080,'App dock anchored at bottom');
    ok(bounds.clock>1800,'Clock right aligned');
    ok(bounds.count===6,'Hidden app still excluded');
    await change({weather:true});
    ok(await page.locator('#home-weather').isVisible(),'Enabled weather shown');
    ok((await page.locator('#home-wx-place').innerText())==='Choose a town','No default personal location');
    await page.clock.fastForward(20000);await page.waitForTimeout(50);
    ok(requests.length===0,'No forecast before location saved');
    await key(406);ok(await page.locator('#home-weather-settings').isVisible(),'Blue opens selector');
    await key(461);ok(await page.locator('#home-weather-settings').isHidden(),'Back closes selector');
    await key(40);await key(38);await key(13);
    ok(await page.locator('#home-weather-settings').isVisible(),'Up then OK reaches weather from dock');
    await page.locator('#home-location-query').fill('Staines');
    ok(searches.length===0,'Typing does not send a query');
    await page.locator('#home-location-search').click();await page.waitForSelector('.home-location-result');
    ok(await page.locator('.home-location-result').count()===2,'Disambiguation choices shown');
    await page.locator('.home-location-result').first().click();await page.locator('#home-location-save').click();
    await page.clock.fastForward(500);await page.waitForFunction(()=>document.getElementById('home-weather').getAttribute('data-weather-state')==='ready');
    ok((await page.locator('#home-wx-place').innerText())===staines.name,'Saved town displayed');
    ok(requests.length===1&&requests[0].includes('latitude=51.434'),'Selected forecast coordinates');
    ok((await page.locator('#home-wx-temp').innerText())==='12\u00b0C','Temperature rendered');
    ok(await page.locator('.wx-day').count()===3,'Three forecast days');
    ok(opens.length===0,'Weather keys never launch a dock tile');
    await page.locator('#home-wx-change').click();await search('Paris');await page.locator('.home-location-result').first().click();
    await page.locator('#home-location-cancel').click();
    ok((await page.locator('#home-wx-place').innerText())===staines.name&&requests.length===1,'Cancel preserves saved town');
    await page.locator('#home-wx-change').click();await search('Paris');await page.locator('.home-location-result').first().click();
    await page.locator('#home-location-save').click();await page.clock.fastForward(500);
    await page.waitForFunction(()=>document.getElementById('home-wx-temp').textContent==='18\u00b0C');
    ok((await page.locator('#home-wx-place').innerText())==='Paris','Location switch');
    ok(requests[requests.length-1].includes('Europe%2FParis'),'Forecast timezone changes');
    await page.reload();await page.waitForSelector('.row .tile');
    ok((await page.locator('#home-wx-place').innerText())==='Paris','Selected location survives reload');
    await page.locator('#home-wx-change').click(); searchMode='empty';
    await page.locator('#home-location-query').fill('zzzzz');await page.locator('#home-location-search').click();
    await page.waitForFunction(()=>document.getElementById('home-location-status').textContent.indexOf('No matching')===0);
    ok(await page.locator('#home-location-save').isDisabled(),'No-result search cannot overwrite location');
    searchMode='error';await page.locator('#home-location-query').fill('York');await page.locator('#home-location-search').click();
    await page.waitForFunction(()=>document.getElementById('home-location-status').getAttribute('data-error')==='1');
    ok((await page.locator('#home-wx-place').innerText())==='Paris','Failed search preserves town');
    await page.locator('#home-location-cancel').click();searchMode='ok';
    // Re-entering Standard must abort/stop all weather activity without dropping its preference.
    const beforeOff=requests.length;
    await change({view:'standard'});await page.clock.fastForward(20*60000);await page.waitForTimeout(100);
    ok(await page.locator('#home-weather').isHidden(),'Weather hidden on Standard');
    ok(requests.length===beforeOff,'Standard stops forecast timers');
    ok(await page.locator('#clock').evaluate(e=>getComputedStyle(e).fontSize)==='176px','Stock geometry restored');
    ok(await page.locator('#source').isVisible(),'Stock source panel restored');
    ok(await page.locator('.row[data-key="app"] > h2').isVisible(),'Stock row headings restored');
    ok(await page.locator('.row[data-key="app"] .track').evaluate(e=>e.style.justifyContent)==='','Stock row scroll alignment restored');
    await change({view:'alternative',weather:false});
    await key(406);ok(await page.locator('#home-weather-settings').isHidden(),'Disabled weather shortcut inactive');
    // Colour defaults and user accents must match upstream, including colours that coincide.
    for(const accent of [null,'#ece7df','#e9ad55','#b9a6ff']){
      await change({colours:accent?{text:'#d4e6f4',accent}:null});
      const expected=accent||'#ece7df';
      const rgb='rgb('+expected.slice(1).match(/../g).map(x=>parseInt(x,16)).join(', ')+')';
      ok(await page.locator('.row .tile.focus').evaluate(e=>getComputedStyle(e).outlineColor)===rgb,'Alternative respects focus colour '+expected);
    }
    await page.keyboard.down('Enter');await page.clock.fastForward(900);await page.keyboard.up('Enter');
    ok(await page.locator('#stage').evaluate(e=>e.classList.contains('arranging')),'Arrange still reachable');
    ok(await page.locator('.row[data-key="app"] > h2').isVisible(),'Sorting headings return in Arrange');
    ok(await page.locator('.row[data-key="app"] .tile').count()===7,'Hidden tile shown only while arranging');
    await key(461);await page.waitForTimeout(100);
    ok(await page.locator('.row[data-key="app"] .tile').count()===6,'Leaving Arrange re-hides it');
    // Restore weather, then switch off while a forecast response is outstanding.
    forecastMode='hold';await change({view:'alternative',weather:true});await page.clock.fastForward(3000);await page.waitForTimeout(100);
    ok(!!heldForecast,'Forecast fixture held in flight');
    await change({weather:false});
    if(heldForecast){try{await fulfill(heldForecast,model(48));}catch(e){}heldForecast=null;}
    await page.waitForTimeout(50);
    ok(await page.locator('#home-weather').isHidden(),'Late response cannot re-enable weather');
    extraApps = Array.from({length:14},(_,i)=>({id:'more-'+i,title:'More '+i}));
    await change({weather:false});
    await page.locator('.row[data-key="app"] .tile').first().hover();
    for(let i=0;i<25;i++) await page.keyboard.press('ArrowRight');
    await page.clock.runFor(900);
    const scrolling = await page.evaluate(()=>{
      const row=document.querySelector('.row[data-key="app"]');
      const tile=row.querySelector('.tile.focus').getBoundingClientRect(), wrap=row.querySelector('.wrap').getBoundingClientRect();
      return {left:tile.left,right:tile.right,wrapLeft:wrap.left,wrapRight:wrap.right,justify:row.querySelector('.track').style.justifyContent};
    });
    ok(scrolling.justify==='','Overflowing Alternative row is not forcibly centred');
    ok(scrolling.left>=scrolling.wrapLeft&&scrolling.right<=scrolling.wrapRight,'Overflow focus remains visible');
    extraApps=[];await change({weather:false});
    ok(await page.locator('.row[data-key="app"] .track').evaluate(e=>e.style.justifyContent)==='center','Short row recentres after catalogue change');
    ok(errors.length===0,'No page errors: '+errors.join('; '));
    console.log('Alternative View: '+assertions+' browser assertions passed (mock weather).');
  } catch(e) { problems.push('Alternative View: '+e.message); }
  finally{await page.close();}
  await checkHomeViewControls(browser, base, problems);
};


async function checkHomeViewControls(browser, base, problems) {
  const page = await browser.newPage({viewport:{width:1400,height:1000}});
  let writable = true;
  const layout = {rows:['dev','app','ch'],order:{app:[],dev:[],ch:[]},sort:{app:'custom',dev:'custom',ch:'custom'},
    hidden:{app:['hidden-app'],dev:[],ch:[]},channels:[],hintSeen:true,view:'standard',weather:false};
  const saves = [], external = [];
  page.on('pageerror', e => problems.push('Home appearance editor: '+e.message));
  await page.route('https://*.open-meteo.com/**', route => {external.push(route.request().url());return route.abort();});
  await page.route('**/api/home**', route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {ok:true};
    if(pathname==='/api/home') body={ok:true,supported:{ok:true},enabled:true,active:true,writable,layout,history:true};
    if(pathname==='/api/home/catalogue') body={ok:true,layout,apps:[{id:'one',title:'One'}],devices:[],channels:[],sources:{channels:0},order:{app:['one','lg-home'],dev:[],ch:[]}};
    if(pathname==='/api/home/layout') {
      const patch=route.request().postDataJSON();saves.push(patch);
      if(patch.view!==undefined)layout.view=patch.view;
      if(patch.weather!==undefined)layout.weather=patch.weather;
      body={ok:true,layout};
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  const ready=()=>page.waitForSelector('#home-view:not(:disabled)');
  try {
    await page.goto(base+'/?tab=home');await ready();
    assert.strictEqual(await page.locator('#home-view').inputValue(),'standard');
    assert.ok(await page.locator('#home-weather-row').isHidden());
    await page.locator('#home-view').selectOption('alternative');await ready();
    assert.strictEqual(layout.view,'alternative');
    assert.ok(await page.locator('#home-weather-row').isVisible());
    assert.strictEqual(layout.weather,false);
    await page.locator('#home-weather-enabled').click();await ready();
    assert.strictEqual(layout.weather,true);
    await page.locator('#home-view').selectOption('standard');await ready();
    assert.strictEqual(layout.view,'standard');
    assert.strictEqual(layout.weather,true);
    assert.ok(await page.locator('#home-weather-row').isHidden());
    assert.deepStrictEqual(layout.rows,['dev','app','ch']);
    assert.deepStrictEqual(layout.hidden.app,['hidden-app']);
    assert.deepStrictEqual(saves,[{view:'alternative'},{weather:true},{view:'standard'}]);
    assert.strictEqual(external.length,0,'dashboard never contacts weather providers');
    writable=false;await page.reload();await page.waitForSelector('#home-view');
    assert.ok(await page.locator('#home-view').isDisabled());
    console.log('Home appearance editor: 14 browser assertions passed.');
  } catch(e) {problems.push('Home appearance editor: '+e.message);}
  finally {await page.close();}
}
