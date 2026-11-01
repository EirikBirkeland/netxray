// Draws one full page from the current measurements. Nothing here measures or decides anything: see stats.js.

import { add, mix, rgb, scale } from './screen.js';
import { HISTOGRAM_BUCKETS, buildView } from './stats.js';

export const MIN_WIDTH = 90;
export const MIN_HEIGHT = 30;

const VERTICAL_BLOCKS = ' ▁▂▃▄▅▆▇█';
const HORIZONTAL_BLOCKS = ' ▏▎▍▌▋▊▉█';

const CHART_FLOOR_MS = 1;
const CHART_CEILING_MS = 2000;
const HEAT_CELL_MS = 10 * 1000;
const BEAM_CYCLE_MS = 7000;

const TEXT = rgb(226, 232, 240);
const MUTED = rgb(148, 163, 184);
const FAINT = rgb(82, 96, 120);
const GRID = rgb(38, 48, 68);
const BORDER = rgb(62, 78, 108);
const ACCENT = rgb(56, 189, 248);
const VIOLET = rgb(167, 139, 250);
const DOWN_COLOR = rgb(34, 211, 238);
const UP_COLOR = rgb(232, 121, 249);
const LOST_RED = rgb(255, 72, 96);
const LOST_BACKGROUND = rgb(74, 14, 30);
const EMPTY_HEAT = rgb(20, 27, 42);

const HEALTH_COLORS = {
  good: rgb(52, 211, 153),
  warn: rgb(251, 191, 36),
  bad: rgb(255, 72, 96),
  unknown: rgb(100, 116, 139),
  info: rgb(125, 170, 230),
};

const VERDICT_COLORS = {
  'ROCK SOLID': HEALTH_COLORS.good,
  DECENT: rgb(163, 230, 53),
  SHAKY: HEALTH_COLORS.warn,
  BAD: rgb(251, 146, 60),
  BROKEN: HEALTH_COLORS.bad,
  MEASURING: HEALTH_COLORS.unknown,
};

const LATENCY_STOPS = [
  [1, rgb(45, 212, 191)],
  [30, rgb(52, 211, 153)],
  [80, rgb(163, 230, 53)],
  [200, rgb(250, 204, 21)],
  [500, rgb(251, 146, 60)],
  [1000, rgb(248, 90, 90)],
  [2000, rgb(236, 40, 110)],
];

const DIGITS = {
  0: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.'],
  1: ['..#.', '.##.', '..#.', '..#.', '..#.', '.###'],
  2: ['.##.', '#..#', '...#', '..#.', '.#..', '####'],
  3: ['###.', '...#', '.##.', '...#', '...#', '###.'],
  4: ['#..#', '#..#', '#..#', '####', '...#', '...#'],
  5: ['####', '#...', '###.', '...#', '...#', '###.'],
  6: ['.##.', '#...', '###.', '#..#', '#..#', '.##.'],
  7: ['####', '...#', '..#.', '.#..', '.#..', '.#..'],
  8: ['.##.', '#..#', '.##.', '#..#', '#..#', '.##.'],
  9: ['.##.', '#..#', '#..#', '.###', '...#', '.##.'],
  '-': ['....', '....', '####', '....', '....', '....'],
};

export function latencyColor(ms) {
  if (ms <= LATENCY_STOPS[0][0]) return LATENCY_STOPS[0][1];
  for (let i = 1; i < LATENCY_STOPS.length; i++) {
    const [stopMs, stopColor] = LATENCY_STOPS[i];
    if (ms <= stopMs) {
      const [previousMs, previousColor] = LATENCY_STOPS[i - 1];
      return mix(previousColor, stopColor, Math.log(ms / previousMs) / Math.log(stopMs / previousMs));
    }
  }
  return LATENCY_STOPS[LATENCY_STOPS.length - 1][1];
}

function lossColor(lossPct) {
  if (lossPct === null) return FAINT;
  if (lossPct === 0) return HEALTH_COLORS.good;
  return lossPct < 5 ? HEALTH_COLORS.warn : HEALTH_COLORS.bad;
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1) return '<1';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return String(Math.round(ms));
}

export function formatPct(pct) {
  if (pct === null || pct === undefined) return '–';
  if (pct === 0) return '0%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function formatRate(mbps) {
  if (mbps === null || mbps === undefined) return '–';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)} Gbit/s`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbit/s`;
  return `${Math.round(mbps * 1000)} kbit/s`;
}

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

function formatRateShort(mbps) {
  if (mbps === null || mbps === undefined) return '–';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)}G`;
  if (mbps >= 1) return `${mbps.toFixed(1)}M`;
  return `${Math.round(mbps * 1000)}k`;
}

function formatLinkSpeed(bps) {
  if (!bps) return '–';
  return bps >= 1e9 ? `${+(bps / 1e9).toFixed(1)} Gbit` : `${Math.round(bps / 1e6)} Mbit`;
}

const clockOf = at => new Date(at).toTimeString().slice(0, 8);

function centered(screen, x, width, y, string, color) {
  const length = Math.min(Array.from(string).length, width);
  screen.text(x + Math.floor((width - length) / 2), y, string, color, undefined, width);
}

function rightAligned(screen, rightEdge, y, string, color) {
  const length = Array.from(string).length;
  screen.text(rightEdge - length + 1, y, string, color);
}

function drawBox(screen, x, y, width, height, title, rightText = '', accent = ACCENT) {
  screen.mapBackground(x, y, width, height, $_ => add($_, 5, 6, 9));
  const right = x + width - 1;
  const bottom = y + height - 1;

  for (let col = x; col <= right; col++) {
    const color = mix(accent, BORDER, Math.min(1, (col - x) / Math.max(1, width * 0.45)));
    const char = col === x ? '╭' : col === right ? '╮' : '─';
    screen.cell(col, y, char, color);
    screen.cell(col, bottom, col === x ? '╰' : col === right ? '╯' : '─', BORDER);
  }
  for (let row = y + 1; row < bottom; row++) {
    screen.cell(x, row, '│', mix(accent, BORDER, 0.6));
    screen.cell(right, row, '│', BORDER);
  }

  const titleEnd = screen.text(x + 2, y, ` ${title} `, TEXT, undefined, width - 4);
  const rightLength = Array.from(rightText).length + 2;
  if (rightText && x + width - 2 - rightLength > titleEnd) {
    screen.text(x + width - 2 - rightLength, y, ` ${rightText} `, MUTED);
  }
}

// Bars rising from the floor, shaded from dim at the bottom to bright at the tip.
function drawColumn(screen, x, bottomY, height, fraction, colorAt) {
  const eighths = Math.max(1, Math.round(fraction * height * 8));
  const columnRows = eighths / 8;
  for (let row = 0; row < height; row++) {
    const cellEighths = Math.min(8, eighths - row * 8);
    if (cellEighths <= 0) return;
    const shade = 0.45 + 0.55 * Math.min(1, (row + 1) / columnRows);
    const color = scale(colorAt((row + cellEighths / 8) / height), shade);
    screen.cell(x, bottomY - row, VERTICAL_BLOCKS[cellEighths], color);
  }
}

const latencyFraction = ms => {
  const clamped = Math.max(CHART_FLOOR_MS, Math.min(CHART_CEILING_MS, ms));
  return Math.log(clamped / CHART_FLOOR_MS) / Math.log(CHART_CEILING_MS / CHART_FLOOR_MS);
};
const latencyAtFraction = fraction => CHART_FLOOR_MS * Math.pow(CHART_CEILING_MS / CHART_FLOOR_MS, fraction);

function secondBuckets(series, now, count) {
  const lastSecond = Math.floor(now / 1000);
  const buckets = Array.from({ length: count }, () => ({ worst: null, lost: 0, replies: 0 }));
  for (let i = series.samples.length - 1; i >= 0; i--) {
    const sample = series.samples[i];
    const index = count - 1 - (lastSecond - Math.floor(sample.at / 1000));
    if (index < 0) break;
    if (index >= count || sample.rtt === undefined) continue;
    const bucket = buckets[index];
    if (sample.rtt === null) bucket.lost++;
    else {
      bucket.replies++;
      bucket.worst = Math.max(bucket.worst ?? 0, sample.rtt);
    }
  }
  return buckets;
}

function drawLatencyChart(screen, x, y, width, height, series, now) {
  const gutter = 4;
  const chartX = x + gutter;
  const chartWidth = width - gutter;
  const bottomY = y + height - 1;
  if (chartWidth <= 0 || height <= 0) return;

  const usedRows = new Set();
  [[1000, '1s'], [100, '100'], [10, '10']].forEach(([ms, label]) => {
    const row = Math.min(height - 1, Math.floor(latencyFraction(ms) * height));
    if (usedRows.has(row)) return;
    usedRows.add(row);
    rightAligned(screen, x + gutter - 2, bottomY - row, label, FAINT);
    for (let col = 0; col < chartWidth; col++) screen.cell(chartX + col, bottomY - row, '┄', GRID);
  });

  secondBuckets(series, now, chartWidth).forEach((bucket, i) => {
    const col = chartX + i;
    if (bucket.lost > 0 && bucket.replies === 0) {
      screen.mapBackground(col, y, 1, height, () => LOST_BACKGROUND);
      for (let row = 0; row < height; row++) screen.cell(col, y + row, ' ', LOST_RED);
      screen.cell(col, y, '×', LOST_RED);
      return;
    }
    if (bucket.worst !== null) {
      drawColumn(screen, col, bottomY, height, latencyFraction(bucket.worst), fraction => latencyColor(latencyAtFraction(fraction)));
    }
    if (bucket.lost > 0) screen.cell(col, y, '×', LOST_RED);
  });
}

function drawLatencyPanel(screen, x, y, width, height, state, view, now) {
  drawBox(screen, x, y, width, height, 'LATENCY', 'log scale · worst reply per second');
  const innerX = x + 1;
  const innerWidth = width - 2;
  const entries = [
    { key: 'router', address: state.info.gateway ?? 'no gateway' },
    { key: 'cloudflare', address: '1.1.1.1' },
    { key: 'google', address: '8.8.8.8' },
  ];
  const innerHeight = height - 2;
  const chartRows = Math.floor((innerHeight - entries.length) / entries.length);
  let row = y + 1;

  entries.forEach(({ key, address }, i) => {
    const series = state.series[key];
    const summary = view.summaries[key];
    const healthColor = HEALTH_COLORS[view.health[key]];
    let cursor = screen.text(innerX + 1, row, '● ', healthColor);
    cursor = screen.text(cursor, row, series.label, TEXT);

    const lossText = `loss ${formatPct(summary.lossPct)}`;
    rightAligned(screen, innerX + innerWidth - 2, row, lossText, lossColor(summary.lossPct));

    const nowPart = `now ${formatMs(series.consecutiveLost ? null : series.lastRtt)}`;
    const p95Part = `p95 ${formatMs(summary.p95)}`;
    const maxPart = `max ${formatMs(summary.max)}`;
    const statsRight = innerX + innerWidth - 3 - lossText.length;
    const roomForStats = statsRight - cursor - 1;
    const stats = [`${nowPart}  ${p95Part}  ${maxPart}`, `${nowPart}  ${p95Part}`, nowPart, ''].find($_ => $_.length <= roomForStats) ?? '';
    rightAligned(screen, statsRight, row, stats, MUTED);

    if (address.length + 2 <= roomForStats - stats.length) screen.text(cursor + 1, row, address, FAINT);

    const rowsForThis = chartRows + (i === entries.length - 1 ? (innerHeight - entries.length) % entries.length : 0);
    drawLatencyChart(screen, innerX, row + 1, innerWidth, rowsForThis, series, now);
    row += rowsForThis + 1;
  });
}

function drawRatePanel(screen, x, y, width, height, title, arrow, values, color, rightText) {
  drawBox(screen, x, y, width, height, `${arrow} ${title}`, rightText, color);
  const chartHeight = height - 2;
  const chartWidth = width - 2;
  if (chartWidth <= 0 || chartHeight <= 0) return;

  const visible = values.slice(-chartWidth);
  const ceiling = Math.max(0.1, ...visible.map($_ => $_ ?? 0));
  visible.forEach((value, i) => {
    if (value === null || value <= 0) return;
    const col = x + 1 + (chartWidth - visible.length) + i;
    drawColumn(screen, col, y + chartHeight, chartHeight, value / ceiling, fraction => mix(scale(color, 0.7), color, fraction));
  });
}

function drawProbePanel(screen, x, y, width, height, state, rateText) {
  const latest = state.pulses[state.pulses.length - 1];
  let title = 'PROBE off';
  if (state.pulseEnabled) {
    if (!latest) title = 'PROBE';
    else if (latest.blocked) title = 'PROBE refused';
    else title = latest.ok ? `PROBE ${rateText(latest.mbps)}` : 'PROBE failed';
  }
  drawBox(screen, x, y, width, height, title, '', VIOLET);

  const chartHeight = height - 2;
  const chartWidth = width - 2;
  if (chartWidth <= 0 || chartHeight <= 0) return;

  const visible = state.pulses.slice(-chartWidth);
  const ceiling = Math.max(1, ...visible.map($_ => $_.mbps ?? 0));
  visible.forEach((pulse, i) => {
    const col = x + 1 + (chartWidth - visible.length) + i;
    if (pulse.blocked) {
      screen.cell(col, y + chartHeight, '?', FAINT);
      return;
    }
    if (pulse.mbps) {
      drawColumn(screen, col, y + chartHeight, chartHeight, pulse.mbps / ceiling, fraction => mix(scale(VIOLET, 0.7), VIOLET, fraction));
    }
    if (!pulse.ok) screen.cell(col, y + 1, '×', LOST_RED);
  });
}

function drawTrafficRow(screen, x, y, width, height, state, now) {
  const third = Math.floor(width / 3);
  const lastWidth = width - third * 2;
  const throughput = state.throughput;
  const peakSince = now - 5 * 60 * 1000;
  const chartColumns = third;
  const rateText = third >= 20 ? formatRate : formatRateShort;

  const downTitle = rateText(throughput.latest('down'));
  const downRight = width >= 75 ? `peak ${formatRate(throughput.peak('down', peakSince))}` : '';
  drawRatePanel(screen, x, y, third, height, downTitle, '▼', throughput.perSecond(now, chartColumns, 'down'), DOWN_COLOR, downRight);

  const upTitle = rateText(throughput.latest('up'));
  const upRight = width >= 75 ? `peak ${formatRate(throughput.peak('up', peakSince))}` : '';
  drawRatePanel(screen, x + third, y, third, height, upTitle, '▲', throughput.perSecond(now, chartColumns, 'up'), UP_COLOR, upRight);

  drawProbePanel(screen, x + third * 2, y, lastWidth, height, state, rateText);
}

function drawTable(screen, x, y, width, height, state, view) {
  drawBox(screen, x, y, width, height, 'LAST 60 SECONDS');
  const showSession = width >= 49; // below this the ALL column would cut into the longest name
  const columns = [
    { title: 'NOW', width: 5 },
    { title: 'P50', width: 5 },
    { title: 'P95', width: 5 },
    { title: 'MAX', width: 5 },
    { title: 'JIT', width: 5 },
    { title: 'LOSS', width: 5 },
    ...(showSession ? [{ title: 'ALL', width: 5 }] : []),
  ];
  const nameX = x + 2;
  const rightEdge = x + width - 3;
  const columnRights = [];
  let edge = rightEdge;
  [...columns].reverse().forEach(column => {
    columnRights.unshift(edge);
    edge -= column.width;
  });

  columns.forEach((column, i) => rightAligned(screen, columnRights[i], y + 1, column.title, FAINT));

  Object.keys(state.series).forEach((key, rowIndex) => {
    const row = y + 2 + rowIndex;
    if (row >= y + height - 1) return;
    const series = state.series[key];
    const summary = view.summaries[key];
    screen.text(nameX, row, series.label, HEALTH_COLORS[view.health[key]], undefined, edge - nameX + 1);

    const failing = series.consecutiveLost > 0;
    const latencyCell = ms => ({ text: formatMs(ms), color: ms === null ? FAINT : latencyColor(ms) });
    const totalProbes = series.replies + series.lost;
    const cells = [
      failing ? { text: '×', color: LOST_RED } : latencyCell(series.lastRtt),
      latencyCell(summary.p50),
      latencyCell(summary.p95),
      latencyCell(summary.max),
      { text: formatMs(summary.jitter), color: summary.jitter === null ? FAINT : MUTED },
      { text: formatPct(summary.lossPct), color: lossColor(summary.lossPct) },
    ];
    if (showSession) {
      const sessionPct = totalProbes ? (series.lost / totalProbes) * 100 : null;
      cells.push({ text: formatPct(sessionPct), color: lossColor(sessionPct) });
    }
    cells.forEach((cell, i) => rightAligned(screen, columnRights[i], row, cell.text, cell.color));
  });
}

function drawVitals(screen, x, y, width, height, state, view) {
  drawBox(screen, x, y, width, height, 'VITALS');
  const tcp = view.tcp;
  const resentColor = !tcp ? FAINT : tcp.resentPct >= 2 ? HEALTH_COLORS.bad : tcp.resentPct > 0.2 ? HEALTH_COLORS.warn : HEALTH_COLORS.good;
  const lines = [
    ['TCP resent, 60 s', tcp ? `${formatPct(tcp.resentPct)}  (${tcp.resent} of ${tcp.sent})` : '–', resentColor],
    ['TCP connects failed, 60 s', tcp ? String(tcp.failed) : '–', tcp?.failed ? HEALTH_COLORS.warn : MUTED],
    ['Outages this session', String(view.outageCount), view.outageCount ? HEALTH_COLORS.warn : HEALTH_COLORS.good],
    ['Longest outage', view.longestOutageMs ? formatDuration(view.longestOutageMs) : '–', view.longestOutageMs ? HEALTH_COLORS.warn : MUTED],
    ['Used by probes', `≈ ${formatBytes(state.probeBytes)}`, MUTED],
  ];
  lines.slice(0, height - 2).forEach(([label, value, color], i) => {
    screen.text(x + 2, y + 1 + i, label, MUTED, undefined, width - 4);
    rightAligned(screen, x + width - 3, y + 1 + i, value, color);
  });
}

function drawHistogram(screen, x, y, width, height, view) {
  drawBox(screen, x, y, width, height, 'DISTRIBUTION', 'internet · 5 min');
  const { counts, lost, total } = view.histogram;
  const labelWidth = 5;
  const valueWidth = 5;
  const barX = x + 2 + labelWidth + 1;
  const barWidth = width - 4 - labelWidth - valueWidth - 2;
  const pctOf = count => (total ? (count / total) * 100 : 0);
  const midpoints = [5, 15, 35, 70, 140, 350, 700, 1500];
  const rows = [
    ...HISTOGRAM_BUCKETS.map((bucket, i) => ({ label: bucket.label, count: counts[i], color: latencyColor(midpoints[i]) })),
    { label: 'lost', count: lost, color: LOST_RED },
  ];

  rows.slice(0, height - 2).forEach(({ label, count, color }, i) => {
    const row = y + 1 + i;
    screen.text(x + 2, row, label.padStart(labelWidth - 1), count ? TEXT : FAINT);
    const eighths = Math.round((pctOf(count) / 100) * barWidth * 8);
    const fullCells = Math.floor(eighths / 8);
    for (let col = 0; col < fullCells; col++) {
      screen.cell(barX + col, row, '█', mix(scale(color, 0.55), color, (col + 1) / Math.max(1, fullCells)));
    }
    if (eighths % 8) screen.cell(barX + fullCells, row, HORIZONTAL_BLOCKS[eighths % 8], color);
    if (count && eighths === 0) screen.cell(barX, row, '▏', color);
    rightAligned(screen, x + width - 3, row, total ? `${Math.round(pctOf(count))}%` : '–', count ? TEXT : FAINT);
  });
}

function drawEvents(screen, x, y, width, height, state) {
  drawBox(screen, x, y, width, height, 'EVENTS', state.events.length ? `${state.events.length}` : '');
  const rows = height - 2;
  if (state.events.length === 0) {
    screen.text(x + 2, y + 1, 'Nothing yet.', FAINT, undefined, width - 4);
    return;
  }
  state.events.slice(-rows).reverse().forEach((event, i) => {
    const row = y + 1 + i;
    const color = HEALTH_COLORS[event.level] ?? MUTED;
    const fade = i < 3 ? 1 : Math.max(0.6, 1 - (i - 2) * 0.05);
    const after = screen.text(x + 2, row, clockOf(event.at), FAINT);
    screen.text(after + 1, row, event.text, scale(color, fade), undefined, x + width - 2 - after - 1);
  });
}

function heatCells(series, now, count) {
  const lastCell = Math.floor(now / HEAT_CELL_MS);
  const cells = Array.from({ length: count }, () => ({ total: 0, lost: 0, worst: 0 }));
  for (let i = series.samples.length - 1; i >= 0; i--) {
    const sample = series.samples[i];
    const index = count - 1 - (lastCell - Math.floor(sample.at / HEAT_CELL_MS));
    if (index < 0) break;
    if (index >= count || sample.rtt === undefined) continue;
    cells[index].total++;
    if (sample.rtt === null) cells[index].lost++;
    else cells[index].worst = Math.max(cells[index].worst, sample.rtt);
  }
  return cells;
}

function drawHeatmap(screen, x, y, width, height, state, now) {
  const labelWidth = 12;
  const cellCount = width - 3 - labelWidth;
  const minutes = Math.round((cellCount * HEAT_CELL_MS) / 60000);
  drawBox(screen, x, y, width, height, 'STABILITY OVER TIME', `10 s per cell · last ${minutes} min · red = lost packets`);
  if (cellCount <= 0) return;

  ['router', 'cloudflare', 'google'].slice(0, height - 2).forEach((key, rowIndex) => {
    const row = y + 1 + rowIndex;
    screen.text(x + 2, row, state.series[key].label, MUTED, undefined, labelWidth - 1);
    heatCells(state.series[key], now, cellCount).forEach((cell, i) => {
      const col = x + 1 + labelWidth + i;
      let color = EMPTY_HEAT;
      if (cell.lost > 0) color = mix(rgb(120, 20, 45), LOST_RED, Math.min(1, cell.lost / cell.total * 3));
      else if (cell.total > 0) color = scale(latencyColor(cell.worst), 0.72);
      screen.cell(col, row, ' ', color, color);
    });
  });
}

function drawDigits(screen, x, y, value, colorTop, colorBottom) {
  Array.from(value).forEach((digit, digitIndex) => {
    const glyph = DIGITS[digit];
    const originX = x + digitIndex * 5;
    for (let col = 0; col < 4; col++) {
      for (let cellRow = 0; cellRow < 3; cellRow++) {
        const topOn = glyph[cellRow * 2][col] === '#';
        const bottomOn = glyph[cellRow * 2 + 1][col] === '#';
        const topColor = mix(colorTop, colorBottom, (cellRow * 2) / 5);
        const bottomColor = mix(colorTop, colorBottom, (cellRow * 2 + 1) / 5);
        if (topOn && bottomOn) screen.cell(originX + col, y + cellRow, '▀', topColor, bottomColor);
        else if (topOn) screen.cell(originX + col, y + cellRow, '▀', topColor);
        else if (bottomOn) screen.cell(originX + col, y + cellRow, '▄', bottomColor);
      }
    }
  });
}

function drawStability(screen, x, y, width, height, view) {
  const verdictColor = VERDICT_COLORS[view.verdict];
  drawBox(screen, x, y, width, height, 'STABILITY', '', verdictColor);

  const value = view.score === null ? '--' : String(view.score);
  const digitsWidth = value.length * 5 - 1;
  const digitsX = x + 2;
  drawDigits(screen, digitsX, y + 1, value, mix(verdictColor, rgb(255, 255, 255), 0.45), scale(verdictColor, 0.75));

  const textX = digitsX + Math.max(digitsWidth, 9) + 2;
  const textWidth = x + width - 2 - textX;
  screen.text(textX, y + 1, view.verdict, verdictColor, undefined, textWidth);
  screen.text(textX, y + 2, `clean ${formatDuration(view.cleanForMs)}`, MUTED, undefined, textWidth);
  screen.text(textX, y + 3, `replies ${view.uptimePct === null ? '–' : `${view.uptimePct.toFixed(1)}%`}`, MUTED, undefined, textWidth);

  const gaugeWidth = width - 4;
  const filledEighths = view.score === null ? 0 : Math.round((view.score / 100) * gaugeWidth * 8);
  for (let col = 0; col < gaugeWidth; col++) {
    const position = (col + 1) / gaugeWidth;
    const gradient = position < 0.5
      ? mix(HEALTH_COLORS.bad, HEALTH_COLORS.warn, position * 2)
      : mix(HEALTH_COLORS.warn, HEALTH_COLORS.good, (position - 0.5) * 2);
    const cellEighths = Math.max(0, Math.min(8, filledEighths - col * 8));
    screen.cell(x + 2 + col, y + 4, cellEighths ? HORIZONTAL_BLOCKS[cellEighths] : '─', cellEighths ? gradient : GRID);
  }
}

function layersOf(state, view) {
  const { summaries, health, routerIgnoresPings } = view;
  const valueOf = key => {
    const summary = summaries[key];
    if (!summary.count) return '…';
    if (summary.p50 === null) return 'DOWN';
    const latency = `${formatMs(summary.p50)}ms`;
    return summary.lossPct > 0 ? `${latency} ${formatPct(summary.lossPct)}` : latency;
  };
  // When latency and loss don't both fit under a node, loss is the one that matters.
  const shortValueOf = key => {
    const summary = summaries[key];
    return summary.lossPct > 0 ? formatPct(summary.lossPct) : valueOf(key);
  };
  let pcHealth = 'unknown';
  if (state.info.gatewayChecked) pcHealth = state.info.gateway ? 'good' : 'bad';

  const linkSpeed = formatLinkSpeed(state.info.linkBps).replace(' Gbit', 'G').replace(' Mbit', 'M');
  const measured = (label, key) => ({ label, health: health[key], value: valueOf(key), shortValue: shortValueOf(key) });

  return [
    { label: 'THIS PC', health: pcHealth, value: linkSpeed, shortValue: linkSpeed },
    routerIgnoresPings
      ? { label: 'ROUTER', health: health.router, value: 'no ping', shortValue: 'no ping' }
      : measured('ROUTER', 'router'),
    { ...measured('INTERNET', 'internet'), health: view.realTrafficClean && health.internet === 'bad' ? 'warn' : health.internet },
    measured('TCP', 'tcp'),
    measured('DNS', 'dns'),
    measured('HTTPS', 'https'),
  ];
}

function drawChain(screen, x, y, width, height, state, view, now) {
  drawBox(screen, x, y, width, height, 'SIGNAL PATH');
  const innerX = x + 1;
  const innerWidth = width - 2;
  const layers = layersOf(state, view);
  const step = innerWidth / layers.length;
  const centerOf = i => Math.floor(innerX + step * i + step / 2);

  layers.forEach((layer, i) => {
    const color = HEALTH_COLORS[layer.health];
    const center = centerOf(i);
    const slotX = Math.floor(innerX + step * i);
    centered(screen, slotX, Math.floor(step), y + 1, layer.label, layer.health === 'unknown' ? MUTED : TEXT);
    const slotWidth = Math.floor(step);
    centered(screen, slotX, slotWidth, y + 3, layer.value.length < slotWidth ? layer.value : layer.shortValue, color);

    if (i < layers.length - 1) {
      const next = layers[i + 1];
      const nextColor = HEALTH_COLORS[next.health];
      const from = center + 1;
      const length = centerOf(i + 1) - from;
      const packetAt = Math.floor(((now / 1100 + i * 0.37) % 1) * length);
      for (let col = 0; col < length; col++) {
        const link = mix(color, nextColor, (col + 1) / (length + 1));
        const isPacket = col === packetAt && next.health !== 'bad';
        screen.cell(from + col, y + 2, isPacket ? '━' : '─', isPacket ? mix(link, rgb(255, 255, 255), 0.6) : scale(link, 0.55));
      }
    }

    const glow = layer.health === 'bad' ? 0.65 + 0.35 * Math.sin(now / 180) : 1;
    screen.cell(center, y + 2, layer.health === 'bad' ? '×' : '●', scale(color, glow));
  });

  const diagnosisColor = HEALTH_COLORS[view.diagnosis.level];
  centered(screen, innerX, innerWidth, y + 4, view.diagnosis.text, diagnosisColor);
}

function drawTitle(screen, width, state, view, now) {
  const accent = VERDICT_COLORS[view.verdict];
  const name = ' NETXRAY ';
  const shimmerAt = ((now / 90) % (name.length + 30)) - 5;
  Array.from(name).forEach((char, i) => {
    const glow = Math.max(0, 1 - Math.abs(i - shimmerAt) / 3);
    const base = mix(ACCENT, VIOLET, i / name.length);
    screen.cell(i, 0, char, mix(base, rgb(255, 255, 255), 0.25 + glow * 0.75));
  });

  const session = formatDuration(now - state.startedAt);
  rightAligned(screen, width - 2, 0, `${clockOf(now)}  session ${session}`, MUTED);

  const { info } = state;
  const fields = [['LINK', info.adapter ? `${info.adapter}, ${formatLinkSpeed(info.linkBps)}` : '–']];
  if (info.wifi) {
    fields.push(['WI-FI', [info.wifi.ssid ?? '?', info.wifi.signal, info.wifi.band].filter(Boolean).join(' ')]);
  }
  fields.push(['GATEWAY', info.gateway ?? '–']);
  fields.push(['UPLINK', [info.carrier, info.place].filter(Boolean).join(', ') || '–']);
  fields.push(['EDGE', info.edge ?? '–']);

  let cursor = screen.text(1, 1, '', MUTED);
  fields.forEach(([label, value]) => {
    if (cursor >= width - 1) return;
    cursor = screen.text(cursor, 1, `${label} `, scale(accent, 0.8), undefined, width - 1 - cursor);
    cursor = screen.text(cursor, 1, value, TEXT, undefined, width - 1 - cursor);
    cursor += 3;
  });
}

function drawFooter(screen, width, height, state) {
  const y = height - 1;
  const pulse = state.pulseEnabled ? 'on, 250 kB per 10 s' : 'off';
  const parts = [['q', 'quit'], ['p', `download probe ${pulse}`], ['r', 'reset']];
  let cursor = 1;
  parts.forEach(([key, label]) => {
    cursor = screen.text(cursor, y, key, ACCENT, undefined, width - 1 - cursor);
    cursor = screen.text(cursor + 1, y, label, FAINT, undefined, width - 1 - cursor);
    cursor += 3;
  });
}

function drawBeam(screen, now) {
  const phase = (now % BEAM_CYCLE_MS) / BEAM_CYCLE_MS;
  const center = phase * (screen.width + 24) - 12;
  for (let col = Math.floor(center - 7); col <= center + 7; col++) {
    const strength = Math.exp(-(((col - center) / 3.5) ** 2));
    const green = Math.round(14 * strength);
    const blue = Math.round(22 * strength);
    if (green > 0 || blue > 0) screen.mapBackground(col, 0, 1, screen.height, $_ => add($_, 0, green, blue));
  }
}

function drawTooSmall(screen) {
  const message = `Needs ${MIN_WIDTH}×${MIN_HEIGHT}, has ${screen.width}×${screen.height}`;
  centered(screen, 0, screen.width, Math.floor(screen.height / 2), message, TEXT);
}

export function renderFrame(screen, state, now) {
  const { width, height } = screen;
  const top = rgb(11, 17, 32);
  const bottom = rgb(4, 6, 13);
  screen.fillBackground(y => mix(top, bottom, y / Math.max(1, height - 1)));

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    drawTooSmall(screen);
    return;
  }

  const view = buildView(state, now);
  drawTitle(screen, width, state, view, now);

  const heroY = 2;
  const heroHeight = 6;
  const stabilityWidth = 38;
  drawStability(screen, 0, heroY, stabilityWidth, heroHeight, view);
  drawChain(screen, stabilityWidth, heroY, width - stabilityWidth, heroHeight, state, view, now);

  const footerY = height - 1;
  const heatHeight = 5;
  const mainY = heroY + heroHeight;
  const mainHeight = footerY - heatHeight - mainY;
  drawHeatmap(screen, 0, footerY - heatHeight, width, heatHeight, state, now);

  const rightWidth = Math.max(44, Math.round(width * 0.36));
  const leftWidth = width - rightWidth;
  const trafficHeight = Math.max(4, Math.min(10, Math.round(mainHeight * 0.28)));
  drawLatencyPanel(screen, 0, mainY, leftWidth, mainHeight - trafficHeight, state, view, now);
  drawTrafficRow(screen, 0, mainY + mainHeight - trafficHeight, leftWidth, trafficHeight, state, now);

  const tableHeight = 9;
  const vitalsHeight = 7;
  const histogramHeight = 11;
  const minEventsHeight = 5;
  const rightX = leftWidth;
  let rightY = mainY;
  let remaining = mainHeight;

  drawTable(screen, rightX, rightY, rightWidth, tableHeight, state, view);
  rightY += tableHeight;
  remaining -= tableHeight;

  if (remaining >= vitalsHeight + minEventsHeight) {
    drawVitals(screen, rightX, rightY, rightWidth, vitalsHeight, state, view);
    rightY += vitalsHeight;
    remaining -= vitalsHeight;
  }
  if (remaining >= histogramHeight + minEventsHeight) {
    drawHistogram(screen, rightX, rightY, rightWidth, histogramHeight, view);
    rightY += histogramHeight;
    remaining -= histogramHeight;
  }
  drawEvents(screen, rightX, rightY, rightWidth, remaining, state);

  drawFooter(screen, width, height, state);
  drawBeam(screen, now);
}
