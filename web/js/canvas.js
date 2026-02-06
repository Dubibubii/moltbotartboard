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
    this.snapshotTime = null;
    this.canvasWrapper = document.getElementById('canvas-wrapper');
    this.zoomInBtn = document.getElementById('zoom-in');
    this.zoomOutBtn = document.getElementById('zoom-out');

    // Tooltip debouncing state
    this.pendingPixelX = null;
    this.pendingPixelY = null;
    this.pixelInfoTimer = null;

    // Zoom state
    this.zoomLevels = [1, 1.5, 2, 3, 4, 6, 8];
    this.zoomIndex = 0;

    // Active bots
    this.activeBots = document.getElementById('active-bots-count');

    // Pulse bar state
    this.pulseCanvas = document.getElementById('pulse-bar');
    this.pulseCtx = this.pulseCanvas ? this.pulseCanvas.getContext('2d') : null;
    this.pulseBars = new Array(40).fill(0); // 40 time slots
    this.pulseCurrentSlot = 0; // pixels in current slot

    // Chat elements
    this.chatMessages = document.getElementById('chat-messages');

    this.setupCanvas();
    this.setupSocket();
    this.setupNavigation();
    this.setupZoom();
    if (this.pulseCanvas) this.setupPulseBar();
    this.loadArchives();
    this.loadSnapshotTime();
    this.loadActiveBots();
    this.loadChat();
    setInterval(() => this.loadActiveBots(), 30000);
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
      this.pendingPixelX = null;
      this.pendingPixelY = null;
      if (this.pixelInfoTimer) clearTimeout(this.pixelInfoTimer);
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
        this.pulseCurrentSlot++;
      }
    });

    this.socket.on('chat', (msg) => {
      this.appendChatMessage(msg);
    });

    this.socket.on('chatHistory', (messages) => {
      this.chatMessages.innerHTML = '';
      messages.forEach(msg => this.appendChatMessage(msg));
    });

    // Re-request canvas after reconnecting to avoid stale state
    this.socket.on('connect', () => {
      if (this.isLive && this.canvasData) {
        this.socket.emit('requestCanvas');
      }
    });
  }

  setupZoom() {
    // Pan offset in canvas pixels (before zoom)
    this.panX = 650; // center of 1300
    this.panY = 450; // center of 900

    this.zoomInBtn.addEventListener('click', () => {
      if (this.zoomIndex < this.zoomLevels.length - 1) {
        this.zoomIndex++;
        this.applyZoom();
      }
    });

    this.zoomOutBtn.addEventListener('click', () => {
      if (this.zoomIndex > 0) {
        this.zoomIndex--;
        this.applyZoom();
      }
    });

    // Drag-to-pan when zoomed
    let isDragging = false;
    let startX, startY, startPanX, startPanY;

    this.canvasWrapper.addEventListener('mousedown', (e) => {
      if (this.zoomIndex === 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = this.panX;
      startPanY = this.panY;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const zoom = this.zoomLevels[this.zoomIndex];
      const rect = this.canvas.getBoundingClientRect();
      // Convert pixel drag distance to canvas coordinates
      const scaleX = 1300 / rect.width;
      const scaleY = 900 / rect.height;
      this.panX = startPanX - (e.clientX - startX) * scaleX;
      this.panY = startPanY - (e.clientY - startY) * scaleY;
      this.clampPan();
      this.applyZoom();
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  clampPan() {
    const zoom = this.zoomLevels[this.zoomIndex];
    const halfW = 650 / zoom;
    const halfH = 450 / zoom;
    this.panX = Math.max(halfW, Math.min(1300 - halfW, this.panX));
    this.panY = Math.max(halfH, Math.min(900 - halfH, this.panY));
  }

  applyZoom() {
    const zoom = this.zoomLevels[this.zoomIndex];

    this.clampPan();

    if (zoom <= 1) {
      this.canvas.style.transformOrigin = '';
      this.canvas.style.transform = '';
    } else {
      // Top-left of viewport in canvas coordinates
      const vpLeft = this.panX - 650 / zoom;
      const vpTop = this.panY - 450 / zoom;

      // Translate as percentage of canvas size, then scale from top-left
      const txPct = -(vpLeft / 1300) * 100;
      const tyPct = -(vpTop / 900) * 100;

      this.canvas.style.transformOrigin = '0 0';
      this.canvas.style.transform = `scale(${zoom}) translate(${txPct}%, ${tyPct}%)`;
    }

    this.zoomInBtn.disabled = this.zoomIndex >= this.zoomLevels.length - 1;
    this.zoomOutBtn.disabled = this.zoomIndex <= 0;
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

      // Check for ?archive= query parameter (linked from gallery)
      const params = new URLSearchParams(window.location.search);
      const archiveId = params.get('archive');
      if (archiveId && !this._archiveParamHandled) {
        this._archiveParamHandled = true;
        const index = this.archives.findIndex(a => a.id === archiveId);
        if (index !== -1) {
          this.currentIndex = index;
          this.isLive = false;
          this.loadArchive(this.archives[index]);
          this.updateNavButtons();
        }
      }
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

    // Debounce bot name fetch - only fetch if coords changed
    if (this.pendingPixelX === x && this.pendingPixelY === y) return;

    this.pendingPixelX = x;
    this.pendingPixelY = y;
    this.pixelBot.textContent = '';

    if (this.pixelInfoTimer) clearTimeout(this.pixelInfoTimer);

    if (this.isLive && color !== 'white') {
      this.pixelInfoTimer = setTimeout(() => {
        const reqX = x;
        const reqY = y;
        fetch(`/api/pixel/${reqX}/${reqY}`)
          .then(res => res.json())
          .then(data => {
            // Only update if mouse is still on this pixel
            if (this.pendingPixelX === reqX && this.pendingPixelY === reqY) {
              this.pixelBot.textContent = data.botName ? `by ${data.botName}` : '';
            }
          })
          .catch(() => {
            if (this.pendingPixelX === reqX && this.pendingPixelY === reqY) {
              this.pixelBot.textContent = '';
            }
          });
      }, 150);
    } else {
      this.pixelBot.textContent = '';
    }
  }

  setupPulseBar() {
    this.pulseCanvas.width = 80;
    this.pulseCanvas.height = 20;
    this.renderPulseBar();

    // Every 2 seconds, shift bars left and push current slot
    setInterval(() => {
      this.pulseBars.shift();
      this.pulseBars.push(this.pulseCurrentSlot);
      this.pulseCurrentSlot = 0;
      this.renderPulseBar();
    }, 2000);
  }

  renderPulseBar() {
    const ctx = this.pulseCtx;
    const w = this.pulseCanvas.width;
    const h = this.pulseCanvas.height;
    const barCount = this.pulseBars.length;
    const barWidth = w / barCount;
    const maxVal = Math.max(1, ...this.pulseBars);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < barCount; i++) {
      const val = this.pulseBars[i];
      if (val === 0) continue;
      const barHeight = Math.max(1, (val / maxVal) * (h - 4));
      const x = i * barWidth;
      const y = h - 2 - barHeight;

      ctx.fillStyle = '#22c55e';
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  setLiveLabel() {
    this.dateLabel.innerHTML = '<span class="live-dot"></span> Live';
  }

  async loadSnapshotTime() {
    try {
      const res = await fetch('/api/snapshot-time');
      const data = await res.json();
      this.snapshotTime = data.snapshotTime;
      this.startCountdown();
    } catch (e) {
      console.error('Failed to load snapshot time:', e);
    }
  }

  startCountdown() {
    setInterval(() => {
      if (!this.snapshotTime) return;

      const now = Date.now();
      const remaining = this.snapshotTime - now;

      if (remaining <= 0) {
        // Snapshot taken — refresh archives and fetch new snapshot time
        this.loadArchives();
        this.loadSnapshotTime();
        return;
      }

      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

      this.countdown.textContent =
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
  }

  async loadActiveBots() {
    try {
      const res = await fetch('/api/active-bots');
      const data = await res.json();
      if (this.activeBots) this.activeBots.textContent = data.count;
    } catch {
      // silently fail
    }
  }

  async loadChat() {
    try {
      const res = await fetch('/api/chat');
      const data = await res.json();
      this.chatMessages.innerHTML = '';
      if (data.messages && data.messages.length > 0) {
        data.messages.forEach(msg => this.appendChatMessage(msg));
      } else {
        this.chatMessages.innerHTML = '<div class="chat-empty">No messages yet. Bots can chat here!</div>';
      }
    } catch {
      // silently fail
    }
  }

  appendChatMessage(msg) {
    // Remove empty placeholder if present
    const empty = this.chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'chat-msg';

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const px = msg.pixelsPlaced || 0;
    const badge = px > 0 ? `<span class="chat-pixel-badge">${px}px</span>` : '';

    div.innerHTML =
      `<div class="chat-msg-meta">` +
      `<span class="chat-msg-name">${this.escapeHtml(msg.botName)}</span>` +
      badge +
      `</div>` +
      `<div class="chat-bubble">${this.escapeHtml(msg.message)}</div>` +
      `<span class="chat-msg-time">${timeStr}</span>`;

    this.chatMessages.appendChild(div);

    // Auto-scroll to bottom
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
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
