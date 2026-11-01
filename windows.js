// What only Windows can tell: its ping, route table, Wi-Fi details and adapter counters.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { printable, run } from './shared.js';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const PING_EXE = path.join(SYSTEM32, 'PING.EXE');
const ROUTE_EXE = path.join(SYSTEM32, 'ROUTE.EXE');
const NETSH_EXE = path.join(SYSTEM32, 'netsh.exe');
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function pingCommand(target, timeoutMs) {
  return { file: PING_EXE, args: ['-n', '1', '-w', String(timeoutMs), target] };
}

// The default route with the lowest metric, skipping on-link routes that have no gateway to ping.
export function parseDefaultRoute(stdout) {
  const routes = [];
  stdout.split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$/);
    if (match) routes.push({ gateway: match[1], interfaceIp: match[2], metric: Number(match[3]) });
  });
  routes.sort((a, b) => a.metric - b.metric);
  return routes[0] ?? null;
}

export async function readDefaultRoute() {
  const { stdout } = await run(ROUTE_EXE, ['print', '-4', '0.0.0.0'], 5000);
  const route = parseDefaultRoute(stdout);
  if (!route) return null;
  const interfaces = Object.entries(os.networkInterfaces());
  const owner = interfaces.find(([, addresses]) => addresses.some($_ => $_.address === route.interfaceIp));
  return { gateway: route.gateway, adapter: owner ? owner[0] : null };
}

export function parseWifi(stdout, adapterName) {
  const blocks = stdout.split(/^\s*Name\s*:\s*/m).slice(1);
  const block = blocks.find($_ => $_.split(/\r?\n/)[0].trim() === adapterName);
  if (!block) return null;

  const field = pattern => block.match(new RegExp(`^\\s*${pattern}\\s*:\\s*(.+?)\\s*$`, 'mi'))?.[1] ?? null;
  if (field('State')?.toLowerCase() !== 'connected') return null;
  const signal = field('Signal')?.match(/\d+/)?.[0];
  const channel = field('Channel');
  return {
    ssid: field('SSID') === null ? null : printable(field('SSID')),
    signal: signal === undefined ? null : `${signal}%`,
    band: channel === null ? null : `ch ${channel}`,
  };
}

export async function readWifi(adapter) {
  const { stdout } = await run(NETSH_EXE, ['wlan', 'show', 'interfaces'], 5000);
  return parseWifi(stdout, adapter);
}

// One block per sampler tick: N lines per adapter, a T line for TCP, then E.
export function parseSamplerTick(lines) {
  const adapters = [];
  let tcp = null;
  lines.forEach(line => {
    const fields = line.split('\t');
    if (fields[0] === 'N' && fields.length === 6) {
      adapters.push({
        name: fields[1],
        type: fields[2],
        linkBps: Number(fields[3]),
        rxBytes: Number(fields[4]),
        txBytes: Number(fields[5]),
      });
    }
    if (fields[0] === 'T' && fields.length === 5) {
      tcp = { sent: Number(fields[1]), resent: Number(fields[2]), failed: Number(fields[3]), resets: Number(fields[4]) };
    }
  });
  return { adapters, tcp };
}

// One long-lived process, since starting PowerShell every second would itself load the machine. It leaves when netxray is gone.
export function startCounters(onTick, onProblem) {
  let sampler = null;
  let restartTimer = null;
  let buffer = '';
  let lines = [];
  let stopped = false;

  function onOutput(chunk) {
    buffer += chunk;
    const received = buffer.split(/\r?\n/);
    buffer = received.pop();
    received.forEach(line => {
      if (line === 'E') {
        onTick(parseSamplerTick(lines));
        lines = [];
      } else {
        lines.push(line);
      }
    });
  }

  function start() {
    const script = [
      `$parent=${process.pid}`,
      '$tab=[char]9',
      '$ip=[System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()',
      'while($true){',
      'if(-not(Get-Process -Id $parent -ErrorAction SilentlyContinue)){exit}',
      'foreach($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){',
      "if($n.OperationalStatus -ne 'Up'){continue}",
      '$s=$n.GetIPStatistics()',
      "[Console]::Out.WriteLine(('N',$n.Name,$n.NetworkInterfaceType,$n.Speed,$s.BytesReceived,$s.BytesSent) -join $tab)",
      '}',
      '$a=$ip.GetTcpIPv4Statistics();$b=$ip.GetTcpIPv6Statistics()',
      "[Console]::Out.WriteLine(('T',($a.SegmentsSent+$b.SegmentsSent),($a.SegmentsResent+$b.SegmentsResent),($a.FailedConnectionAttempts+$b.FailedConnectionAttempts),($a.ResetsSent+$b.ResetsSent)) -join $tab)",
      "[Console]::Out.WriteLine('E')",
      '[Console]::Out.Flush()',
      'Start-Sleep -Milliseconds 1000',
      '}',
    ].join(';').replace(/\{;/g, '{').replace(/;\}/g, '}').replace(/\};/g, '}\n');

    sampler = spawn(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    sampler.stdout.setEncoding('utf8');
    sampler.stdout.on('data', onOutput);
    sampler.on('exit', () => {
      if (stopped) return;
      onProblem('Adapter sampler stopped. Restarting.');
      restartTimer = setTimeout(start, 2000);
    });
    sampler.on('error', () => {});
  }

  start();

  return function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    sampler?.kill();
  };
}
