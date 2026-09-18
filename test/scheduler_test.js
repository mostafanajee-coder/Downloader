'use strict';
// Main-process scheduler: driven with an injected clock so nothing waits for
// wall time. Covers firing, days-of-week, once-per-day, completion actions
// with the cancellable countdown, and the traffic quota.
const path = require('path');
const EventEmitter = require('events');
const ROOT = path.join(__dirname, '..');
const { ScheduleManager, normalizeTime } = require(path.join(ROOT, 'core', 'scheduler'));
const { PowerManager } = require(path.join(ROOT, 'core', 'powerManager'));

let fails = 0;
const check = (n, c, d) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`);
  if (!c) fails++;
};
const section = (t) => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 54 - t.length))}`);

// A Manager stand-in exposing exactly what the scheduler touches.
function fakeManager() {
  const m = new EventEmitter();
  m.items = new Map();
  m.calls = [];
  m.startQueue = (q) => m.calls.push(['start', q]);
  m.stopQueue = (q) => m.calls.push(['stop', q]);
  return m;
}
function fakeConfig(schedule) {
  const store = { schedule };
  return { get: (k) => store[k], set: (k, v) => { store[k] = v; }, getAll: () => store };
}
// Local-time helper: build a timestamp for a given weekday/hour/minute.
function at(day, hh, mm) {
  const d = new Date(2026, 8, 13 + day, hh, mm, 5); // 2026-09-13 is a Sunday
  return d.getTime();
}

(async () => {
  section('time normalisation');
  check('pads single-digit hours', normalizeTime('7:05') === '07:05');
  check('rejects out-of-range', normalizeTime('25:00') === null && normalizeTime('12:60') === null);
  check('rejects garbage', normalizeTime('noon') === null && normalizeTime('') === null);

  section('start / stop fire at the scheduled minute, once per day');
  {
    let now = at(1, 8, 59); // Monday 08:59
    const m = fakeManager();
    const s = new ScheduleManager({ manager: m, config: fakeConfig({ enabled: true, startTime: '09:00', stopTime: '17:30', queueId: 'main' }), now: () => now });
    s.stop(); // drive ticks manually
    s.tick();
    check('nothing fires before the minute', m.calls.length === 0, m.calls);
    now = at(1, 9, 0);
    s.tick(); s.tick(); s.tick();
    check('start fires exactly once inside the minute', m.calls.filter((c) => c[0] === 'start').length === 1, m.calls);
    check('start targets the configured queue', m.calls[0][1] === 'main');
    now = at(1, 17, 30);
    s.tick();
    check('stop fires at its minute', m.calls.some((c) => c[0] === 'stop'), m.calls);
    now = at(2, 9, 0); // Tuesday
    s.tick();
    check('start fires again on the next day', m.calls.filter((c) => c[0] === 'start').length === 2, m.calls);
    s.destroy();
  }

  section('days of week are honoured');
  {
    let now = at(6, 9, 0); // Saturday
    const m = fakeManager();
    const s = new ScheduleManager({ manager: m, config: fakeConfig({ enabled: true, startTime: '09:00', days: [1, 2, 3, 4, 5] }), now: () => now });
    s.stop();
    s.tick();
    check('a weekday-only schedule does not fire on Saturday', m.calls.length === 0, m.calls);
    now = at(1, 9, 0);
    s.tick();
    check('but does on Monday', m.calls.length === 1);
    s.destroy();
  }

  section('disabled schedule never fires; enabling via config starts it');
  {
    let now = at(1, 9, 0);
    const m = fakeManager();
    const cfg = fakeConfig({ enabled: false, startTime: '09:00' });
    const s = new ScheduleManager({ manager: m, config: cfg, now: () => now });
    check('timer not running when disabled', s.describe().timerRunning === false);
    s.tick();
    check('no calls while disabled', m.calls.length === 0);
    cfg.set('schedule', { enabled: true, startTime: '09:00' });
    s.update();
    check('update() starts the timer', s.describe().timerRunning === true);
    check('and fires immediately if we are inside the minute', m.calls.length === 1, m.calls);
    s.destroy();
  }

  section('completion action: countdown, cancel, and fire');
  {
    let now = at(1, 9, 0);
    const m = fakeManager();
    const performed = [];
    const power = new PowerManager({ platform: 'win32', run: (cmd, cb) => { performed.push(cmd); cb && cb(null); } });
    const s = new ScheduleManager({ manager: m, config: fakeConfig({ enabled: true, startTime: '09:00', onComplete: 'shutdown' }), power, now: () => now });
    s.stop();
    const events = [];
    s.on('completion-action', (e) => events.push(['armed', e.action]));
    s.on('completion-action-cancelled', () => events.push(['cancelled']));

    // Queue has one running item; scheduler fires start.
    m.items.set('a', { id: 'a', queueId: 'main', status: 'running' });
    s.tick();
    m.emit('updated', { id: 'a', status: 'running', progress: { downloaded: 100 } });
    check('nothing is armed while something is still running', events.length === 0);

    m.items.get('a').status = 'completed';
    m.emit('updated', { id: 'a', status: 'completed', progress: { downloaded: 200 } });
    check('queue draining after a scheduled start arms the action', events[0] && events[0][0] === 'armed' && events[0][1] === 'shutdown', events);
    check('the action is NOT performed immediately (countdown first)', performed.length === 0);
    check('describe() reports the pending action', s.describe().pendingAction === 'shutdown');

    check('cancelPendingAction() stops it', s.cancelPendingAction() === true && events.some((e) => e[0] === 'cancelled'));
    check('after cancel nothing was ever run', performed.length === 0);
    check('a second cancel is a harmless no-op', s.cancelPendingAction() === false);
    s.destroy();
  }
  {
    // The action must not arm if the user stopped the queue by hand.
    let now = at(1, 9, 0);
    const m = fakeManager();
    const s = new ScheduleManager({ manager: m, config: fakeConfig({ enabled: true, startTime: '09:00', onComplete: 'exit' }), now: () => now });
    s.stop();
    let armed = 0;
    s.on('completion-action', () => armed++);
    m.items.set('a', { id: 'a', queueId: 'main', status: 'running' });
    s.tick();
    m.emit('queue-state', { queueId: 'main', queueRunning: false }); // manual Stop Queue
    m.items.get('a').status = 'paused';
    m.emit('updated', { id: 'a', status: 'paused' });
    check('a manual queue stop disarms the completion action', armed === 0);
    s.destroy();
  }
  {
    // PowerManager routes actions correctly and never runs anything for 'none'.
    const ran = [];
    let exited = false;
    const p = new PowerManager({ platform: 'win32', run: (cmd, cb) => { ran.push(cmd); cb(null); }, exitApp: () => { exited = true; } });
    p.perform('exit');
    check("'exit' calls the injected app quit", exited && ran.length === 0);
    p.perform('shutdown');
    check("'shutdown' issues a delayed Windows shutdown", /^shutdown \/s /.test(ran[0]), ran[0]);
    p.perform('hibernate');
    check("'hibernate' uses shutdown /h", ran[1] === 'shutdown /h');
    p.perform('sleep');
    check("'sleep' uses SetSuspendState", /SetSuspendState/.test(ran[2]));
    check("'none' does nothing", p.perform('none') === false && ran.length === 3);
    p.cancelShutdown();
    check('cancelShutdown aborts the pending Windows shutdown', ran[3] === 'shutdown /a');
  }

  section('traffic quota stops every queue and reports');
  {
    let now = at(1, 10, 0);
    const m = fakeManager();
    const s = new ScheduleManager({ manager: m, config: fakeConfig({ enabled: true, quota: { enabled: true, mb: 1, hours: 1 } }), now: () => now });
    s.stop();
    const tripped = [];
    s.on('quota-exceeded', (e) => tripped.push(e));
    m.emit('updated', { id: 'x', status: 'running', progress: { downloaded: 600 * 1024 } });
    check('under the quota nothing happens', tripped.length === 0 && m.calls.length === 0);
    m.emit('updated', { id: 'x', status: 'running', progress: { downloaded: 1100 * 1024 } });
    check('crossing the quota trips once', tripped.length === 1, tripped[0]);
    check('and stops ALL queues (no queue argument)', m.calls.some((c) => c[0] === 'stop' && c[1] === undefined), m.calls);
    m.emit('updated', { id: 'x', status: 'running', progress: { downloaded: 2000 * 1024 } });
    check('it does not re-trip on further traffic', tripped.length === 1);

    // The window slides: an hour later the old traffic no longer counts.
    now += 61 * 60 * 1000;
    s.update(); // resets the trip flag as a config refresh would
    check('bytes outside the window are forgotten', s.bytesInWindow() === 0, s.bytesInWindow());
    s.destroy();
  }

  console.log(`\n${fails === 0 ? 'ALL SCHEDULER TESTS PASSED' : fails + ' TEST(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
