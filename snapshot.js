// Renders one frame to an HTML file, to look at the page without a terminal.
// node snapshot.js out.html 160x50 --demo          12 minutes of made-up data
// node snapshot.js out.html 160x50 --seconds=30    real probes for 30 seconds

import { writeFileSync } from 'node:fs';
import { createDemo } from './demo.js';
import { renderFrame } from './panels.js';
import { startProbes } from './probes.js';
import { Screen } from './screen.js';
import { createState } from './stats.js';

const hex = color => `#${color.toString(16).padStart(6, '0')}`;
const escapeHtml = char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char);

const VERTICAL_BLOCKS = ' ▁▂▃▄▅▆▇█';
const HORIZONTAL_BLOCKS = ' ▏▎▍▌▋▊▉█';

// Terminals draw block characters edge to edge, but browser fonts leave gaps, so blocks are painted instead.
function cellHtml(char, fg, bg) {
  const paint = (direction, percent) => `<i style="background:linear-gradient(to ${direction},${fg} ${percent}%,${bg} ${percent}%)"></i>`;
  if (char === '▀') return paint('bottom', 50);
  if (char !== ' ' && VERTICAL_BLOCKS.includes(char)) return paint('top', VERTICAL_BLOCKS.indexOf(char) * 12.5);
  if (char !== ' ' && HORIZONTAL_BLOCKS.includes(char)) return paint('right', HORIZONTAL_BLOCKS.indexOf(char) * 12.5);
  return `<i style="color:${fg};background:${bg}">${escapeHtml(char)}</i>`;
}

function screenToHtml(screen) {
  const rows = [];
  for (let y = 0; y < screen.height; y++) {
    let row = '';
    for (let x = 0; x < screen.width; x++) {
      const index = y * screen.width + x;
      row += cellHtml(screen.chars[index], hex(screen.fg[index]), hex(screen.bg[index]));
    }
    rows.push(`<div>${row}</div>`);
  }
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#000}
    div{height:20px;white-space:pre;font:15px/20px 'Cascadia Mono','Consolas',monospace}
    i{display:inline-block;width:9px;height:20px;font-style:normal;overflow:hidden;vertical-align:top}
  </style>${rows.join('')}`;
}

const [outputPath, size] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const seconds = Number(process.argv.find($_ => $_.startsWith('--seconds='))?.split('=')[1] ?? 0);
const now = Date.now();

function write(state) {
  const screen = new Screen(width, height);
  renderFrame(screen, state, Date.now());
  writeFileSync(outputPath, screenToHtml(screen));
}

if (process.argv.includes('--demo')) {
  const state = createState(now - 12 * 60 * 1000);
  createDemo(state, state.startedAt)(now);
  write(state);
} else {
  const state = createState(now);
  const stop = startProbes(state);
  setTimeout(() => {
    write(state);
    stop();
    process.exit(0);
  }, seconds * 1000);
}
