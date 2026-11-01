// A grid of cells, plus the diff that turns one grid into the next with as few bytes as possible.

export const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
const redOf = color => (color >> 16) & 255;
const greenOf = color => (color >> 8) & 255;
const blueOf = color => color & 255;

export function mix(from, to, amount) {
  const blend = (a, b) => Math.round(a + (b - a) * amount);
  return rgb(blend(redOf(from), redOf(to)), blend(greenOf(from), greenOf(to)), blend(blueOf(from), blueOf(to)));
}

export function scale(color, factor) {
  const limit = value => Math.min(255, Math.round(value * factor));
  return rgb(limit(redOf(color)), limit(greenOf(color)), limit(blueOf(color)));
}

export function add(color, r, g, b) {
  return rgb(Math.min(255, redOf(color) + r), Math.min(255, greenOf(color) + g), Math.min(255, blueOf(color) + b));
}

export class Screen {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.chars = new Array(width * height).fill(' ');
    this.fg = new Int32Array(width * height);
    this.bg = new Int32Array(width * height);
  }

  cell(x, y, char, fg, bg) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = y * this.width + x;
    this.chars[index] = char;
    if (fg !== undefined) this.fg[index] = fg;
    if (bg !== undefined) this.bg[index] = bg;
  }

  // Writes at most maxWidth characters and returns the x just after them.
  text(x, y, string, fg, bg, maxWidth = Infinity) {
    const chars = Array.from(string).slice(0, Math.max(0, maxWidth));
    chars.forEach((char, i) => this.cell(x + i, y, char, fg, bg));
    return x + chars.length;
  }

  fillBackground(colorOfRow) {
    for (let y = 0; y < this.height; y++) {
      const color = colorOfRow(y);
      for (let x = 0; x < this.width; x++) {
        const index = y * this.width + x;
        this.chars[index] = ' ';
        this.fg[index] = color;
        this.bg[index] = color;
      }
    }
  }

  mapBackground(x, y, width, height, transform) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + width); col++) {
        const index = row * this.width + col;
        this.bg[index] = transform(this.bg[index]);
      }
    }
  }
}

const moveTo = (x, y) => `\x1b[${y + 1};${x + 1}H`;
const foreground = color => `\x1b[38;2;${redOf(color)};${greenOf(color)};${blueOf(color)}m`;
const background = color => `\x1b[48;2;${redOf(color)};${greenOf(color)};${blueOf(color)}m`;

function looksSame(next, previous, index) {
  if (next.chars[index] !== previous.chars[index] || next.bg[index] !== previous.bg[index]) return false;
  return next.chars[index] === ' ' || next.fg[index] === previous.fg[index];
}

// With no previous screen, or one of another size, every cell is drawn.
export function diffToAnsi(next, previous) {
  const sameSize = previous && previous.width === next.width && previous.height === next.height;
  let output = '';
  let cursorX = -1;
  let cursorY = -1;
  let currentFg = null;
  let currentBg = null;

  for (let y = 0; y < next.height; y++) {
    for (let x = 0; x < next.width; x++) {
      const index = y * next.width + x;
      if (sameSize && looksSame(next, previous, index)) continue;

      if (x !== cursorX || y !== cursorY) output += moveTo(x, y);
      if (next.fg[index] !== currentFg) { output += foreground(next.fg[index]); currentFg = next.fg[index]; }
      if (next.bg[index] !== currentBg) { output += background(next.bg[index]); currentBg = next.bg[index]; }
      output += next.chars[index];
      cursorX = x + 1;
      cursorY = y;
    }
  }
  return output ? `${output}\x1b[0m` : '';
}
