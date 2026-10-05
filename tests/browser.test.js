// Optional browser verification. PLAYWRIGHT_MODULE can point at an installed Playwright entry.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const modulePath = process.env.PLAYWRIGHT_MODULE || process.argv.find(arg => arg.endsWith('/index.mjs')) || 'playwright';
const { chromium } = await import(modulePath);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width:1440,height:1100 }, reducedMotion:'reduce', acceptDownloads:true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const url = process.env.ROBOTPILOT_URL || 'http://127.0.0.1:8080';
const report = message => console.log('PASS ' + message);
async function captureScreenshots() {
  const directory = fileURLToPath(new URL('../assets/screenshots/', import.meta.url));
  await mkdir(directory, { recursive:true });
  const shot = async (name, locator = null) => {
    await page.waitForTimeout(250);
    if (locator) await page.locator(locator).screenshot({path:directory+'/'+name+'.png'});
    else await page.screenshot({path:directory+'/'+name+'.png',fullPage:true});
    console.log('SCREENSHOT '+name);
  };
  await page.goto(url);
  await shot('Welcome','#welcome');
  await page.locator('#startExploring').click();
  await page.keyboard.down('w');await page.waitForTimeout(900);await page.keyboard.up('w');
  await page.locator('#stopBtn').click();
  await shot('Dashboard');
  await shot('SensorView','.sensor-panel');
  await shot('RobotVision','.camera-panel');
  await page.locator('#newMissionBtn').click();
  const box=await page.locator('#stage').boundingBox();
  await page.locator('#stage').click({position:{x:box.width*.3,y:box.height*.5}});
  await page.locator('#stage').click({position:{x:box.width*.7,y:box.height*.35}});
  await shot('LiveMap');
  await page.locator('#saveWaypoints').click();
  await page.locator('#missionName').fill('Morning exploration');
  await shot('AddMission','#missionDialog');
  await page.locator('#missionForm button[type=submit]').click();
  await page.locator('[data-nav=missions]').click();await shot('Missions');
  await page.locator('[data-nav=drive]').click();await shot('DriveControl');
  await page.locator('#estopBtn').click();await shot('EmergencyStop');
  await page.locator('#estopBtn').click();await shot('ReleaseStop','#resetDialog');
  await page.locator('#confirmReset').click();
  await page.locator('[data-nav=logs]').click();await shot('Activity');
  await page.locator('#settingsBtn').click();await shot('ConnectionSettings','#settings');
  await page.locator('[data-settings-tab=driving]').click();await shot('DrivingSafety','#settings');
  await page.locator('[data-settings-tab=appearance]').click();await shot('AppearanceSettings','#settings');
  await page.locator('[data-close=settings]').first().click();
  await page.locator('[data-nav=dashboard]').click();
  await page.locator('#themeBtn').click();await shot('LightTheme');
  await page.locator('#themeBtn').click();
  await page.setViewportSize({width:390,height:844});await shot('MobileDashboard');
  await page.locator('[data-nav=drive]').click();
  await page.locator('.controls').screenshot({path:directory+'/MobileDriveControl.png'});
  await page.locator('[data-nav=missions]').click();await shot('MobileMissions');
  assert.deepEqual(errors,[]);
}
if (process.argv.includes('--screenshots')) {
  try { await captureScreenshots(); } finally { await browser.close(); }
  process.exit(0);
}
try {
  await page.goto(url);
  await page.locator('#startExploring').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#tBattery').textContent(),'92');
  assert.ok((await page.locator('#nearestObstacle').textContent()).includes('m'));
  assert.equal(await page.locator('.nav-item.active').textContent(),'Overview');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/robotpilot-desktop.png',fullPage:true});
  report('dashboard renders telemetry, scanner, chart, and map without runtime errors');
  const clockStart = new Date();
  await page.clock.install({time:clockStart});
  await page.clock.pauseAt(new Date(clockStart.getTime()+1000));
  await page.keyboard.down('w');
  await page.clock.runFor(1500);
  await page.keyboard.up('w');
  await page.clock.runFor(500);
  assert.ok(Number(await page.locator('#tDistance').textContent())>.3);
  await page.locator('#estopBtn').click();
  await page.clock.runFor(100);
  assert.equal(await page.locator('#tSpeed').textContent(),'0.00');
  await page.keyboard.down('w');await page.clock.runFor(300);await page.keyboard.up('w');
  assert.equal(await page.locator('#tSpeed').textContent(),'0.00');
  await page.locator('#estopBtn').click();
  assert.ok(await page.locator('#resetDialog').isVisible());
  await page.locator('#confirmReset').click();
  await page.clock.runFor(100);
  report('keyboard drives; emergency stop brakes immediately and requires deliberate reset');
  await page.locator('#homeBtn').click();
  await page.clock.runFor(25000);
  assert.ok((await page.locator('#log').textContent()).includes('Docked.'));
  assert.ok(await page.locator('#chargingBadge').isVisible());
  report('obstacle-aware docking completes and battery charges');
  await page.locator('#newMissionBtn').click();
  await page.clock.runFor(100);
  const canvas = await page.locator('#stage').boundingBox();
  await page.locator('#stage').click({position:{x:canvas.width*.27,y:canvas.height*.55}});
  assert.equal(await page.locator('#waypointCount').textContent(),'1 waypoint');
  await page.locator('#saveWaypoints').click();
  await page.locator('#missionName').fill('Browser test route');
  await page.locator('#missionForm button[type=submit]').click();
  await page.locator('[data-nav=missions]').click();
  assert.ok((await page.locator('#missionLibrary').textContent()).includes('Browser test route'));
  await page.reload();await page.clock.runFor(300);
  assert.ok((await page.locator('#missionLibrary').textContent()).includes('Browser test route'));
  report('map waypoints save to the mission library and survive reload');
  await page.locator('[data-nav=dashboard]').click();
  await page.locator('[data-preset=patrol]').click();
  await page.clock.runFor(180000);
  const activity = await page.locator('#log').textContent();
  assert.ok(activity.includes('Mission complete: Arena patrol'),activity);
  assert.ok(!activity.includes('Mission stopped: no progress'),activity);
  report('full arena patrol completes without getting stuck');
  await page.locator('#recordBtn').click();
  await page.keyboard.down('w');await page.clock.runFor(2000);await page.keyboard.up('w');
  await page.locator('#recordBtn').click();
  assert.ok(await page.locator('#missionDialog').isVisible());
  await page.locator('#missionName').fill('Recorded drive');
  await page.locator('#missionForm button[type=submit]').click();
  report('manual drives can be recorded and saved for replay');
  await page.locator('#themeBtn').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await page.locator('#themeBtn').click();
  await page.locator('[data-nav=logs]').click();await page.clock.runFor(500);
  await page.locator('#logSearch').fill('Mission complete');
  assert.ok((await page.locator('#log').textContent()).includes('Mission complete'));
  assert.ok((await page.locator('#sessionHistory tr').count())>=1);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#exportTelemetryBtn').click();
  assert.equal((await downloadEvent).suggestedFilename(),'robotpilot-telemetry.csv');
  report('themes, log filtering, session history, and CSV export work');
  await page.locator('[data-nav=dashboard]').click();
  await page.setViewportSize({width:390,height:844});await page.clock.runFor(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'/tmp/robotpilot-mobile.png',fullPage:true});
  for (const tab of ['map','drive','missions','logs']) {
    await page.locator('[data-nav='+tab+']').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,tab+' overflows');
  }
  report('390px mobile layouts fit all navigation views');
  assert.deepEqual(errors,[]);
  const remote = await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  await remote.addInitScript(() => {
    localStorage.setItem('robotpilot.cfg',JSON.stringify({mode:'ws'}));
    localStorage.setItem('robotpilot.welcomed','true');
    window.sentMessages = [];
    class MockSocket {
      static OPEN=1;static CLOSED=3;static CONNECTING=0;
      constructor(){this.readyState=0;window.robotSocket=this;setTimeout(()=>{this.readyState=1;this.onopen?.();},30);}
      send(value){window.sentMessages.push(JSON.parse(value));}
      close(){this.readyState=3;this.onclose?.();}
      receive(topic,msg){this.onmessage?.({data:JSON.stringify({op:'publish',topic,msg})});}
    }
    window.WebSocket=MockSocket;
  });
  const rp=await remote.newPage();rp.on('pageerror',e=>errors.push(e.message));await rp.goto(url);await rp.waitForTimeout(200);
  assert.ok((await rp.locator('#estopBtn').getAttribute('class')).includes('latched'));
  await rp.evaluate(()=>{
    window.sendOdom=()=>window.robotSocket.receive('/odom',{pose:{pose:{position:{x:1,y:2},orientation:{x:0,y:0,z:0,w:1}}},twist:{twist:{linear:{x:0},angular:{z:0}}}});
    window.sendOdom();window.odomTimer=setInterval(window.sendOdom,100);
  });
  await rp.locator('#estopBtn').click();await rp.locator('#confirmReset').click();
  await rp.keyboard.down('w');await rp.waitForTimeout(400);await rp.keyboard.up('w');
  assert.ok(await rp.evaluate(()=>window.sentMessages.some(m=>m.op==='publish'&&m.msg.linear.x>0)));
  await rp.evaluate(()=>window.robotSocket.receive('/odom',{pose:{}}));
  assert.deepEqual(errors,[]);
  await rp.evaluate(()=>clearInterval(window.odomTimer));await rp.waitForTimeout(2300);
  assert.ok((await rp.locator('#safetyBanner').textContent()).includes('stale'));
  assert.equal(await rp.evaluate(()=>window.sentMessages.filter(m=>m.op==='publish').at(-1).msg.linear.x),0);
  report('robot starts locked, accepts validated odometry, rejects malformed data, and stops on timeout');
  await rp.evaluate(()=>window.robotSocket.close());await rp.waitForTimeout(1200);
  assert.ok((await rp.locator('#estopBtn').getAttribute('class')).includes('latched'));
  assert.equal(await rp.evaluate(()=>window.sentMessages.filter(m=>m.op==='publish').at(-1).msg.linear.x),0);
  report('connection loss and reconnect keep controls locked and send zero velocity');
  await remote.close();
  await page.locator('[data-nav=dashboard]').click();
  await page.clock.resume();await page.evaluate(()=>navigator.serviceWorker.ready);
  await context.setOffline(true);await page.reload();await page.waitForTimeout(300);
  assert.ok(await page.locator('#stage').isVisible());
  assert.equal(await page.locator('#networkState').textContent(),'Offline · cached workspace');
  report('service worker reloads the workspace offline');
  assert.deepEqual(errors,[]);
} finally {
  await browser.close();
}
