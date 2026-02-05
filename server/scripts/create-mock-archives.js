import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVES_DIR = path.join(__dirname, '../archives');

const WIDTH = 1300;
const HEIGHT = 900;
const COLORS = ['white', 'black', 'red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'orange', 'purple', 'pink', 'brown', 'gray', 'silver', 'gold', 'teal'];

function createEmptyCanvas() {
  const colors = [];
  for (let y = 0; y < HEIGHT; y++) {
    const row = [];
    for (let x = 0; x < WIDTH; x++) {
      row.push('white');
    }
    colors.push(row);
  }
  return colors;
}

function drawRect(colors, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
        colors[py][px] = color;
      }
    }
  }
}

function drawCircle(colors, cx, cy, radius, color) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius && x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        colors[y][x] = color;
      }
    }
  }
}

function addNoise(colors, density = 0.01) {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (Math.random() < density) {
        colors[y][x] = COLORS[Math.floor(Math.random() * COLORS.length)];
      }
    }
  }
}

// Day 1: Simple shapes - circles and rectangles
function createDay1() {
  const colors = createEmptyCanvas();

  // Red circle
  drawCircle(colors, 300, 400, 100, 'red');

  // Blue rectangle
  drawRect(colors, 600, 300, 200, 200, 'blue');

  // Yellow circle
  drawCircle(colors, 1000, 450, 80, 'yellow');

  // Green stripe
  drawRect(colors, 0, 800, WIDTH, 50, 'green');

  addNoise(colors, 0.005);
  return colors;
}

// Day 2: Flag-like patterns
function createDay2() {
  const colors = createEmptyCanvas();

  // French flag style
  drawRect(colors, 100, 200, 150, 300, 'blue');
  drawRect(colors, 250, 200, 150, 300, 'white');
  drawRect(colors, 400, 200, 150, 300, 'red');

  // Japanese flag style
  drawRect(colors, 700, 200, 400, 280, 'white');
  drawCircle(colors, 900, 340, 70, 'red');

  addNoise(colors, 0.008);
  return colors;
}

// Day 3: Rainbow stripes
function createDay3() {
  const colors = createEmptyCanvas();

  const rainbowColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  const stripeHeight = 80;

  for (let i = 0; i < rainbowColors.length; i++) {
    drawRect(colors, 200, 200 + i * stripeHeight, 900, stripeHeight, rainbowColors[i]);
  }

  addNoise(colors, 0.01);
  return colors;
}

// Day 4: Pixel art smiley
function createDay4() {
  const colors = createEmptyCanvas();

  // Face
  drawCircle(colors, 650, 450, 200, 'yellow');

  // Eyes
  drawCircle(colors, 580, 380, 25, 'black');
  drawCircle(colors, 720, 380, 25, 'black');

  // Smile (approximate with rectangles)
  drawRect(colors, 550, 520, 200, 20, 'black');
  drawRect(colors, 530, 500, 30, 20, 'black');
  drawRect(colors, 740, 500, 30, 20, 'black');

  addNoise(colors, 0.006);
  return colors;
}

// Day 5: Abstract chaos
function createDay5() {
  const colors = createEmptyCanvas();

  // Random circles everywhere
  for (let i = 0; i < 50; i++) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);
    const r = 20 + Math.floor(Math.random() * 60);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    drawCircle(colors, x, y, r, color);
  }

  addNoise(colors, 0.02);
  return colors;
}

// Create archives
const archives = [];
const generators = [createDay5, createDay4, createDay3, createDay2, createDay1];
const dayMs = 24 * 60 * 60 * 1000;

// Create 5 mock archives, each 1 day apart
for (let i = 0; i < generators.length; i++) {
  const timestamp = Date.now() - (i + 1) * dayMs;
  const id = `archive_${timestamp}`;
  const filename = `${id}.json`;

  const colors = generators[i]();
  const state = { colors, width: WIDTH, height: HEIGHT };

  fs.writeFileSync(path.join(ARCHIVES_DIR, filename), JSON.stringify(state));

  archives.push({ id, timestamp, filename });
  console.log(`Created archive: ${id} (Day -${i + 1})`);
}

// Save index
fs.writeFileSync(path.join(ARCHIVES_DIR, 'index.json'), JSON.stringify(archives, null, 2));
console.log('Created index.json with', archives.length, 'archives');
