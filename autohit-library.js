/* eslint-disable no-undef */
/**
 * Enhanced autohit/overlay controller extracted into a reusable library.
 * The controller is self contained and can be instantiated from userscripts or page code:
 *
 * const controller = EnhancedAutohitController.create().start();
 *
 * Options:
 * - getEnv(): () => ({ game, gameServer, socketMsgType, joinedGame })
 * - storageKey: key for persisted settings
 * - defaultSettings: override individual defaults
 */
(function (global) {
  'use strict';

  const FALLBACK_HEIGHTS = { grimReaper: 150, pumpkinGhost: 150, ghostlyReaper: 150 };
  const REAPER_NAMES = new Set(['grimReaper', 'pumpkinGhost', 'ghostlyReaper']);

  const DEFAULT_SETTINGS = {
    showHitbox: true,
    autohit: false,
    zoomEnabled: true,
    zoomLevel: 0.75,
    zoomUseCamera: false,
    showArrows: true,
  };

  const DEFAULT_ENV = () => ({
    game: global.game,
    gameServer: global.gameServer,
    socketMsgType: global.socketMsgType,
    joinedGame: global.joinedGame,
  });

  class EnhancedAutohitController {
    static create(options = {}) {
      return new EnhancedAutohitController(options);
    }

    constructor(options = {}) {
      this.window = options.window || global.window || global;
      this.document = options.document || this.window.document;
      this.getEnv = options.getEnv || DEFAULT_ENV;
      this.storageKey = options.storageKey || 'evoworld_enhanced_autohit';
      this.settings = { ...DEFAULT_SETTINGS, ...(options.defaultSettings || {}), ...this.loadSettings() };

      this.overlayCanvas = null;
      this.overlayCtx = null;
      this.overlayCssW = 0;
      this.overlayCssH = 0;
      this.overlayRAF = null;

      this.autoHitting = this.settings.autohit;
      this.flicking = this.autoHitting;

      this.zoomInterval = null;
      this.waitTimer = null;
      this.resizeHandler = null;
      this.keyHandler = null;
      this.cleanupFns = [];

      this.controlPanel = null;
      this.buttons = {};
      this.zoomInput = null;
      this.zoomValue = null;

      this.started = false;
    }

    start() {
      if (this.started) return this;
      this.started = true;

      this.createOverlay();
      this.buildControls();
      this.bindKeyboardShortcuts();
      this.applyZoomLevel(true);

      this.zoomInterval = this.window.setInterval(() => this.applyZoomLevel(false), 750);
      this.waitForGameServer();

      if (this.settings.showHitbox || this.autoHitting) this.startOverlayLoop();
      return this;
    }

    stop() {
      this.stopOverlayLoop();
      if (this.zoomInterval) {
        this.window.clearInterval(this.zoomInterval);
        this.zoomInterval = null;
      }
      if (this.waitTimer) {
        this.window.clearTimeout(this.waitTimer);
        this.waitTimer = null;
      }
      this.cleanupFns.forEach((fn) => fn());
      this.cleanupFns = [];
      this.started = false;
      return this;
    }

    destroy() {
      this.stop();
      if (this.controlPanel?.parentNode) this.controlPanel.parentNode.removeChild(this.controlPanel);
      if (this.overlayCanvas?.parentNode) this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
      this.controlPanel = null;
      this.overlayCanvas = null;
      this.overlayCtx = null;
    }

    loadSettings() {
      try {
        const raw = this.window.localStorage.getItem(this.storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch (_e) {
        return {};
      }
    }

    persistSettings() {
      try {
        this.window.localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
      } catch (_e) {
        /* ignored */
      }
    }

    get env() {
      return this.getEnv();
    }

    waitForGameServer() {
      const { gameServer } = this.env;
      if (!gameServer || typeof gameServer.on !== 'function') {
        this.waitTimer = this.window.setTimeout(() => this.waitForGameServer(), 1000);
        return;
      }
      this.registerGameServer(gameServer);
    }

    registerGameServer(gameServer) {
      const { socketMsgType } = this.env;
      const syncHandler = () => {
        if (this.autoHitting) this.autoHit();
        if (this.settings.showHitbox) this.safeDrawOverlay();
        this.applyZoomLevel(false);
      };

      gameServer.on('disconnect', () => {
        this.waitTimer = this.window.setTimeout(() => this.waitForGameServer(), 1000);
      });
      gameServer.on(socketMsgType.SYNC, syncHandler);

      this.cleanupFns.push(() => gameServer.off?.(socketMsgType.SYNC, syncHandler));
    }

    /* -------------------------------------------------------------------------- */
    /*                                  UI setup                                  */
    /* -------------------------------------------------------------------------- */

    buildControls() {
      if (this.controlPanel) return;
      const doc = this.document;
      this.controlPanel = doc.createElement('div');
      this.controlPanel.id = 'evoworld-autohit-controls';
      Object.assign(this.controlPanel.style, {
        position: 'fixed',
        top: '360px',
        right: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: '10000',
        fontFamily: 'Arial, sans-serif',
        userSelect: 'none',
      });
      doc.body.appendChild(this.controlPanel);

      this.buttons.hitbox = this.makeToggleButton('HITBOX', this.settings.showHitbox, () => {
        this.settings.showHitbox = !this.settings.showHitbox;
        this.persistSettings();
        this.setButtonState(this.buttons.hitbox, 'HITBOX', this.settings.showHitbox);
        if (this.settings.showHitbox) this.startOverlayLoop();
        else if (!this.autoHitting) this.stopOverlayLoop();
      });

      this.buttons.autohit = this.makeToggleButton('AUTOHIT', this.autoHitting, () => {
        this.autoHitting = !this.autoHitting;
        this.flicking = this.autoHitting;
        this.settings.autohit = this.autoHitting;
        this.persistSettings();
        this.setButtonState(this.buttons.autohit, 'AUTOHIT', this.autoHitting);
        if (this.autoHitting) this.startOverlayLoop();
        else if (!this.settings.showHitbox) this.stopOverlayLoop();
      });

      this.buttons.zoom = this.makeToggleButton('ZOOM', this.settings.zoomEnabled, () => {
        this.settings.zoomEnabled = !this.settings.zoomEnabled;
        this.persistSettings();
        this.setButtonState(this.buttons.zoom, 'ZOOM', this.settings.zoomEnabled);
        this.applyZoomLevel(true);
      });

      this.buttons.arrows = this.makeToggleButton('ARROWS', this.settings.showArrows, () => {
        this.settings.showArrows = !this.settings.showArrows;
        this.persistSettings();
        this.setButtonState(this.buttons.arrows, 'ARROWS', this.settings.showArrows);
      });

      this.buttons.zoomMode = this.makeToggleButton(
        this.settings.zoomUseCamera ? 'MODE: CAMERA' : 'MODE: CANVAS',
        true,
        () => {
          this.settings.zoomUseCamera = !this.settings.zoomUseCamera;
          this.persistSettings();
          this.setButtonState(
            this.buttons.zoomMode,
            this.settings.zoomUseCamera ? 'MODE: CAMERA' : 'MODE: CANVAS',
            true,
          );
          this.applyZoomLevel(true);
        },
      );

      const zoomRow = doc.createElement('div');
      Object.assign(zoomRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        background: 'rgba(0,0,0,0.55)',
        borderRadius: '10px',
        color: '#fff',
        fontSize: '12px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
      });

      const zoomLabel = doc.createElement('span');
      zoomLabel.textContent = 'Zoom';

      this.zoomInput = doc.createElement('input');
      this.zoomInput.type = 'range';
      this.zoomInput.min = '0.3';
      this.zoomInput.max = '1.5';
      this.zoomInput.step = '0.05';
      this.zoomInput.value = String(this.settings.zoomLevel);
      this.zoomInput.style.flex = '1';
      this.zoomInput.addEventListener('input', () => {
        this.settings.zoomLevel = Number(this.zoomInput.value);
        this.persistSettings();
        this.applyZoomLevel(true);
        this.updateZoomValue();
      });

      this.zoomValue = doc.createElement('span');
      this.updateZoomValue();

      zoomRow.append(zoomLabel, this.zoomInput, this.zoomValue);
      this.controlPanel.append(
        this.buttons.hitbox,
        this.buttons.autohit,
        this.buttons.zoom,
        this.buttons.arrows,
        this.buttons.zoomMode,
        zoomRow,
      );
    }

    makeToggleButton(label, active, onClick) {
      const btn = this.document.createElement('div');
      btn.style.padding = '10px 14px';
      btn.style.borderRadius = '12px';
      btn.style.cursor = 'pointer';
      btn.style.boxShadow = '0 2px 10px rgba(0,0,0,0.25)';
      btn.style.textAlign = 'center';
      btn.style.fontWeight = 'bold';
      btn.style.color = '#fff';
      this.setButtonState(btn, label, active);
      btn.addEventListener('click', () => onClick(btn));
      return btn;
    }

    setButtonState(btn, label, active) {
      btn.style.backgroundColor = active ? '#4CAF50' : '#f44336';
      btn.textContent = `${label}: ${active ? 'ON' : 'OFF'}`;
    }

    updateZoomValue() {
      if (this.zoomValue) this.zoomValue.textContent = `${(this.settings.zoomLevel * 100).toFixed(0)}%`;
    }

    bindKeyboardShortcuts() {
      this.keyHandler = (e) => {
        if (!e.key) return;
        const key = e.key.toLowerCase();
        if (key === 'h') {
          this.buttons.hitbox?.click();
        } else if (key === 'r' || e.keyCode === 40) {
          this.buttons.autohit?.click();
        } else if (key === 'z') {
          this.buttons.zoom?.click();
        } else if (key === '-' || key === '_') {
          this.bumpZoom(-0.05);
        } else if (key === '=' || key === '+') {
          this.bumpZoom(0.05);
        }
      };
      this.document.addEventListener('keydown', this.keyHandler);
      this.cleanupFns.push(() => this.document.removeEventListener('keydown', this.keyHandler));
    }

    bumpZoom(delta) {
      this.settings.zoomLevel = Math.min(1.5, Math.max(0.5, this.settings.zoomLevel + delta));
      if (this.zoomInput) {
        this.zoomInput.value = String(this.settings.zoomLevel);
        this.zoomInput.dispatchEvent(new this.window.Event('input'));
      }
    }

    /* -------------------------------------------------------------------------- */
    /*                             Overlay + rendering                            */
    /* -------------------------------------------------------------------------- */

    createOverlay() {
      if (this.overlayCanvas) return;
      const dpr = this.window.devicePixelRatio || 1;
      this.overlayCanvas = this.document.createElement('canvas');
      this.overlayCanvas.id = 'evoworld-hitbox-overlay';
      Object.assign(this.overlayCanvas.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '9998',
      });

      this.overlayCssW = this.window.innerWidth;
      this.overlayCssH = this.window.innerHeight;
      this.overlayCanvas.width = Math.round(this.overlayCssW * dpr);
      this.overlayCanvas.height = Math.round(this.overlayCssH * dpr);
      this.document.body.appendChild(this.overlayCanvas);
      this.overlayCtx = this.overlayCanvas.getContext('2d');
      this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.resizeHandler = () => {
        const nextDpr = this.window.devicePixelRatio || 1;
        this.overlayCssW = this.window.innerWidth;
        this.overlayCssH = this.window.innerHeight;
        this.overlayCanvas.width = Math.round(this.overlayCssW * nextDpr);
        this.overlayCanvas.height = Math.round(this.overlayCssH * nextDpr);
        this.overlayCtx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
      };
      this.window.addEventListener('resize', this.resizeHandler);
      this.cleanupFns.push(() => this.window.removeEventListener('resize', this.resizeHandler));
    }

    getGameCanvas() {
      try {
        const canvases = Array.from(this.document.querySelectorAll('canvas'));
        if (!canvases.length) return null;
        return canvases.reduce((best, cur) => {
          const area = (cur.width || 0) * (cur.height || 0);
          const bestArea = best ? (best.width || 0) * (best.height || 0) : 0;
          return area > bestArea ? cur : best;
        }, null);
      } catch (_e) {
        return null;
      }
    }

    syncOverlayToGameCanvas() {
      if (!this.overlayCanvas) return;
      const target = this.getGameCanvas();
      if (!target) return;
      const rect = target.getBoundingClientRect();
      Object.assign(this.overlayCanvas.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        position: 'fixed',
        pointerEvents: 'none',
      });

      this.overlayCssW = rect.width;
      this.overlayCssH = rect.height;
      const dpr = this.window.devicePixelRatio || 1;
      this.overlayCanvas.width = Math.round(rect.width * dpr);
      this.overlayCanvas.height = Math.round(rect.height * dpr);
      this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cs = this.window.getComputedStyle(target);
      this.overlayCanvas.style.transformOrigin = cs.transformOrigin || 'center center';
      this.overlayCanvas.style.transform = cs.transform !== 'none' ? cs.transform : '';
    }

    startOverlayLoop() {
      if (this.overlayRAF) return;
      const loop = () => {
        this.safeDrawOverlay();
        this.overlayRAF = this.window.requestAnimationFrame(loop);
      };
      loop();
    }

    stopOverlayLoop() {
      if (this.overlayRAF) {
        this.window.cancelAnimationFrame(this.overlayRAF);
        this.overlayRAF = null;
      }
      if (this.overlayCtx && this.overlayCanvas) {
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      }
    }

    safeDrawOverlay() {
      try {
        this.drawAllHitboxes();
      } catch (_e) {
        /* ignore draw errors */
      }
    }

    drawAllHitboxes() {
      if (!this.overlayCtx || !this.overlayCanvas) return;
      this.syncOverlayToGameCanvas();
      this.overlayCtx.clearRect(0, 0, this.overlayCssW, this.overlayCssH);
      const { game } = this.env;
      if (!game?.me) return;
      this.drawMyHitbox(game);
      if (this.settings.showArrows) {
        this.drawDirectionalMarkers(game);
        this.drawEntityHighlights(game);
      }
    }

    drawMyHitbox(game) {
      if (!this.overlayCtx || !this.settings.showHitbox) return;
      const me = game?.me;
      if (!me?.position) return;
      const screen = this.worldToScreen(game, me.position);
      if (!screen.vis) return;

      const size = this.getEntityBoxSize(me);
      const scale = this.getScale(game);
      const w = size.w * scale;
      const h = size.h * scale;
      const x = screen.x - w / 2;
      const y = screen.y - h / 2;

      this.overlayCtx.beginPath();
      this.overlayCtx.rect(x, y, w, h);
      this.overlayCtx.fillStyle = 'rgba(255,0,0,0.14)';
      this.overlayCtx.fill();
      this.overlayCtx.lineWidth = Math.max(1, 2 * scale);
      this.overlayCtx.strokeStyle = 'rgba(255,0,0,0.95)';
      this.overlayCtx.stroke();

      this.overlayCtx.font = `${12 * Math.max(1, scale)}px Arial`;
      this.overlayCtx.fillStyle = 'rgba(255,0,0,0.95)';
      this.overlayCtx.textAlign = 'center';
      this.overlayCtx.fillText('YOU', screen.x, y - 6 * scale);
    }

    drawDirectionalMarkers(game) {
      const visible = game?.hashMap && game.sortToDraw
        ? game.sortToDraw(game.hashMap.retrieveVisibleByClient(game)) || []
        : [];

      let nearestThreat = null;
      let nearestThreatDist = Number.POSITIVE_INFINITY;
      let nearestEdible = null;
      let nearestEdibleDist = Number.POSITIVE_INFINITY;

      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted) continue;
        const cls = this.classifyEntity(game, ent);
        if (cls === 'skip' || cls === 'neutral') continue;
        const pos = ent.position;
        if (!pos) continue;
        const mag = this.getMagnitude(game, pos);
        if (cls === 'threat' && mag < nearestThreatDist) {
          nearestThreat = ent;
          nearestThreatDist = mag;
        } else if ((cls === 'prey' || cls === 'food') && mag < nearestEdibleDist) {
          nearestEdible = ent;
          nearestEdibleDist = mag;
        }
      }

      if (nearestThreat?.position) {
        this.drawArrowTowards(this.worldToScreen(game, nearestThreat.position), 'rgba(255,60,60,0.9)', 'DANGER');
      }
      if (nearestEdible?.position) {
        this.drawArrowTowards(this.worldToScreen(game, nearestEdible.position), 'rgba(60,200,80,0.9)', 'EAT');
      }
    }

    drawArrowTowards(screenPos, color, label) {
      if (!this.overlayCanvas || !this.overlayCtx || !screenPos) return;
      const cx = this.overlayCanvas.width / 2;
      const cy = this.overlayCanvas.height / 2;
      const dx = screenPos.x - cx;
      const dy = screenPos.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist;
      const ny = dy / dist;

      const pad = 28;
      const maxX = (this.overlayCanvas.width / 2 - pad) / (Math.abs(nx) || 1);
      const maxY = (this.overlayCanvas.height / 2 - pad) / (Math.abs(ny) || 1);
      const edgeDist = Math.min(maxX, maxY);
      const tipX = cx + nx * edgeDist;
      const tipY = cy + ny * edgeDist;

      const size = 14;
      const baseX = tipX - nx * size * 1.8;
      const baseY = tipY - ny * size * 1.8;
      const perpX = -ny;
      const perpY = nx;
      const leftX = baseX + perpX * size;
      const leftY = baseY + perpY * size;
      const rightX = baseX - perpX * size;
      const rightY = baseY - perpY * size;

      this.overlayCtx.beginPath();
      this.overlayCtx.moveTo(tipX, tipY);
      this.overlayCtx.lineTo(leftX, leftY);
      this.overlayCtx.lineTo(rightX, rightY);
      this.overlayCtx.closePath();
      this.overlayCtx.fillStyle = color;
      this.overlayCtx.strokeStyle = color;
      this.overlayCtx.lineWidth = 2;
      this.overlayCtx.fill();
      this.overlayCtx.stroke();

      if (label) {
        this.overlayCtx.font = '12px Arial';
        this.overlayCtx.fillStyle = color;
        this.overlayCtx.textAlign = 'center';
        this.overlayCtx.fillText(label, tipX, tipY - 6);
      }
    }

    drawEntityHighlights(game) {
      const visible = game?.hashMap && game.sortToDraw
        ? game.sortToDraw(game.hashMap.retrieveVisibleByClient(game)) || []
        : [];

      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted || ent === game.me) continue;
        if (!ent.position || !Number.isFinite(ent.position.x) || !Number.isFinite(ent.position.y)) continue;
        const cls = this.classifyEntity(game, ent);
        if (cls === 'skip' || cls === 'neutral') continue;
        this.drawEntityHighlight(game, ent, cls);
      }
    }

    drawEntityHighlight(game, ent, cls) {
      if (!ent?.position) return;
      const screen = this.worldToScreen(game, ent.position);
      if (!screen.vis) return;
      const size = this.getEntityBoxSize(ent);
      const scale = this.getScale(game);
      const w = size.w * scale;
      const h = size.h * scale;
      const x = screen.x - w / 2;
      const y = screen.y - h / 2;

      let color = 'rgba(255,200,50,0.8)';
      if (cls === 'threat') color = 'rgba(255,60,60,0.85)';
      else if (cls === 'prey' || cls === 'food') color = 'rgba(60,200,80,0.85)';

      this.overlayCtx.beginPath();
      this.overlayCtx.rect(x, y, w, h);
      this.overlayCtx.lineWidth = Math.max(1.5, 2 * scale);
      this.overlayCtx.strokeStyle = color;
      this.overlayCtx.stroke();

      const tipX = screen.x;
      const tipY = y - 10 * scale;
      const baseY = tipY - 16 * scale;
      const wing = 8 * scale;
      this.overlayCtx.beginPath();
      this.overlayCtx.moveTo(tipX, tipY);
      this.overlayCtx.lineTo(tipX - wing, baseY);
      this.overlayCtx.lineTo(tipX + wing, baseY);
      this.overlayCtx.closePath();
      this.overlayCtx.fillStyle = color;
      this.overlayCtx.fill();
    }

    /* -------------------------------------------------------------------------- */
    /*                              Coordinate helpers                            */
    /* -------------------------------------------------------------------------- */

    worldToScreen(game, pos) {
      if (!pos) return { x: 0, y: 0, vis: false };
      let usedTransform = false;
      let screenX = pos.x;
      let screenY = pos.y;

      try {
        if (!this.overlayCanvas) this.createOverlay();

        if (game) {
          if (typeof game.getRenderPosition === 'function') {
            const p = game.getRenderPosition(pos.x, pos.y);
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              screenX = p.x;
              screenY = p.y;
              usedTransform = true;
            }
          }
          if (!usedTransform && game.camera?.toScreen) {
            const p = game.camera.toScreen(pos);
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              return { x: Math.round(p.x), y: Math.round(p.y), vis: true };
            }
          }
          if (!usedTransform && game.camera && typeof game.camera.x === 'number' && typeof game.camera.y === 'number') {
            const zoom = typeof game.camera.zoom === 'number'
              ? game.camera.zoom
              : (typeof game.camera.scale === 'number' ? game.camera.scale : 1);
            screenX = (pos.x - game.camera.x) * zoom + this.overlayCssW / 2;
            screenY = (pos.y - game.camera.y) * zoom + this.overlayCssH / 2;
            usedTransform = true;
          }
          if (!usedTransform && game.me?.position) {
            const cx = this.overlayCssW / 2;
            const cy = this.overlayCssH / 2;
            const dx = pos.x - game.me.position.x;
            const dy = pos.y - game.me.position.y;
            const zoom = game?.renderer && typeof game.renderer.scale === 'number' ? game.renderer.scale : 1;
            screenX = cx + dx * zoom;
            screenY = cy + dy * zoom;
            usedTransform = true;
          }
        }

        const x = Math.round(screenX);
        const y = Math.round(screenY);
        const margin = 200;
        const vis = usedTransform
          && Number.isFinite(x) && Number.isFinite(y)
          && x >= -margin && x <= this.overlayCssW + margin
          && y >= -margin && y <= this.overlayCssH + margin;
        return { x, y, vis };
      } catch (_e) {
        return { x: screenX, y: screenY, vis: false };
      }
    }

    getEntityBoxSize(ent) {
      if (!ent) return { w: 40, h: 80 };
      if (typeof ent.hitboxWidth === 'number' && typeof ent.hitboxHeight === 'number') {
        return { w: ent.hitboxWidth, h: ent.hitboxHeight };
      }
      if (typeof ent.width === 'number' && typeof ent.height === 'number') {
        return { w: ent.width, h: ent.height };
      }
      if (ent.size && typeof ent.size.x === 'number' && typeof ent.size.y === 'number') {
        return { w: ent.size.x, h: ent.size.y };
      }
      if (ent.name && FALLBACK_HEIGHTS[ent.name]) {
        const h = FALLBACK_HEIGHTS[ent.name];
        return { w: Math.max(30, Math.min(400, h * 0.6)), h: Math.min(400, h) };
      }
      return { w: 40, h: 80 };
    }

    getHalfExtents(ent) {
      const s = this.getEntityBoxSize(ent);
      return { halfW: s.w / 2, halfH: s.h / 2 };
    }

    getScale(game) {
      try {
        if (game?.camera && typeof game.camera.zoom === 'number') return game.camera.zoom;
        if (game?.renderer && typeof game.renderer.scale === 'number') return game.renderer.scale;
      } catch (_e) {
        /* ignore */
      }
      return 1;
    }

    getMagnitude(game, objPos) {
      const me = game?.me;
      if (!me?.position) return Number.POSITIVE_INFINITY;
      return Math.abs(me.position.x - objPos.x) + Math.abs(me.position.y - objPos.y);
    }

    classifyEntity(game, ent) {
      if (!ent || !game?.me || ent === game.me) return 'skip';
      const isPlayerLike = ent.hp != null && ent.level != null;
      const myLevel = game.me.level || 0;

      if (ent.food === true || ent.type === 'food') return 'food';

      if (isPlayerLike) {
        if (typeof ent.level === 'number') {
          if (ent.level > myLevel + 0.5) return 'threat';
          if (ent.level < myLevel - 0.2) return 'prey';
        }
        const myBox = this.getEntityBoxSize(game.me);
        const otherBox = this.getEntityBoxSize(ent);
        const areaRatio = (otherBox.w * otherBox.h) / Math.max(1, myBox.w * myBox.h);
        if (areaRatio > 1.35) return 'threat';
        if (areaRatio < 0.8) return 'prey';
      }

      return 'neutral';
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Zoom                                     */
    /* -------------------------------------------------------------------------- */

    applyZoomLevel(force = false) {
      if (!this.settings.zoomEnabled && !force) return;
      const target = this.settings.zoomLevel;
      const { game } = this.env;
      let appliedNative = false;
      if (this.settings.zoomUseCamera && game) {
        try {
          const cam = game.camera || {};
          if (typeof cam.zoom === 'number') {
            cam.zoom = target;
            appliedNative = true;
          } else if (typeof cam.scale === 'number') {
            cam.scale = target;
            appliedNative = true;
          } else if (game.renderer && typeof game.renderer.scale === 'number') {
            game.renderer.scale = target;
            appliedNative = true;
          }
        } catch (_e) {
          /* ignored */
        }
      }

      try {
        const canvasEl = this.getGameCanvas();
        if (canvasEl) {
          canvasEl.style.transformOrigin = 'center center';
          canvasEl.style.transform = `scale(${target})`;
          canvasEl.style.margin = '0 auto';
          canvasEl.style.display = 'block';
          const parent = canvasEl.parentElement;
          if (parent) {
            parent.style.display = 'flex';
            parent.style.justifyContent = 'center';
            parent.style.alignItems = 'center';
          }
        }
      } catch (_e) {
        /* ignored */
      }

      if (!appliedNative) return;
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Auto hit                                   */
    /* -------------------------------------------------------------------------- */

    getClosestReaper(game) {
      const { joinedGame } = this.env;
      if (!game || !joinedGame || !game.me || game.me.deleted) return undefined;
      if (!game.hashMap?.retrieveVisibleByClient || !game.sortToDraw) return undefined;

      const list = game.sortToDraw(game.hashMap.retrieveVisibleByClient(game)) || [];
      const candidates = [];
      for (let i = 0; i < list.length; i += 1) {
        const cur = list[i];
        if (!cur || cur.deleted || cur.hp == null || cur.level == null) continue;
        if (!REAPER_NAMES.has(cur.name)) continue;
        if (cur === game.me) continue;
        candidates.push(cur);
      }

      let closest = undefined;
      let closestMagn = Number.POSITIVE_INFINITY;
      for (let i = 0; i < candidates.length; i += 1) {
        const magn = this.getMagnitude(game, candidates[i].position);
        if (magn < closestMagn) {
          closest = candidates[i];
          closestMagn = magn;
        }
      }
      return closest;
    }

    isWithinXRange(attacker, target, rangeTable, distAdjustment = 0) {
      if (!attacker || !target) return false;
      const aX = attacker.position.x;
      const bX = target.position.x;

      const aHalf = this.getHalfExtents(attacker).halfW;
      const bHalf = this.getHalfExtents(target).halfW;

      const relativeSpeed = Math.abs(
        (attacker.moveSpeed?.x || 0) - (target.moveSpeed?.x || 0),
      );
      const frameTime = (typeof global.lastFps === 'number' && global.lastFps > 0) ? (1000 / global.lastFps) : 16;
      const serverDelay = (typeof global.latency === 'number') ? global.latency : 0;
      const totalDelay = frameTime + serverDelay;

      const centerDist = Math.abs(bX - aX);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - (totalDelay * relativeSpeed) / 1000 + distAdjustment;

      let allowedRange = 0;
      try {
        if (rangeTable && attacker.name && target.name && rangeTable[attacker.name]?.[target.name] !== undefined) {
          allowedRange = rangeTable[attacker.name][target.name];
        }
      } catch (_e) {
        allowedRange = 0;
      }
      return effectiveDist <= allowedRange;
    }

    isWithinYRange(attacker, target, heights, distAdjustment = 0) {
      if (!attacker || !target) return false;
      const aY = attacker.position.y;
      const bY = target.position.y;

      const aHalf = this.getHalfExtents(attacker).halfH;
      const bHalf = this.getHalfExtents(target).halfH;

      const relativeSpeed = Math.abs(
        (attacker.moveSpeed?.y || 0) - (target.moveSpeed?.y || 0),
      );
      const frameTime = (typeof global.lastFps === 'number' && global.lastFps > 0) ? (1000 / global.lastFps) : 16;
      const serverDelay = (typeof global.latency === 'number') ? global.latency : 0;
      const totalDelay = frameTime + serverDelay;

      const centerDist = Math.abs(bY - aY);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - (totalDelay * relativeSpeed) / 1000 + distAdjustment;

      let allowedRangeY = 0;
      try {
        if (heights && attacker.name && target.name) {
          allowedRangeY = heights[target.name] || heights[attacker.name] || 0;
        }
      } catch (_e) {
        allowedRangeY = 0;
      }
      return effectiveDist <= allowedRangeY;
    }

    autoHit() {
      const { game } = this.env;
      const enemy = this.getClosestReaper(game);
      if (!enemy || !game?.me || !REAPER_NAMES.has(game.me.name)) return;

      const onLeftSide = game.me.position.x <= enemy.position.x;
      const enemyFlicking = (onLeftSide && enemy.direction === 1) || (!onLeftSide && enemy.direction === -1);
      const facingEnemy = this.flicking
        ? ((onLeftSide && game.me.direction === 1) || (!onLeftSide && game.me.direction === -1))
        : true;

      const hitRangeX = {
        grimReaper: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
        pumpkinGhost: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
        ghostlyReaper: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
      };
      const hitBackRangeX = {
        grimReaper: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
        pumpkinGhost: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
        ghostlyReaper: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
      };

      const attemptAttack = (rangeTable, distAdj = 0) => {
        if (this.isWithinXRange(game.me, enemy, rangeTable, distAdj) && this.isWithinYRange(game.me, enemy, FALLBACK_HEIGHTS)) {
          if (!facingEnemy) {
            if (onLeftSide) this.simulateQuickArrowKey(39);
            else this.simulateQuickArrowKey(37);
          }
          global.skillUse?.();
          this.window.setTimeout(() => global.skillStop?.(), 100);
        }
      };

      if (facingEnemy) {
        if (enemyFlicking) {
          attemptAttack(hitBackRangeX);
        } else {
          attemptAttack(hitRangeX);
        }
      } else if (enemyFlicking) {
        attemptAttack(hitBackRangeX, -25);
      } else {
        attemptAttack(hitRangeX, -5);
      }
    }

    simulateQuickArrowKey(code) {
      const down = new this.window.KeyboardEvent('keydown', { keyCode: code, which: code, bubbles: true, cancelable: true });
      this.document.dispatchEvent(down);
      this.window.setTimeout(() => {
        const up = new this.window.KeyboardEvent('keyup', { keyCode: code, which: code, bubbles: true, cancelable: true });
        this.document.dispatchEvent(up);
      }, 35);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      EnhancedAutohitController,
      createEnhancedAutohitController: (options) => EnhancedAutohitController.create(options),
    };
  } else {
    global.EnhancedAutohitController = EnhancedAutohitController;
  }
})(typeof window !== 'undefined' ? window : globalThis);
