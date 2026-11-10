# Browser-only fixtures: API requests are intercepted; no live account is changed.
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base=os.environ.get('MINIAPP_TEST_URL','http://127.0.0.1:8787').rstrip('/')
artifacts=Path(os.environ.get('MINIAPP_TEST_ARTIFACTS','/tmp/coc-miniapp-browser'))
artifacts.mkdir(parents=True,exist_ok=True)
state={'user':{'firstName':'Николай'},'linked':True,'syncEnabled':True,'tagPreview':'Boze_menUA','player':{'name':'Boze_menUA','tag':'#G0VYC2RQ8','townHallLevel':13,'trophies':2840,'expLevel':163,'clan':{'name':'Мегаполис'}},'groups':[{'clan_name':'Мегаполис','outcome':'ok','checked_at':1794344200}],'notice':None}
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('https://telegram.org/js/telegram-web-app.js',lambda route:route.fulfill(content_type='text/javascript',body="window.Telegram={WebApp:{initData:'browser-fixture',ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},setBottomBarColor(){}}};"))
 requests=[]
 def api(route):
  path=route.request.url.split('/api/')[1]
  requests.append(path)
  if path=='settings':state['syncEnabled']=route.request.post_data_json['syncEnabled']
  elif path=='unlink':state['linked']=False;state['player']=None;state['groups']=[]
  elif path=='link':
   state.update({'linked':True,'syncEnabled':True,'player':{'name':'Boze_menUA','tag':'#G0VYC2RQ8','townHallLevel':13,'expLevel':163,'trophies':2840,'clan':{'name':'Мегаполис'}},'result':{'updated':1}})
  route.fulfill(content_type='application/json',body=json.dumps(state))
 page.route('**/api/**',api)
 page.goto(base+'/app/')
 page.locator('#player-name').wait_for(state='visible')
 assert page.locator('#player-name').inner_text()=='Boze_menUA'
 assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
 page.screenshot(path=str(artifacts/'miniapp-profile.png'),full_page=True)
 page.locator('[data-tab="sync"]').click()
 assert page.get_by_text('Тег соответствует игровому нику').is_visible()
 assert not page.locator('button').filter(has_text='Обновить всех').count()
 page.screenshot(path=str(artifacts/'miniapp-sync.png'),full_page=True)
 page.locator('[data-tab="settings"]').click()
 page.locator('#sync-toggle').uncheck()
 expect(page.locator("#summary-status")).to_have_text("Синхронизация на паузе")
 assert not page.locator('#sync-toggle').is_checked()
 page.screenshot(path=str(artifacts/'miniapp-settings.png'),full_page=True)
 page.locator('#unlink').click();page.locator('#cancel-unlink').click()
 assert page.locator('#linked-content').is_visible()
 page.locator('#unlink').click();page.locator('#confirm-unlink').click()
 page.locator('#onboarding').wait_for(state='visible')
 page.screenshot(path=str(artifacts/'miniapp-onboarding.png'),full_page=True)
 page.locator('#player-tag').fill('#G0VYC2RQ8')
 page.locator('#link-form button').click()
 page.locator('#player-name').wait_for(state='visible')
 assert page.locator('#sync-toggle').is_checked()
 assert 'sync' not in requests
 # Hostile names are text, never HTML.
 state['player']['name']='<img src=x onerror=alert(1)>'
 page.locator('#refresh-profile').click()
 expect(page.locator("#player-name")).to_have_text("<img src=x onerror=alert(1)>")
 assert page.locator('#player-name img').count()==0
 assert not errors, errors
 guest=browser.new_page(viewport={'width':320,'height':700})
 guest.route('https://telegram.org/js/telegram-web-app.js',lambda route:route.fulfill(content_type='text/javascript',body=''))
 guest.goto(base+'/app/')
 guest.locator('#gate').wait_for(state='visible')
 assert guest.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
 assert not guest.locator('#content').is_visible()
 browser.close()
 print('Browser checks passed: mobile layout, profile, navigation, settings, confirmed unlink, relink, no member force-sync, XSS-safe names, Telegram-only entry.')
