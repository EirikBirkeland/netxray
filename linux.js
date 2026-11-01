// What only Linux can tell: its ping, Wi-Fi details, and everything the kernel lists under /proc and /sys.

import { existsSync, readFileSync } from 'node:fs';
import { printable, run } from './shared.js';

const IW_ENV = { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/sbin:/sbin` };

export function pingCommand(target, timeoutMs) {
  return { file: 'ping', args: ['-n', '-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), target] };
}

// Gateways in /proc/net/route are little-endian hex: 0108A8C0 is 192.168.8.1.
function gatewayFromHex(hex) {
  const bytes = hex.match(/../g).map($_ => parseInt($_, 16));
  return bytes.reverse().join('.');
}

// The default route with the lowest metric, skipping on-link routes that have no gateway to ping.
export function parseRouteTable(text) {
  const routes = [];
  text.split('\n').slice(1).forEach(line => {
    const [adapter, destination, gateway, , , , metric] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !gateway || gateway === '00000000') return;
    routes.push({ gateway: gatewayFromHex(gateway), adapter, metric: Number(metric) });
  });
  routes.sort((a, b) => a.metric - b.metric);
  if (routes.length === 0) return null;
  return { gateway: routes[0].gateway, adapter: routes[0].adapter };
}

export async function readDefaultRoute() {
  return parseRouteTable(readFileSync('/proc/net/route', 'utf8'));
}

export function parseIwLink(stdout) {
  if (!/^Connected to/m.test(stdout)) return null;
  const field = name => stdout.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'))?.[1] ?? null;
  const ssid = field('SSID');
  const signal = field('signal');
  const frequency = field('freq');
  return {
    ssid: ssid === null ? null : printable(ssid),
    signal: signal === null ? null : printable(signal),
    band: frequency === null ? null : `${Math.round(Number(frequency))} MHz`,
  };
}

export async function readWifi(adapter) {
  const { stdout } = await run('iw', ['dev', adapter, 'link'], 5000, IW_ENV);
  return parseIwLink(stdout);
}

export function parseNetDev(text) {
  const adapters = [];
  text.split('\n').forEach(line => {
    const match = line.match(/^\s*([^\s:]+):\s*(.+)$/);
    if (!match) return;
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 9) return;
    adapters.push({ name: match[1], rxBytes: fields[0], txBytes: fields[8] });
  });
  return adapters;
}

export function parseTcpCounters(text) {
  const tcpLines = text.split('\n').filter($_ => $_.startsWith('Tcp:'));
  if (tcpLines.length < 2) return null;
  const names = tcpLines[0].trim().split(/\s+/);
  const values = tcpLines[1].trim().split(/\s+/).map(Number);
  const valueOf = name => values[names.indexOf(name)];
  return { sent: valueOf('OutSegs'), resent: valueOf('RetransSegs'), failed: valueOf('AttemptFails'), resets: valueOf('OutRsts') };
}

// The file holds Mbit/s. Wi-Fi and disconnected adapters report -1 or refuse to be read.
function linkBpsOf(name) {
  try {
    const mbps = Number(readFileSync(`/sys/class/net/${name}/speed`, 'utf8'));
    return mbps > 0 ? mbps * 1e6 : null;
  } catch {
    return null;
  }
}

export function startCounters(onTick) {
  function tick() {
    const adapters = parseNetDev(readFileSync('/proc/net/dev', 'utf8')).map(adapter => ({
      ...adapter,
      type: existsSync(`/sys/class/net/${adapter.name}/wireless`) ? 'Wireless80211' : 'Ethernet',
      linkBps: linkBpsOf(adapter.name),
    }));
    onTick({ adapters, tcp: parseTcpCounters(readFileSync('/proc/net/snmp', 'utf8')) });
  }

  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
