// A made-up connection that keeps cycling through good and bad spells, to see every state of the screen.

import { beginProbe, finishProbe, logEvent, recordPulse } from './stats.js';

const PHASES = [
  { name: 'calm', seconds: 150, router: 1, internet: 30, spread: 12, loss: 0 },
  { name: 'wobbly', seconds: 60, router: 1, internet: 90, spread: 160, loss: 0.015 },
  { name: 'calm', seconds: 90, router: 1, internet: 28, spread: 10, loss: 0 },
  { name: 'storm', seconds: 45, router: 1, internet: 380, spread: 900, loss: 0.12 },
  { name: 'outage', seconds: 8, router: 1, internet: 40, spread: 10, loss: 1 },
  { name: 'calm', seconds: 120, router: 1, internet: 32, spread: 14, loss: 0 },
  { name: 'lan trouble', seconds: 25, router: 60, internet: 110, spread: 200, loss: 0.08 },
];
const CYCLE_SECONDS = PHASES.reduce((sum, $_) => sum + $_.seconds, 0);

function phaseAt(at) {
  let second = Math.floor(at / 1000) % CYCLE_SECONDS;
  for (const phase of PHASES) {
    if (second < phase.seconds) return phase;
    second -= phase.seconds;
  }
  return PHASES[0];
}

function createRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function createDemo(state, startAt) {
  const random = createRandom(42);
  let probeClock = startAt;
  let tickClock = startAt;
  let pulseClock = startAt;
  let rxBytes = 8e8;
  let txBytes = 1e8;
  const tcp = { sent: 300000, resent: 3000, failed: 100, resets: 800 };

  Object.assign(state.info, {
    adapter: 'Ethernet 5',
    adapterType: 'Ethernet',
    linkBps: 2500000000,
    gateway: '192.168.8.1',
    gatewayChecked: true,
    carrier: 'Demo Mobile Network',
    place: 'Pattaya TH',
    edge: 'BKK',
  });

  function emitPing(key, at, base, spread, loss) {
    const probe = beginProbe(state, key, at);
    const isLost = random() < loss;
    const delay = base + random() * random() * spread;
    finishProbe(state, probe, isLost ? null : Math.round(delay), isLost ? at + 2000 : at + delay);
  }

  function emitApp(key, at, phase, multiplier) {
    const probe = beginProbe(state, key, at);
    const isLost = random() < phase.loss;
    const delay = (phase.internet + random() * phase.spread) * multiplier;
    finishProbe(state, probe, isLost ? null : delay, at + 500);
  }

  function step(at) {
    const phase = phaseAt(at);
    const routerLoss = phase.name === 'lan trouble' ? phase.loss : 0;
    emitPing('router', at, phase.router, phase.router * 3, routerLoss);
    emitPing('cloudflare', at, phase.internet, phase.spread, phase.loss);
    emitPing('google', at, phase.internet + 4, phase.spread, phase.loss);
  }

  function tick(at) {
    const phase = phaseAt(at);
    const health = 1 - Math.min(0.95, phase.loss * 4);
    const wave = 0.5 + 0.5 * Math.sin(at / 9000);
    rxBytes += 1.2e6 * health * wave * random();
    txBytes += 2.4e5 * health * (1 - wave) * random();
    state.throughput.feed(at, state.info.adapter, rxBytes, txBytes);

    tcp.sent += 300;
    tcp.resent += Math.round(300 * phase.loss * random());
    if (phase.loss > 0.1 && random() < 0.3) tcp.failed++;
    state.tcp.feed(at, tcp);

    emitApp('tcp', at, phase, 1);
    if (Math.floor(at / 1000) % 2 === 0) emitApp('dns', at, phase, 1.2);
    if (Math.floor(at / 1000) % 3 === 0) emitApp('https', at, phase, 4);
  }

  function emitPulse(at) {
    const phase = phaseAt(at);
    const failed = random() < phase.loss * 2;
    const mbps = failed ? random() * 0.8 : Math.max(0.5, 12 * (1 - Math.min(0.9, phase.spread / 900)) * (0.7 + random() * 0.3));
    recordPulse(state, { at, blocked: false, ok: !failed, mbps });
    state.probeBytes += 256000;
    if (failed) logEvent(state, 'warn', 'Download probe failed at 96 kB', at);
  }

  return function advanceTo(until) {
    while (probeClock <= until || tickClock <= until || pulseClock <= until) {
      const next = Math.min(probeClock, tickClock, pulseClock);
      if (next === probeClock) { step(probeClock); probeClock += 500; }
      else if (next === tickClock) { tick(tickClock); tickClock += 1000; }
      else { emitPulse(pulseClock); pulseClock += 10000; }
    }
  };
}
