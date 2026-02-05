const COLORS = {
  white: '#FFFFFF',
  black: '#000000',
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  cyan: '#00FFFF',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  brown: '#A52A2A',
  gray: '#808080',
  silver: '#C0C0C0',
  gold: '#FFD700',
  teal: '#00CED1',
};

class ArtboardViewer {
  constructor() {
    this.canvas = document.getElementById('artboard');
    this.ctx = this.canvas.getContext('2d');
    this.pixelInfo = document.getElementById('pixel-info');
    this.pixelCoords = document.getElementById('pixel-coords');
    this.pixelColor = document.getElementById('pixel-color');
    this.pixelBot = document.getElementById('pixel-bot');
    this.dateLabel = document.getElementById('date-label');
    this.prevBtn = document.getElementById('prev-btn');
    this.nextBtn = document.getElementById('next-btn');

    this.canvasData = null;
    this.archives = [];
    this.currentIndex = -1; // -1 means live view
    this.isLive = true;
    this.countdown = document.getElementById('countdown');
    this.resetTime = null;
    this._fetchDebounce = null;
    this._lastFetchCoords = null;

    this.setupCanvas();
    this.setupSocket();
    this.setupNavigation();
    this.loadArchives();
    this.loadResetTime();
  }

  setupCanvas() {
    this.canvas.width = 1300;
    this.canvas.height = 900;

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.canvasData) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);

        if (x >= 0 && x < 1300 && y >= 0 && y < 900) {
          this.showPixelInfo(x, y, e.clientX, e.clientY);
        }
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.pixelInfo.classList.add('hidden');
    });
  }

  setupSocket() {
    this.socket = io();

    this.socket.on('canvas', (data) => {
      if (this.isLive) {
        this.canvasData = data;
        this.renderCanvas(data);
        this.setLiveLabel();
      }
    });

    this.socket.on('pixel', (data) => {
      if (this.isLive) {
        this.updatePixel(data);
      }
    });
  }

  setupNavigation() {
    // Left arrow = go back in time (older archives)
    this.prevBtn.addEventListener('click', () => this.navigate(1));
    // Right arrow = go forward in time (towards live)
    this.nextBtn.addEventListener('click', () => this.navigate(-1));
    this.updateNavButtons();
  }

  async loadArchives() {
    try {
      const res = await fetch('/api/archives');
      const data = await res.json();
      this.archives = data.archives || [];
      this.updateNavButtons();
    } catch (e) {
      console.error('Failed to load archives:', e);
    }
  }

  navigate(direction) {
    const newIndex = this.currentIndex + direction;

    if (newIndex < -1) return;
    if (newIndex >= this.archives.length) return;

    this.currentIndex = newIndex;
    this.isLive = (newIndex === -1);

    if (this.isLive) {
      this.socket.emit('requestCanvas');
      this.setLiveLabel();
    } else {
      this.loadArchive(this.archives[newIndex]);
    }

    this.updateNavButtons();
  }

  async loadArchive(archive) {
    try {
      const res = await fetch(`/api/archives/${archive.id}`);
      const data = await res.json();
      this.canvasData = data;
      this.renderCanvas(data);

      const date = new Date(archive.timestamp);
      this.dateLabel.textContent = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch (e) {
      console.error('Failed to load archive:', e);
    }
  }

  updateNavButtons() {
    // Left (prev) disabled when at oldest archive
    this.prevBtn.disabled = this.currentIndex >= this.archives.length - 1;
    // Right (next) disabled when at live view
    this.nextBtn.disabled = this.currentIndex <= -1;
  }

  renderCanvas(data) {
    const { colors, width, height } = data;
    const imageData = this.ctx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colorName = colors[y][x];
        const hex = COLORS[colorName] || '#FFFFFF';
        const rgb = this.hexToRgb(hex);
        const i = (y * width + x) * 4;
        imageData.data[i] = rgb.r;
        imageData.data[i + 1] = rgb.g;
        imageData.data[i + 2] = rgb.b;
        imageData.data[i + 3] = 255;
      }
    }

    this.ctx.putImageData(imageData, 0, 0);
  }

  updatePixel(data) {
    if (!this.canvasData) return;

    const { x, y, color } = data;
    this.canvasData.colors[y][x] = color;

    const hex = COLORS[color] || '#FFFFFF';
    const rgb = this.hexToRgb(hex);

    const imageData = this.ctx.createImageData(1, 1);
    imageData.data[0] = rgb.r;
    imageData.data[1] = rgb.g;
    imageData.data[2] = rgb.b;
    imageData.data[3] = 255;

    this.ctx.putImageData(imageData, x, y);
  }

  showPixelInfo(x, y, mouseX, mouseY) {
    const color = this.canvasData.colors[y][x];
    const hex = COLORS[color];

    this.pixelCoords.textContent = `(${x}, ${y})`;
    this.pixelColor.textContent = color;
    this.pixelColor.style.color = hex === '#FFFFFF' ? '#000' : hex;
    this.pixelInfo.style.left = `${mouseX + 12}px`;
    this.pixelInfo.style.top = `${mouseY + 12}px`;
    this.pixelInfo.classList.remove('hidden');

    // Debounce bot name fetch to avoid spamming the API
    if (this.isLive && color !== 'white') {
      const coordKey = `${x},${y}`;
      if (this._lastFetchCoords !== coordKey) {
        this.pixelBot.textContent = '';
        this._lastFetchCoords = coordKey;
        clearTimeout(this._fetchDebounce);
        this._fetchDebounce = setTimeout(async () => {
          try {
            const res = await fetch(`/api/pixel/${x}/${y}`);
            const data = await res.json();
            if (this._lastFetchCoords === coordKey) {
              this.pixelBot.textContent = data.botName ? `by ${data.botName}` : '';
            }
          } catch {
            // ignore
          }
        }, 150);
      }
    } else {
      this.pixelBot.textContent = '';
      this._lastFetchCoords = null;
    }
  }

  setLiveLabel() {
    this.dateLabel.innerHTML = '<span class="live-dot"></span> Live';
  }

  async loadResetTime() {
    try {
      const res = await fetch('/api/reset-time');
      const data = await res.json();
      this.resetTime = data.resetTime;
      this.startCountdown();
    } catch (e) {
      console.error('Failed to load reset time:', e);
    }
  }

  startCountdown() {
    setInterval(() => {
      if (!this.resetTime) return;

      const now = Date.now();
      const remaining = this.resetTime - now;

      if (remaining <= 0) {
        this.countdown.textContent = '00:00:00';
        // Reload page after reset
        setTimeout(() => location.reload(), 2000);
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

      this.countdown.textContent =
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
  }

  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 255, g: 255, b: 255 };
  }
}

new ArtboardViewer();
