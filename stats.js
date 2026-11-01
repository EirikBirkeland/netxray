// Everything the screen shows is derived here from raw probe results. No I/O, and time is always passed in.

const HISTORY_MS = 60 * 60 * 1000;
const STATS_WINDOW_MS = 60 * 1000;
const HISTOGRAM_WINDOW_MS = 5 * 60 * 1000;
const OUTAGE_STREAK = 3;
const EVENT_THROTTLE_MS = 10 * 1000;
const MAX_EVENTS = 200;

export const ICMP_KEYS = ['router', 'cloudflare', 'google'];
export const INTERNET_KEYS = ['cloudflare', 'google'];
export const APP_KEYS = ['tcp', 'dns', 'https'];

const SERIES_LABELS = {
  router: 'Router',
  cloudflare: 'Cloudflare',
  google: 'Google',
  tcp: 'TCP 443',
  dns: 'DNS',
  https: 'HTTPS',
};

const LOSS_TEXT = {
  router: 'Router packet lost',
  cloudflare: 'Cloudflare packet lost',
  google: 'Google packet lost',
  tcp: 'TCP connect failed',
  dns: 'DNS query failed',
  https: 'HTTPS request failed',
};

const HEALTH_LIMITS = {
  router: { warnMs: 30, badMs: 150 },
  internet: { warnMs: 200, badMs: 800 },
  cloudflare: { warnMs: 200, badMs: 800 },
  google: { warnMs: 200, badMs: 800 },
  tcp: { warnMs: 300, badMs: 1000 },
  dns: { warnMs: 300, badMs: 1000 },
  https: { warnMs: 800, badMs: 2500 },
};

const SPIKE_FLOOR_MS = { router: 100, cloudflare: 300, google: 300 };

export const HISTOGRAM_BUCKETS = [
  { label: '<10', below: 10 },
  { label: '<20', below: 20 },
  { label: '<50', below: 50 },
  { label: '<100', below: 100 },
  { label: '<200', below: 200 },
  { label: '<500', below: 500 },
  { label: '<1s', below: 1000 },
  { label: '1s+', below: Infinity },
];

export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil(fraction * sortedValues.length) - 1;
  return sortedValues[Math.max(0, rank)];
}

// One stream of probes. A sample is { at, rtt }: rtt is undefined in flight and null when lost.
export class Series {
  constructor(label) {
    this.label = label;
    this.samples = [];
    this.replies = 0;
    this.lost = 0;
    this.consecutiveLost = 0;
    this.lostStreakStart = null;
    this.lastRtt = null;
  }

  begin(at) {
    const sample = { at, rtt: undefined };
    this.samples.push(sample);
    while (this.samples[0].at < at - HISTORY_MS) this.samples.shift();
    return sample;
  }

  finish(sample, rtt) {
    sample.rtt = rtt;
    if (rtt === null) {
      this.lost++;
      if (this.consecutiveLost === 0) this.lostStreakStart = sample.at;
      this.consecutiveLost++;
      return;
    }
    this.replies++;
    this.consecutiveLost = 0;
    this.lastRtt = rtt;
  }

  completedSince(since) {
    const completed = [];
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].at >= since; i--) {
      if (this.samples[i].rtt !== undefined) completed.push(this.samples[i]);
    }
    return completed.reverse();
  }
}

export function summarize(samples) {
  const rtts = samples.filter($_ => $_.rtt !== null).map($_ => $_.rtt);
  const sorted = [...rtts].sort((a, b) => a - b);
  const jitters = rtts.slice(1).map((rtt, i) => Math.abs(rtt - rtts[i]));
  return {
    count: samples.length,
    lossPct: samples.length ? ((samples.length - rtts.length) / samples.length) * 100 : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    jitter: jitters.length ? jitters.reduce((a, b) => a + b, 0) / jitters.length : null,
  };
}

export function healthOf(summary, { warnMs, badMs }) {
  if (!summary || summary.count === 0) return 'unknown';
  if (summary.lossPct >= 5 || summary.p95 >= badMs) return 'bad';
  if (summary.lossPct >= 1 || summary.p95 >= warnMs) return 'warn'; // one packet in a minute is below this
  return 'good';
}

// 100 is a line with no loss and steady latency. Loss weighs most: 25 % loss alone reaches 0.
export function stabilityScore(lossPct, p50, p95) {
  if (lossPct === null) return null;
  const lossPenalty = Math.min(100, lossPct * 4);
  const spreadPenalty = p50 === null ? 0 : Math.min(40, (p95 - p50) / 15);
  return Math.max(0, Math.round(100 - lossPenalty - spreadPenalty));
}

export function verdictOf(score) {
  if (score === null) return 'MEASURING';
  if (score >= 90) return 'ROCK SOLID';
  if (score >= 70) return 'DECENT';
  if (score >= 40) return 'SHAKY';
  if (score >= 15) return 'BAD';
  return 'BROKEN';
}

export function diagnose({ health, routerIgnoresPings, realTrafficClean, gatewayChecked, hasGateway }) {
  if (gatewayChecked && !hasGateway) return { level: 'bad', text: 'No default route. This PC has no network.' };
  if (health.cloudflare === 'unknown' && health.google === 'unknown') return { level: 'unknown', text: 'Measuring…' };

  const isTroubled = key => health[key] === 'warn' || health[key] === 'bad';
  const worstOf = (...keys) => (keys.some($_ => health[$_] === 'bad') ? 'bad' : 'warn');
  const routerTroubled = isTroubled('router') && !routerIgnoresPings;
  const cloudflareTroubled = isTroubled('cloudflare');
  const googleTroubled = isTroubled('google');

  if (routerTroubled) {
    if (cloudflareTroubled || googleTroubled) {
      return { level: worstOf('router', 'cloudflare', 'google'), text: 'Trouble between this PC and the router.' };
    }
    return { level: 'warn', text: 'Router replies unevenly. Internet still clean.' };
  }
  if (realTrafficClean && (cloudflareTroubled || googleTroubled)) {
    return { level: 'warn', text: 'Only pings suffer. TCP, DNS and HTTPS clean.' };
  }
  if (cloudflareTroubled && googleTroubled) {
    const routerKnownGood = health.router === 'good' && !routerIgnoresPings;
    const text = routerKnownGood ? 'Router clean. Trouble at its uplink or beyond.' : 'Trouble on the way to the internet.';
    return { level: worstOf('cloudflare', 'google'), text };
  }
  if (cloudflareTroubled) return { level: 'warn', text: 'Only Cloudflare is affected so far.' };
  if (googleTroubled) return { level: 'warn', text: 'Only Google is affected so far.' };
  if (isTroubled('dns')) return { level: worstOf('dns'), text: 'Pings clean. DNS failing or slow.' };
  if (isTroubled('tcp')) return { level: worstOf('tcp'), text: 'Pings clean. TCP connections failing or slow.' };
  if (isTroubled('https')) return { level: worstOf('https'), text: 'Pings clean. HTTPS failing or slow.' };
  return { level: 'good', text: 'All layers clean.' };
}

// Rates from the active adapter's byte counters. An adapter switch starts over instead of showing a false spike.
export class Throughput {
  constructor() {
    this.rates = [];
    this.adapter = null;
    this.previous = null;
    this.downBytes = 0;
    this.upBytes = 0;
  }

  feed(at, adapter, rxBytes, txBytes) {
    const previous = this.adapter === adapter ? this.previous : null;
    this.adapter = adapter;
    this.previous = { at, rxBytes, txBytes };
    if (!previous || at <= previous.at) return;

    const seconds = (at - previous.at) / 1000;
    const down = Math.max(0, rxBytes - previous.rxBytes);
    const up = Math.max(0, txBytes - previous.txBytes);
    this.downBytes += down;
    this.upBytes += up;
    this.rates.push({ at, down: (down * 8) / seconds / 1e6, up: (up * 8) / seconds / 1e6 });
    while (this.rates[0].at < at - HISTORY_MS) this.rates.shift();
  }

  // One value per second, oldest first. A second the slightly-late sampler skipped repeats its neighbour.
  perSecond(now, count, field) {
    const bySecond = new Map(this.rates.map($_ => [Math.floor($_.at / 1000), $_[field]]));
    const lastSecond = Math.floor(now / 1000);
    const values = [];
    for (let i = count - 1; i >= 0; i--) {
      const second = lastSecond - i;
      const value = bySecond.get(second) ?? bySecond.get(second - 1) ?? null;
      values.push(value);
    }
    return values;
  }

  latest(field) {
    return this.rates.length ? this.rates[this.rates.length - 1][field] : null;
  }

  peak(field, since) {
    return this.rates.reduce((peak, $_) => ($_.at >= since ? Math.max(peak, $_[field]) : peak), 0);
  }
}

// Machine-wide TCP counters, reduced to what changed inside the last minute.
export class TcpCounters {
  constructor() {
    this.ticks = [];
  }

  feed(at, counters) {
    this.ticks.push({ at, ...counters });
    while (this.ticks[0].at < at - STATS_WINDOW_MS) this.ticks.shift();
  }

  lastMinute() {
    if (this.ticks.length < 2) return null;
    const first = this.ticks[0];
    const last = this.ticks[this.ticks.length - 1];
    const sent = last.sent - first.sent;
    const resent = last.resent - first.resent;
    return {
      sent,
      resent,
      resentPct: sent > 0 ? (resent / sent) * 100 : 0,
      failed: last.failed - first.failed,
      resets: last.resets - first.resets,
    };
  }
}

function freshMeasurements(now) {
  const series = {};
  Object.keys(SERIES_LABELS).forEach($_ => { series[$_] = new Series(SERIES_LABELS[$_]); });
  return {
    startedAt: now,
    series,
    throughput: new Throughput(),
    tcp: new TcpCounters(),
    pulses: [],
    events: [],
    lastTroubleAt: null,
    throttles: new Map(),
    outages: [
      { label: 'Router', keys: ['router'], downSince: null, count: 0, longestMs: 0 },
      { label: 'Internet', keys: INTERNET_KEYS, downSince: null, count: 0, longestMs: 0 },
    ],
  };
}

export function createState(now) {
  return {
    ...freshMeasurements(now),
    pulseEnabled: true,
    probeBytes: 0,
    info: {
      adapter: null,
      adapterType: null,
      linkBps: null,
      gateway: null,
      gatewayChecked: false,
      carrier: null,
      place: null,
      edge: null,
      publicIp: null,
      wifi: null,
    },
  };
}

// Clears what was measured but keeps what is known about the connection.
export function resetMeasurements(state, now) {
  Object.assign(state, freshMeasurements(now));
  logEvent(state, 'info', 'Statistics reset', now);
}

export function logEvent(state, level, text, at) {
  state.events.push({ at, level, text });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

function logThrottled(state, throttleKey, level, text, at) {
  const lastAt = state.throttles.get(throttleKey);
  if (lastAt !== undefined && at - lastAt < EVENT_THROTTLE_MS) return;
  state.throttles.set(throttleKey, at);
  logEvent(state, level, text, at);
}

function noteLoss(state, { key, series }, at) {
  if (key === 'router' && series.replies === 0) return; // a router that never answered is ignoring pings, not failing
  state.lastTroubleAt = at;
  logThrottled(state, `lost:${key}`, 'warn', LOSS_TEXT[key], at);
}

function noteSpike(state, { key, series }, rtt, at) {
  const floor = SPIKE_FLOOR_MS[key];
  if (floor === undefined || rtt < floor) return;
  const recent = summarize(series.completedSince(at - STATS_WINDOW_MS));
  if (recent.count < 10 || rtt < recent.p50 * 4) return;
  state.lastTroubleAt = at;
  logThrottled(state, `spike:${key}`, 'warn', `${series.label} spike: ${Math.round(rtt)} ms`, at);
}

function updateOutages(state, at) {
  state.outages.forEach(outage => {
    const members = outage.keys.map($_ => state.series[$_]);
    const routerNeverAnswered = outage.label === 'Router' && members[0].replies === 0;
    const isDown = !routerNeverAnswered && members.every($_ => $_.consecutiveLost >= OUTAGE_STREAK);

    if (isDown && outage.downSince === null) {
      outage.downSince = Math.min(...members.map($_ => $_.lostStreakStart));
      logEvent(state, 'bad', `${outage.label} down`, at);
    }
    if (!isDown && outage.downSince !== null) {
      const durationMs = at - outage.downSince;
      outage.count++;
      outage.longestMs = Math.max(outage.longestMs, durationMs);
      outage.downSince = null;
      logEvent(state, 'good', `${outage.label} back after ${(durationMs / 1000).toFixed(1)} s`, at);
    }
  });
}

export function beginProbe(state, key, at) {
  const series = state.series[key];
  return { key, series, sample: series.begin(at) };
}

export function finishProbe(state, probe, rtt, at) {
  probe.series.finish(probe.sample, rtt);
  if (probe.series !== state.series[probe.key]) return; // statistics were reset while it was in flight
  if (rtt === null) noteLoss(state, probe, at);
  else noteSpike(state, probe, rtt, at);
  updateOutages(state, at);
}

export function recordPulse(state, pulse) {
  state.pulses.push(pulse);
  if (state.pulses.length > 500) state.pulses.shift();
}

function bucketize(samples) {
  const counts = HISTOGRAM_BUCKETS.map(() => 0);
  let lost = 0;
  samples.forEach(sample => {
    if (sample.rtt === null) { lost++; return; }
    counts[HISTOGRAM_BUCKETS.findIndex($_ => sample.rtt < $_.below)]++;
  });
  return { counts, lost, total: samples.length };
}

export function buildView(state, now) {
  const since = now - STATS_WINDOW_MS;
  const summaries = {};
  Object.keys(state.series).forEach($_ => { summaries[$_] = summarize(state.series[$_].completedSince(since)); });

  const internetSeries = INTERNET_KEYS.map($_ => state.series[$_]);
  summaries.internet = summarize(internetSeries.flatMap($_ => $_.completedSince(since)));

  const health = {};
  Object.keys(summaries).forEach($_ => { health[$_] = healthOf(summaries[$_], HEALTH_LIMITS[$_]); });

  const router = state.series.router;
  const routerIgnoresPings = router.replies === 0 && router.lost >= 6;
  if (routerIgnoresPings) health.router = 'unknown';

  const appSamples = APP_KEYS.flatMap($_ => state.series[$_].completedSince(since));
  const appFailPct = appSamples.length >= 3 ? summarize(appSamples).lossPct : 0;
  const tcpCounters = state.tcp.lastMinute();
  const realTrafficClean = appSamples.length >= 10 && appFailPct === 0
    && APP_KEYS.every($_ => health[$_] !== 'bad')
    && (!tcpCounters || tcpCounters.resentPct < 2);

  // Pings can get dropped while everything else flows. With real traffic clean, ping loss costs at most 15 points.
  const pingLossPct = summaries.internet.lossPct;
  const countedPingLossPct = realTrafficClean && pingLossPct !== null ? Math.min(3.75, pingLossPct) : pingLossPct;
  const worstLossPct = pingLossPct === null ? null : Math.max(countedPingLossPct, appFailPct);
  const score = stabilityScore(worstLossPct, summaries.internet.p50, summaries.internet.p95);

  const totalReplies = internetSeries.reduce((sum, $_) => sum + $_.replies, 0);
  const totalLost = internetSeries.reduce((sum, $_) => sum + $_.lost, 0);
  const totalProbes = totalReplies + totalLost;

  const longestOutageMs = Math.max(...state.outages.map(outage =>
    Math.max(outage.longestMs, outage.downSince === null ? 0 : now - outage.downSince)));

  const histogramSince = now - HISTOGRAM_WINDOW_MS;

  return {
    summaries,
    health,
    routerIgnoresPings,
    realTrafficClean,
    score,
    verdict: verdictOf(score),
    diagnosis: diagnose({
      health,
      routerIgnoresPings,
      realTrafficClean,
      gatewayChecked: state.info.gatewayChecked,
      hasGateway: !!state.info.gateway,
    }),
    uptimePct: totalProbes ? (totalReplies / totalProbes) * 100 : null,
    cleanForMs: Math.max(0, now - (state.lastTroubleAt ?? state.startedAt)),
    outageCount: state.outages.reduce((sum, $_) => sum + $_.count + ($_.downSince === null ? 0 : 1), 0),
    longestOutageMs,
    histogram: bucketize(internetSeries.flatMap($_ => $_.completedSince(histogramSince))),
    tcp: tcpCounters,
  };
}
