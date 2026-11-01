#!/usr/bin/env node
// Live one-page view of how stable the connection is. q quits, p toggles the download probe, r resets.

import { createDemo } from './demo.js';
import { formatDuration, formatPct, renderFrame } from './panels.js';
import { startProbes } from './probes.js';
import { Screen, diffToAnsi } from './screen.js';
import { buildView, createState, resetMeasurements } from './stats.js';

const FRAME_MS = 100;
const DEMO_BACKFILL_MS = 12 * 60 * 1000;

const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
const LEAVE_SCREEN = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
const BEGIN_SYNC = '\x1b[?2026h';
const END_SYNC = '\x1b[?2026l';

function startDemo(state) {
  const now = Date.now();
  const advanceTo = createDemo(state, now - DEMO_BACKFILL_MS);
  state.startedAt = now - DEMO_BACKFILL_MS;
  advanceTo(now);
  const timer = setInterval(() => advanceTo(Date.now()), 250);
  return () => clearInterval(timer);
}

function sessionSummary(state, now) {
  const view = buildView(state, now);
  const lossOf = series => formatPct(series.replies + series.lost ? (series.lost / (series.replies + series.lost)) * 100 : null);
  const { router, cloudflare, google } = state.series;
  return [
    `netxray: ${formatDuration(now - state.startedAt)}, last verdict ${view.verdict}`,
    `  loss: router ${lossOf(router)}, Cloudflare ${lossOf(cloudflare)}, Google ${lossOf(google)}`,
    `  outages: ${view.outageCount}${view.longestOutageMs ? `, longest ${formatDuration(view.longestOutageMs)}` : ''}`,
  ].join('\n');
}

function main() {
  const { stdout, stdin } = process;
  if (!stdout.isTTY) {
    console.error('netxray needs a terminal to draw on.');
    process.exit(1);
  }

  const state = createState(Date.now());
  const stopFeed = process.argv.includes('--demo') ? startDemo(state) : startProbes(state);
  let front = null;
  let back = null;
  let leaving = false;

  function drawFrame() {
    const now = Date.now();
    if (stdout.writableNeedDrain) return;
    const width = stdout.columns ?? 80;
    const height = stdout.rows ?? 24;
    if (!back || back.width !== width || back.height !== height) {
      back = new Screen(width, height);
      front = null;
    }
    renderFrame(back, state, now);
    const changes = diffToAnsi(back, front);
    if (changes) stdout.write(BEGIN_SYNC + changes + END_SYNC);
    const previous = front;
    front = back;
    back = previous ?? new Screen(width, height);
  }

  function leave(code = 0) {
    if (leaving) return;
    leaving = true;
    clearInterval(frameTimer);
    stopFeed();
    stdout.write(LEAVE_SCREEN);
    if (stdin.isTTY) stdin.setRawMode(false);
    console.log(sessionSummary(state, Date.now()));
    process.exit(code);
  }

  stdout.write(ENTER_SCREEN);
  stdout.on('resize', () => { front = null; stdout.write('\x1b[2J'); });
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', key => {
    if (key === 'q' || key === 'Q' || key === '\x03' || key === '\x1b') leave();
    if (key === 'p' || key === 'P') state.pulseEnabled = !state.pulseEnabled;
    if (key === 'r' || key === 'R') resetMeasurements(state, Date.now());
  });
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach($_ => process.on($_, () => leave()));
  process.on('uncaughtException', error => {
    if (!leaving) stdout.write(LEAVE_SCREEN);
    leaving = true;
    console.error(error);
    process.exit(1);
  });

  const frameTimer = setInterval(drawFrame, FRAME_MS);
  drawFrame();
}

main();
