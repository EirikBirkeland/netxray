import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemo } from './demo.js';
import { formatDuration, formatMs, formatPct, formatRate, renderFrame } from './panels.js';
import { parseIwLink, parseNetDev, parseRouteTable, parseTcpCounters, pingCommand } from './linux.js';
import { parseCarrier, parsePingReply, parseTrace } from './probes.js';
import { Screen, diffToAnsi, rgb } from './screen.js';
import { printable } from './shared.js';
import { parseDefaultRoute, parseSamplerTick, parseWifi } from './windows.js';
import {
  Throughput, TcpCounters, beginProbe, buildView, createState, diagnose, finishProbe, percentile,
  resetMeasurements, stabilityScore, summarize, verdictOf,
} from './stats.js';

const samplesOf = values => values.map((rtt, i) => ({ at: i * 500, rtt }));

// Real measurements from this connection, 2026-11-01. X was a lost packet.
const BAD_MINUTE = samplesOf('1132 1345 67 X 1099 994 538 36 23 385 300 304 396 1518 X 919 60 502 607 429 132 X 1120 699 45 25 319 257 527 570 X 1603 171 223 68 15 X 519 24 41 29 185 121 52 215 314 322 1037 196 753 289 216 1105 201 202 26 471 103 57 611'
  .split(' ').map($_ => ($_ === 'X' ? null : Number($_))));
const GOOD_MINUTE = samplesOf('34 41 32 41 29 37 219 70 31 264 28 35 42 29 36 24 32 45 48 34 41 65 32 18 24 34 85 48 35 40 57 46 49 75 33 26 40 26 21 30 53 41 26 54 29 42 31 38 27 30 45 44 35 22 41 35 37 25 25 74'
  .split(' ').map(Number));

test('parsePingReply reads the replies Windows prints', () => {
  assert.equal(parsePingReply('Reply from 1.1.1.1: bytes=32 time=36ms TTL=57\r\n\r\nMinimum = 36ms, Maximum = 36ms'), 36);
  assert.equal(parsePingReply('Reply from 192.168.8.1: bytes=32 time<1ms TTL=64\r\n'), 0.5);
  assert.equal(parsePingReply('Request timed out.\r\n\r\nPackets: Sent = 1, Received = 0, Lost = 1 (100% loss),'), null);
  assert.equal(parsePingReply('Reply from 192.168.8.1: Destination host unreachable.\r\n'), null);
  assert.equal(parsePingReply('Reply from 10.0.0.1: TTL expired in transit.\r\n'), null);
  assert.equal(parsePingReply('PING: transmit failed. General failure.\r\n'), null);
  assert.equal(parsePingReply(''), null);
});

test('parseDefaultRoute takes the lowest metric and ignores what is not a gateway', () => {
  const output = `
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0     192.168.1.1     192.168.1.50     50
          0.0.0.0          0.0.0.0      192.168.8.1    192.168.8.201     20
          0.0.0.0          0.0.0.0         On-link        10.8.0.2       5
Persistent Routes:
  Network Address          Netmask  Gateway Address  Metric
          0.0.0.0          0.0.0.0      192.168.9.1  Default
`;
  assert.deepEqual(parseDefaultRoute(output), { gateway: '192.168.8.1', interfaceIp: '192.168.8.201', metric: 20 });
  assert.equal(parseDefaultRoute('Active Routes:\n  None\n'), null);
});

test('parseWifi reads only the adapter in use, and only when connected', () => {
  const output = `
There are 2 interfaces on the system:

    Name                   : Wi-Fi 9
    Description            : Qualcomm
    State                  : disconnected

    Name                   : Wi-Fi 15
    Description            : ASUS
    State                  : connected
    SSID                   : Fibre 5G
    AP BSSID               : aa:bb:cc:dd:ee:ff
    Band                   : 5 GHz
    Channel                : 36
    Receive rate (Mbps)    : 866.7
    Signal                 : 87%
`;
  assert.deepEqual(parseWifi(output, 'Wi-Fi 15'), { ssid: 'Fibre 5G', signal: '87%', band: 'ch 36' });
  assert.equal(parseWifi(output, 'Wi-Fi 9'), null);
  assert.equal(parseWifi(output, 'Ethernet 5'), null);
  assert.equal(parseWifi('The Wireless AutoConfig Service is not running.', 'Wi-Fi 15'), null);
});

test('parsePingReply also reads Linux replies, and Linux ping gets whole seconds', () => {
  const reply = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 12.300/12.300/12.300/0.000 ms
`;
  assert.equal(parsePingReply(reply), 12.3);
  assert.equal(parsePingReply('1 packets transmitted, 0 received, 100% packet loss, time 0ms\n'), null);
  assert.equal(parsePingReply('From 192.168.8.1 icmp_seq=1 Destination Host Unreachable\n'), null);
  assert.deepEqual(pingCommand('1.1.1.1', 2000).args, ['-n', '-c', '1', '-W', '2', '1.1.1.1']);
});

test('parseRouteTable takes the lowest metric and ignores on-link defaults', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    'eth0\t00000000\t0108A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'tun0\t00000000\t00000000\t0001\t0\t0\t50\t00000000\t0\t0\t0',
    'eth0\t0008A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    '',
  ].join('\n');
  assert.deepEqual(parseRouteTable(table), { gateway: '192.168.8.1', adapter: 'eth0' });
  assert.equal(parseRouteTable('Iface\tDestination\tGateway\n'), null);
});

test('parseIwLink reads a connected adapter and rejects a disconnected one', () => {
  const output = `Connected to aa:bb:cc:dd:ee:ff (on wlp2s0)
	SSID: Fibre 5G
	freq: 5180.0
	RX: 123 bytes (4 packets)
	signal: -52 dBm
	rx bitrate: 866.7 MBit/s
`;
  assert.deepEqual(parseIwLink(output), { ssid: 'Fibre 5G', signal: '-52 dBm', band: '5180 MHz' });
  assert.equal(parseIwLink('Not connected.\n'), null);
  assert.equal(parseIwLink(''), null);
});

test('parseNetDev reads received and sent bytes per adapter', () => {
  const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth0:785826207  500000    0    0    0     0          0         0 116855672  400000    0    0    0     0       0          0
`;
  assert.deepEqual(parseNetDev(text), [
    { name: 'lo', rxBytes: 1000, txBytes: 2000 },
    { name: 'eth0', rxBytes: 785826207, txBytes: 116855672 },
  ]);
});

test('parseTcpCounters finds fields by their names', () => {
  const text = `Ip: Forwarding DefaultTTL
Ip: 1 64
Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors
Tcp: 1 200 120000 -1 500 40 118 3 12 400000 324663 3020 0 825 0
`;
  assert.deepEqual(parseTcpCounters(text), { sent: 324663, resent: 3020, failed: 118, resets: 825 });
  assert.equal(parseTcpCounters('Ip: 1 64\n'), null);
});

test('parseSamplerTick reads adapters and TCP counters', () => {
  const { adapters, tcp } = parseSamplerTick([
    'N\tEthernet 5\tEthernet\t2500000000\t785826207\t116855672',
    'T\t324663\t3020\t118\t825',
    'garbage',
  ]);
  assert.deepEqual(adapters, [{ name: 'Ethernet 5', type: 'Ethernet', linkBps: 2500000000, rxBytes: 785826207, txBytes: 116855672 }]);
  assert.deepEqual(tcp, { sent: 324663, resent: 3020, failed: 118, resets: 825 });
});

test('parseTrace and parseCarrier pull out the fields shown', () => {
  assert.deepEqual(parseTrace('fl=1\nip=203.0.113.9\ncolo=BKK\nloc=TH\n'), { ip: '203.0.113.9', edge: 'BKK' });
  assert.deepEqual(parseCarrier('{"city":"Bangkok","country":"TH","org":"AS131445 Advance Wireless Network"}'),
    { carrier: 'Advance Wireless Network', place: 'Bangkok TH' });
  assert.deepEqual(parseCarrier('{}'), { carrier: null, place: null });
  assert.throws(() => parseCarrier('<html>'));
});

test('printable blocks escape sequences and wide characters from reaching the screen', () => {
  assert.equal(printable('\x1b[2Jevil'), '?[2Jevil');
  assert.equal(printable('บ้าน 5G'), '???? 5G');
});

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});

test('summarize reproduces the real bad minute', () => {
  const summary = summarize(BAD_MINUTE);
  assert.equal(summary.count, 60);
  assert.ok(Math.abs(summary.lossPct - (5 / 60) * 100) < 0.001);
  assert.equal(summary.max, 1603);
});

test('summarize handles nothing at all and total loss', () => {
  assert.equal(summarize([]).lossPct, null);
  const allLost = summarize(samplesOf([null, null]));
  assert.equal(allLost.lossPct, 100);
  assert.equal(allLost.p50, null);
  assert.equal(allLost.jitter, null);
});

test('the score tells the two real minutes apart', () => {
  const scoreOf = samples => {
    const summary = summarize(samples);
    return stabilityScore(summary.lossPct, summary.p50, summary.p95);
  };
  assert.ok(['BAD', 'BROKEN'].includes(verdictOf(scoreOf(BAD_MINUTE))));
  assert.equal(verdictOf(scoreOf(GOOD_MINUTE)), 'ROCK SOLID');
});

test('the score hits zero when everything is lost, and is unknown without data', () => {
  assert.equal(stabilityScore(100, null, null), 0);
  assert.equal(verdictOf(stabilityScore(100, null, null)), 'BROKEN');
  assert.equal(stabilityScore(null, null, null), null);
  assert.equal(verdictOf(null), 'MEASURING');
});

test('diagnose never blames a layer the evidence does not point to', () => {
  const healthy = { router: 'good', cloudflare: 'good', google: 'good', tcp: 'good', dns: 'good', https: 'good' };
  const textFor = (health, extra = {}) => diagnose({
    health: { ...healthy, ...health }, routerIgnoresPings: false, gatewayChecked: true, hasGateway: true, ...extra,
  }).text;

  assert.equal(textFor({}), 'All layers clean.');
  assert.equal(textFor({ cloudflare: 'bad', google: 'bad' }), 'Router clean. Trouble at its uplink or beyond.');
  assert.equal(textFor({ router: 'bad', cloudflare: 'bad', google: 'bad' }), 'Trouble between this PC and the router.');
  assert.equal(textFor({ router: 'unknown', cloudflare: 'bad', google: 'bad' }), 'Trouble on the way to the internet.');
  assert.equal(textFor({ cloudflare: 'bad', google: 'bad', router: 'unknown' }, { routerIgnoresPings: true }), 'Trouble on the way to the internet.');
  assert.equal(textFor({ router: 'unknown' }, { routerIgnoresPings: true }), 'All layers clean.');
  assert.equal(textFor({ google: 'warn' }), 'Only Google is affected so far.');
  assert.equal(textFor({ dns: 'bad' }), 'Pings clean. DNS failing or slow.');
  assert.equal(textFor({ https: 'warn' }), 'Pings clean. HTTPS failing or slow.');
  assert.equal(textFor({}, { hasGateway: false }), 'No default route. This PC has no network.');
  assert.equal(textFor({ cloudflare: 'unknown', google: 'unknown' }), 'Measuring…');
});

test('probes finishing out of order land on the time they were sent', () => {
  const state = createState(0);
  const slow = beginProbe(state, 'google', 1000);
  const quick = beginProbe(state, 'google', 1500);
  finishProbe(state, quick, 20, 1520);
  finishProbe(state, slow, 900, 1900);
  assert.deepEqual(state.series.google.completedSince(0).map($_ => $_.rtt), [900, 20]);
});

test('an in-flight probe is not counted as lost', () => {
  const state = createState(0);
  beginProbe(state, 'google', 1000);
  assert.equal(buildView(state, 1100).summaries.google.count, 0);
});

test('an internet outage needs both targets down, and logs how long it lasted', () => {
  const state = createState(0);
  const send = (key, at, rtt) => finishProbe(state, beginProbe(state, key, at), rtt, at);

  [1000, 1500, 2000].forEach($_ => { send('cloudflare', $_, null); });
  assert.equal(state.events.some($_ => $_.text === 'Internet down'), false);

  [1000, 1500, 2000].forEach($_ => { send('google', $_, null); });
  assert.equal(state.events.some($_ => $_.text === 'Internet down'), true);
  assert.equal(buildView(state, 3000).longestOutageMs, 2000);

  send('google', 6000, 30);
  assert.equal(state.events.at(-1).text, 'Internet back after 5.0 s');
  assert.equal(buildView(state, 7000).outageCount, 1);
  assert.equal(buildView(state, 7000).longestOutageMs, 5000);
});

test('a router that has never answered is ignoring pings, not failing', () => {
  const state = createState(0);
  for (let at = 0; at < 4000; at += 500) finishProbe(state, beginProbe(state, 'router', at), null, at);
  const view = buildView(state, 4000);
  assert.equal(view.routerIgnoresPings, true);
  assert.equal(view.outageCount, 0);
  assert.equal(state.lastTroubleAt, null);
});

test('a spike is logged against the recent median, and throttled', () => {
  const state = createState(0);
  const send = (at, rtt) => finishProbe(state, beginProbe(state, 'cloudflare', at), rtt, at);
  for (let at = 0; at < 6000; at += 500) send(at, 30);
  send(6000, 1200);
  send(6500, 1300);
  const spikes = state.events.filter($_ => $_.text.includes('spike'));
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].text, 'Cloudflare spike: 1200 ms');
});

test('reset clears measurements but keeps the connection facts, and ignores late results', () => {
  const state = createState(0);
  state.info.gateway = '192.168.8.1';
  const inFlight = beginProbe(state, 'google', 100);
  finishProbe(state, beginProbe(state, 'google', 200), null, 200);
  resetMeasurements(state, 300);

  finishProbe(state, inFlight, null, 400);
  assert.equal(state.series.google.lost, 0);
  assert.equal(state.lastTroubleAt, null);
  assert.equal(state.info.gateway, '192.168.8.1');
  assert.equal(state.startedAt, 300);
});

test('throughput computes rates and survives adapter switches and counter wraps', () => {
  const throughput = new Throughput();
  throughput.feed(1000, 'A', 0, 0);
  throughput.feed(2000, 'A', 1250000, 125000);
  assert.equal(throughput.latest('down'), 10);
  assert.equal(throughput.latest('up'), 1);

  throughput.feed(3000, 'B', 9e12, 9e12);
  assert.equal(throughput.latest('down'), 10);

  throughput.feed(4000, 'B', 0, 0);
  assert.equal(throughput.latest('down'), 0);
});

test('perSecond fills one skipped second but not a real gap', () => {
  const throughput = new Throughput();
  throughput.rates = [{ at: 10000, down: 5, up: 0 }, { at: 12000, down: 7, up: 0 }];
  assert.deepEqual(throughput.perSecond(15000, 6, 'down'), [5, 5, 7, 7, null, null]);
});

test('TCP counters report only what changed in the window', () => {
  const tcp = new TcpCounters();
  tcp.feed(0, { sent: 1000, resent: 10, failed: 1, resets: 2 });
  assert.equal(tcp.lastMinute(), null);
  tcp.feed(30000, { sent: 2000, resent: 30, failed: 3, resets: 2 });
  assert.deepEqual(tcp.lastMinute(), { sent: 1000, resent: 20, resentPct: 2, failed: 2, resets: 0 });
});

test('formatters', () => {
  assert.equal(formatMs(null), '–');
  assert.equal(formatMs(0.5), '<1');
  assert.equal(formatMs(36.4), '36');
  assert.equal(formatMs(1603), '1.6s');
  assert.equal(formatPct(0), '0%');
  assert.equal(formatPct(8.333), '8.3%');
  assert.equal(formatPct(15), '15%');
  assert.equal(formatDuration(4500), '4.5 s');
  assert.equal(formatDuration(252000), '4m 12s');
  assert.equal(formatDuration(3720000), '1h 2m');
  assert.equal(formatRate(0.4), '400 kbit/s');
  assert.equal(formatRate(12.34), '12.3 Mbit/s');
  assert.equal(formatRate(2500), '2.5 Gbit/s');
});

// Plays escape sequences back onto a grid, the way a terminal would.
function replay(ansi, grid) {
  const pattern = /\x1b\[(\d+);(\d+)H|\x1b\[38;2;(\d+);(\d+);(\d+)m|\x1b\[48;2;(\d+);(\d+);(\d+)m|\x1b\[0m|([\s\S])/gu;
  let x = 0;
  let y = 0;
  let fg = 0;
  let bg = 0;
  for (const match of ansi.matchAll(pattern)) {
    if (match[1]) { y = Number(match[1]) - 1; x = Number(match[2]) - 1; continue; }
    if (match[3]) { fg = rgb(+match[3], +match[4], +match[5]); continue; }
    if (match[6]) { bg = rgb(+match[6], +match[7], +match[8]); continue; }
    if (match[9] === undefined) continue;
    const index = y * grid.width + x;
    grid.chars[index] = match[9];
    grid.fg[index] = fg;
    grid.bg[index] = bg;
    x++;
  }
}

function assertScreensLookSame(actual, expected) {
  for (let i = 0; i < expected.chars.length; i++) {
    assert.equal(actual.chars[i], expected.chars[i], `char at ${i}`);
    assert.equal(actual.bg[i], expected.bg[i], `background at ${i}`);
    if (expected.chars[i] !== ' ') assert.equal(actual.fg[i], expected.fg[i], `colour at ${i}`);
  }
}

function demoState(now) {
  const state = createState(now - 600000);
  createDemo(state, state.startedAt)(now);
  return state;
}

test('frame diffs played back in sequence always rebuild the exact screen', () => {
  const start = 1700000000000;
  const state = demoState(start);
  const terminal = new Screen(120, 40);
  let previous = null;

  for (let frame = 0; frame < 40; frame++) {
    const now = start + frame * 100;
    const next = new Screen(120, 40);
    renderFrame(next, state, now);
    replay(diffToAnsi(next, previous), terminal);
    assertScreensLookSame(terminal, next);
    previous = next;
  }
});

test('an unchanged frame writes nothing', () => {
  const a = new Screen(10, 3);
  const b = new Screen(10, 3);
  a.text(1, 1, 'hello', rgb(1, 2, 3));
  b.text(1, 1, 'hello', rgb(1, 2, 3));
  assert.equal(diffToAnsi(b, a), '');
});

test('the page draws at every size, full or empty, and stays single-width', () => {
  const now = 1700000000000;
  const states = [createState(now), demoState(now)];
  const sizes = [];
  for (let width = 1; width <= 260; width += 7) {
    for (let height = 1; height <= 90; height += 5) sizes.push([width, height]);
  }
  for (let width = 88; width <= 92; width++) {
    for (let height = 28; height <= 32; height++) sizes.push([width, height]);
  }

  states.forEach(state => {
    sizes.forEach(([width, height]) => {
      const screen = new Screen(width, height);
      renderFrame(screen, state, now);
      screen.chars.forEach(char => assert.equal(Array.from(char).length, 1));
    });
  });
});

test('nothing collides at the minimum size, even with loss on every layer', () => {
  const now = 1700000000000;
  const state = createState(now - 60000);
  Object.assign(state.info, { adapter: 'Ethernet 5', linkBps: 2500000000, gateway: '192.168.8.1', gatewayChecked: true });
  Object.keys(state.series).forEach(key => {
    for (let i = 0; i < 100; i++) {
      const at = now - 50000 + i * 500;
      finishProbe(state, beginProbe(state, key, at), i % 9 === 0 ? null : 1234, at);
    }
  });
  const screen = new Screen(90, 30);
  renderFrame(screen, state, now);
  const rows = Array.from({ length: 30 }, (_, y) => screen.chars.slice(y * 90, (y + 1) * 90).join(''));
  const page = rows.join('\n');

  ['Router', 'Cloudflare', 'Google'].forEach(name => assert.ok(page.includes(`● ${name}  `) || page.includes(`● ${name} `), name));
  const valuesRow = rows[5];
  assert.equal(valuesRow.match(/12%/g)?.length, 5);
  assert.match(page, /▼ \S+M? /);
  assert.ok(!/\d+ms \d/.test(valuesRow));
});

// A minute shaped like the real 22:25 screen: pings lost in bursts, everything else flawless.
function pingLossMinute({ tcpFails = false, resent = 4 } = {}) {
  const now = 1700000000000;
  const state = createState(now - 60000);
  Object.assign(state.info, { gateway: '192.168.8.1', gatewayChecked: true });
  const send = (key, at, rtt) => finishProbe(state, beginProbe(state, key, at), rtt, at);
  for (let i = 0; i < 110; i++) {
    const at = now - 55000 + i * 500;
    send('router', at, 0.5);
    send('cloudflare', at, i % 12 === 0 ? null : 65);
    send('google', at, i % 4 === 0 ? null : 66);
    if (i % 2 === 0) send('tcp', at, tcpFails && i % 8 === 0 ? null : 64);
    if (i % 4 === 0) send('dns', at, 71);
    if (i % 6 === 0) send('https', at, 283);
  }
  state.tcp.feed(now - 50000, { sent: 0, resent: 0, failed: 0, resets: 0 });
  state.tcp.feed(now, { sent: 15371, resent, failed: 0, resets: 0 });
  return { state, now };
}

test('pings dropping while real traffic is clean is not called a bad line', () => {
  const { state, now } = pingLossMinute();
  const view = buildView(state, now);
  assert.equal(view.realTrafficClean, true);
  assert.ok(view.score >= 70, `score ${view.score}`);
  assert.equal(view.diagnosis.text, 'Only pings suffer. TCP, DNS and HTTPS clean.');
});

test('the same ping loss counts in full once real traffic is hurting too', () => {
  const withFailures = pingLossMinute({ tcpFails: true });
  const failingView = buildView(withFailures.state, withFailures.now);
  assert.equal(failingView.realTrafficClean, false);
  assert.ok(failingView.score < 40, `score ${failingView.score}`);
  assert.equal(failingView.diagnosis.text, 'Router clean. Trouble at its uplink or beyond.');

  const withResends = pingLossMinute({ resent: 900 });
  const resendingView = buildView(withResends.state, withResends.now);
  assert.equal(resendingView.realTrafficClean, false);
  assert.ok(resendingView.score < 40, `score ${resendingView.score}`);
});

test('the table never cuts a name, at any width', () => {
  const now = 1700000000000;
  const state = demoState(now);
  for (let width = 90; width <= 200; width++) {
    const screen = new Screen(width, 30);
    renderFrame(screen, state, now);
    const page = screen.chars.join('');
    const tableX = width - Math.max(44, Math.round(width * 0.36));
    const cloudflareRow = screen.chars.slice(11 * width + tableX, 12 * width).join('');
    assert.ok(cloudflareRow.includes('Cloudflare'), `width ${width}: ${cloudflareRow}`);
    assert.ok(page.length > 0);
  }
});

test('boxes stay inside the page at the minimum size', () => {
  const now = 1700000000000;
  const screen = new Screen(90, 30);
  renderFrame(screen, demoState(now), now);
  const lastRow = screen.chars.slice(29 * 90).join('');
  assert.ok(lastRow.includes('quit'));
  const secondLast = screen.chars.slice(28 * 90, 29 * 90).join('');
  assert.ok(secondLast.startsWith('╰') && secondLast.endsWith('╯'));
});
