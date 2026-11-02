// All contact with the outside world: pings, sockets and HTTPS. What differs per OS lives in windows.js and linux.js.

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { printable, run } from './shared.js';
import { beginProbe, finishProbe, logEvent, recordPulse } from './stats.js';

const platform = await import(process.platform === 'win32' ? './windows.js' : './linux.js');

const PROBE_TIMEOUT_MS = 2000;
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const PULSE_BYTES = 250000;
const PULSE_URL = `https://speed.cloudflare.com/__down?bytes=${PULSE_BYTES}`;
const PULSE_TIMEOUT_MS = 8000;
const CARRIER_URL = 'https://ipinfo.io/json';
const TLS_OVERHEAD_BYTES = 6000;

export function parsePingReply(stdout) {
  const replyLine = stdout.split(/\r?\n/).find($_ => /ttl=/i.test($_));
  if (!replyLine) return null;
  const match = replyLine.match(/([=<])\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (!match) return null;
  return match[1] === '<' ? 0.5 : Number(match[2]);
}

export function parseTrace(body) {
  const field = name => body.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? null;
  return { ip: field('ip'), edge: field('colo') };
}

export function parseCarrier(body) {
  const parsed = JSON.parse(body);
  const place = [parsed.city, parsed.country].filter(Boolean).join(' ');
  return {
    carrier: parsed.org ? printable(parsed.org.replace(/^AS\d+\s+/, '')) : null,
    place: place ? printable(place) : null,
  };
}

function fetchUrl(url, { timeoutMs, onFirstByte }) {
  return new Promise(resolve => {
    let settled = false;
    let bytes = 0;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ bytes, ...result });
    };
    const request = https.get(url, { agent: false, headers: { 'User-Agent': 'netxray' } }, response => {
      onFirstByte?.();
      const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes < 65536) chunks.push(chunk); });
      response.on('end', () => finish({ ok: true, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish({ ok: false }));
    });
    const timer = setTimeout(() => { request.destroy(); finish({ ok: false, timedOut: true }); }, timeoutMs);
    request.on('error', () => finish({ ok: false }));
  });
}

export function startProbes(state) {
  const timers = [];
  const every = (ms, task) => timers.push(setInterval(task, ms));
  let carrierPending = false;
  let pingMissingLogged = false;

  async function ping(key, target) {
    if (!target) return;
    const probe = beginProbe(state, key, Date.now());
    const { file, args } = platform.pingCommand(target, PROBE_TIMEOUT_MS);
    const { stdout, error } = await run(file, args, PROBE_TIMEOUT_MS + 2000);
    if (error?.code === 'ENOENT' && !pingMissingLogged) {
      pingMissingLogged = true;
      logEvent(state, 'bad', 'ping is not installed, so ping results mean nothing', Date.now());
    }
    finishProbe(state, probe, parsePingReply(stdout), Date.now());
  }

  function probeTcp() {
    const probe = beginProbe(state, 'tcp', Date.now());
    const startedAt = performance.now();
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    let done = false;
    const finish = rtt => {
      if (done) return;
      done = true;
      socket.destroy();
      finishProbe(state, probe, rtt, Date.now());
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    socket.once('connect', () => finish(performance.now() - startedAt));
    socket.once('error', () => finish(null));
  }

  // A fresh name every time, so the answer has to travel past any cache. "No such name" is still an answer.
  // A fresh resolver too: one keeps the DNS servers it found when created, which are dead after a network switch.
  async function probeDns() {
    const probe = beginProbe(state, 'dns', Date.now());
    const startedAt = performance.now();
    const name = `nx${Math.random().toString(36).slice(2, 12)}.example.com`;
    const resolver = new dns.promises.Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 1 });
    let rtt = null;
    try {
      await resolver.resolve4(name);
      rtt = performance.now() - startedAt;
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') rtt = performance.now() - startedAt;
    }
    finishProbe(state, probe, rtt, Date.now());
  }

  async function probeHttps() {
    const probe = beginProbe(state, 'https', Date.now());
    const startedAt = performance.now();
    let firstByteMs = null;
    const result = await fetchUrl(TRACE_URL, {
      timeoutMs: 5000,
      onFirstByte: () => { firstByteMs = performance.now() - startedAt; },
    });
    state.probeBytes += result.bytes + TLS_OVERHEAD_BYTES;
    const answered = result.ok && result.status === 200;
    finishProbe(state, probe, answered ? firstByteMs : null, Date.now());
    if (!answered) return;

    const { ip, edge } = parseTrace(result.body);
    if (edge) state.info.edge = printable(edge);
    if (ip && state.info.publicIp && ip !== state.info.publicIp) {
      logEvent(state, 'warn', 'Public IP changed', Date.now());
      lookUpCarrier();
    }
    if (ip) state.info.publicIp = ip;
  }

  async function pulse() {
    if (!state.pulseEnabled) return;
    const at = Date.now();
    const startedAt = performance.now();
    const result = await fetchUrl(PULSE_URL, { timeoutMs: PULSE_TIMEOUT_MS });
    const seconds = (performance.now() - startedAt) / 1000;
    state.probeBytes += result.bytes + TLS_OVERHEAD_BYTES;

    // The speed server sometimes turns requests away. That says nothing about the line, so it isn't a failure.
    const blocked = result.ok && result.status !== 200;
    const complete = result.ok && result.status === 200 && result.bytes >= PULSE_BYTES;
    recordPulse(state, {
      at,
      blocked,
      ok: complete,
      mbps: !blocked && result.bytes > 0 ? (result.bytes * 8) / seconds / 1e6 : null,
    });
    if (!blocked && !complete) logEvent(state, 'warn', `Download probe failed at ${Math.round(result.bytes / 1000)} kB`, Date.now());
  }

  async function lookUpCarrier() {
    if (carrierPending) return;
    carrierPending = true;
    const result = await fetchUrl(CARRIER_URL, { timeoutMs: 5000 });
    carrierPending = false;
    state.probeBytes += result.bytes + TLS_OVERHEAD_BYTES;
    if (!result.ok || result.status !== 200) return;

    let found;
    try {
      found = parseCarrier(result.body);
    } catch {
      return;
    }
    if (state.info.carrier && found.carrier && found.carrier !== state.info.carrier) {
      logEvent(state, 'warn', `Uplink changed: ${state.info.carrier} → ${found.carrier}`, Date.now());
    }
    state.info.carrier = found.carrier;
    state.info.place = found.place;
  }

  async function checkRoute() {
    const route = await platform.readDefaultRoute();
    const gateway = route?.gateway ?? null;
    const adapter = route?.adapter ?? null;
    const at = Date.now();
    if (state.info.gatewayChecked && gateway !== state.info.gateway) {
      logEvent(state, gateway ? 'warn' : 'bad', gateway ? `Gateway now ${gateway}` : 'Default route gone', at);
    }
    state.info.gatewayChecked = true;
    state.info.gateway = gateway;

    if (state.info.adapter && adapter && adapter !== state.info.adapter) {
      logEvent(state, 'warn', `Adapter now ${printable(adapter)}`, at);
    }
    state.info.adapter = adapter;
  }

  async function checkWifi() {
    if (!state.info.adapter || !state.info.adapterType?.startsWith('Wireless')) {
      state.info.wifi = null;
      return;
    }
    const wifi = await platform.readWifi(state.info.adapter);
    if (wifi?.ssid && state.info.wifi?.ssid && wifi.ssid !== state.info.wifi.ssid) {
      logEvent(state, 'warn', `Wi-Fi now ${wifi.ssid}`, Date.now());
    }
    state.info.wifi = wifi;
  }

  function onCounters({ adapters, tcp }) {
    const at = Date.now();
    if (tcp) state.tcp.feed(at, tcp);
    const active = adapters.find($_ => $_.name === state.info.adapter);
    if (!active) return;
    state.info.adapterType = active.type;
    state.info.linkBps = active.linkBps;
    state.throughput.feed(at, active.name, active.rxBytes, active.txBytes);
  }

  const stopCounters = platform.startCounters(onCounters, text => logEvent(state, 'warn', text, Date.now()));

  checkRoute().then(() => { ping('router', state.info.gateway); });
  lookUpCarrier();
  probeTcp();
  probeDns();
  probeHttps();
  pulse();
  ping('cloudflare', '1.1.1.1');
  ping('google', '8.8.8.8');

  every(500, () => ping('router', state.info.gateway));
  every(500, () => ping('cloudflare', '1.1.1.1'));
  every(500, () => ping('google', '8.8.8.8'));
  every(1000, probeTcp);
  every(2000, probeDns);
  every(3000, probeHttps);
  every(10000, pulse);
  every(5000, () => { checkRoute(); checkWifi(); });
  every(60000, lookUpCarrier);

  return function stop() {
    timers.forEach($_ => clearInterval($_));
    stopCounters();
  };
}
