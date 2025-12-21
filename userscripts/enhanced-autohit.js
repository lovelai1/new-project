/* global game, gameServer, socketMsgType, joinedGame, skillUse, skillStop, lastFps, latency */

/**
 * EvoWorld enhanced auto-hit and overlay helper.
 *
 * Converted to a reusable "library-style" controller so the behaviors can be
 * mounted, started, or stopped from other scripts without duplicating logic.
 *
 * Usage:
 *   const controller = new EvoAutoHit();
 *   controller.start(); // bootstraps overlay, controls, zoom + auto-hit
 *
 * A global reference is also exposed: window.EvoAutoHitController.
 */
(function bootstrapAutoHit(globalThisArg) {
  'use strict';

  const HEIGHT = { grimReaper: 150, pumpkinGhost: 150, ghostlyReaper: 150 };
  const REAPER_LIST = new Set(['grimReaper', 'pumpkinGhost', 'ghostlyReaper']);
  const STORAGE_KEY = 'evoworld_enhanced_autohit';
  const DEFAULT_SETTINGS = {
    showHitbox: true,
    autohit: false,
    zoomEnabled: true,
    zoomLevel: 0.75,
    zoomUseCamera: false,
    showArrows: true,
  };

  class EvoAutoHit {
    constructor(win = window) {
      this.win = win;
      this.doc = win.document;
      this.settings = this.loadSettings();

      this.overlayCanvas = null;
      this.overlayCtx = null;
      this.overlayCssW = 0;
      this.overlayCssH = 0;
      this.overlayRAF = null;

      this.controlPanel = null;
      this.zoomInterval = null;
      this.gameServerAttached = false;

      this.autoHitting = this.settings.autohit;
      this.flicking = this.autoHitting;

      this.boundKeydown = this.handleKeydown.bind(this);
      this.boundResize = this.handleResize.bind(this);
      this.boundSync = this.handleGameSync.bind(this);
      this.boundDisconnect = this.handleDisconnect.bind(this);
    }

    start() {
      this.createOverlay();
      this.renderControlPanel();
      if (this.settings.showHitbox || this.autoHitting) {
        this.startOverlayLoop();
      }
      this.applyZoomLevel(true);
      if (!this.zoomInterval) {
        this.zoomInterval = this.win.setInterval(() => this.applyZoomLevel(false), 750);
      }
      this.doc.addEventListener('keydown', this.boundKeydown);
      this.win.addEventListener('resize', this.boundResize);
      this.waitForGameServer();
    }

    stop() {
      this.doc.removeEventListener('keydown', this.boundKeydown);
      this.win.removeEventListener('resize', this.boundResize);
      if (this.zoomInterval) {
        this.win.clearInterval(this.zoomInterval);
        this.zoomInterval = null;
      }
      this.stopOverlayLoop();
      this.detachGameServer();
    }

    loadSettings() {
      try {
        const saved = JSON.parse(this.win.localStorage.getItem(STORAGE_KEY) || '{}');
        return { ...DEFAULT_SETTINGS, ...saved };
      } catch (_e) {
        return { ...DEFAULT_SETTINGS };
      }
    }

    persistSettings() {
      try {
        this.win.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch (_e) {
        /* ignored */
      }
    }

    // Overlay + canvas -------------------------------------------------------
    createOverlay() {
      if (this.overlayCanvas) return;
      const canvas = this.doc.createElement('canvas');
      canvas.id = 'evoworld-hitbox-overlay';
      Object.assign(canvas.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 9998,
      });

      this.overlayCssW = this.win.innerWidth;
      this.overlayCssH = this.win.innerHeight;
      const dpr = this.win.devicePixelRatio || 1;
      canvas.width = Math.round(this.overlayCssW * dpr);
      canvas.height = Math.round(this.overlayCssH * dpr);

      this.doc.body.appendChild(canvas);
      this.overlayCanvas = canvas;
      this.overlayCtx = canvas.getContext('2d');
      this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    handleResize() {
      if (!this.overlayCanvas || !this.overlayCtx) return;
      this.overlayCssW = this.win.innerWidth;
      this.overlayCssH = this.win.innerHeight;
      const nextDpr = this.win.devicePixelRatio || 1;
      this.overlayCanvas.width = Math.round(this.overlayCssW * nextDpr);
      this.overlayCanvas.height = Math.round(this.overlayCssH * nextDpr);
      this.overlayCtx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
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
      const dpr = this.win.devicePixelRatio || 1;
      this.overlayCanvas.width = Math.round(rect.width * dpr);
      this.overlayCanvas.height = Math.round(rect.height * dpr);
      this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cs = this.win.getComputedStyle(target);
      this.overlayCanvas.style.transformOrigin = cs.transformOrigin || 'center center';
      this.overlayCanvas.style.transform = cs.transform !== 'none' ? cs.transform : '';
    }

    startOverlayLoop() {
      if (!this.overlayCanvas) this.createOverlay();
      if (this.overlayRAF) return;

      const loop = () => {
        try {
          this.drawAllHitboxes();
        } catch (_e) { /* ignored */ }
        this.overlayRAF = this.win.requestAnimationFrame(loop);
      };
      loop();
    }

    stopOverlayLoop() {
      if (this.overlayRAF) {
        this.win.cancelAnimationFrame(this.overlayRAF);
      }
      this.overlayRAF = null;
      if (this.overlayCtx && this.overlayCanvas) {
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      }
    }

    drawAllHitboxes() {
      if (!this.overlayCtx || !this.overlayCanvas) return;
      this.syncOverlayToGameCanvas();
      this.overlayCtx.clearRect(0, 0, this.overlayCssW, this.overlayCssH);
      if (this.win.game && this.win.game.me) {
        this.drawMyHitbox();
        if (this.settings.showArrows) {
          this.drawDirectionalMarkers();
          this.drawEntityHighlights();
        }
      }
    }

    drawMyHitbox() {
      const { game } = this.win;
      if (!this.overlayCtx || !game || !game.me || !game.me.position) return;
      if (!this.settings.showHitbox) return;

      const screen = this.worldToScreen(game.me.position);
      if (!screen.vis) return;

      const size = this.getEntityBoxSize(game.me);
      let scale = 1;
      try {
        if (game.camera && typeof game.camera.zoom === 'number') scale = game.camera.zoom;
        else if (game.renderer && typeof game.renderer.scale === 'number') scale = game.renderer.scale;
      } catch (_e) { scale = 1; }

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

    drawEntityHighlights() {
      const { game } = this.win;
      if (!game || !game.me) return;
      const visible = (game.hashMap && game.sortToDraw)
        ? game.sortToDraw(game.hashMap.retrieveVisibleByClient(game)) || []
        : [];

      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted || ent === game.me) continue;
        if (!ent.position || !Number.isFinite(ent.position.x) || !Number.isFinite(ent.position.y)) continue;
        const cls = this.classifyEntity(ent);
        if (cls === 'skip' || cls === 'neutral') continue;
        this.drawEntityHighlight(ent, cls);
      }
    }

    drawEntityHighlight(ent, cls) {
      const screen = this.worldToScreen(ent.position);
      if (!screen.vis) return;
      const size = this.getEntityBoxSize(ent);

      let scale = 1;
      try {
        if (this.win.game?.camera && typeof this.win.game.camera.zoom === 'number') scale = this.win.game.camera.zoom;
        else if (this.win.game?.renderer && typeof this.win.game.renderer.scale === 'number') scale = this.win.game.renderer.scale;
      } catch (_e) { scale = 1; }

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

    drawDirectionalMarkers() {
      const { game } = this.win;
      if (!game || !game.me) return;
      const visible = (game.hashMap && game.sortToDraw)
        ? game.sortToDraw(game.hashMap.retrieveVisibleByClient(game)) || []
        : [];

      let nearestThreat = null;
      let nearestThreatDist = Number.POSITIVE_INFINITY;
      let nearestEdible = null;
      let nearestEdibleDist = Number.POSITIVE_INFINITY;

      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted) continue;
        const cls = this.classifyEntity(ent);
        if (cls === 'skip' || cls === 'neutral') continue;
        const pos = ent.position;
        if (!pos) continue;

        const mag = this.getMagnitude(pos);
        if (cls === 'threat' && mag < nearestThreatDist) {
          nearestThreat = ent;
          nearestThreatDist = mag;
        } else if ((cls === 'prey' || cls === 'food') && mag < nearestEdibleDist) {
          nearestEdible = ent;
          nearestEdibleDist = mag;
        }
      }

      if (nearestThreat && nearestThreat.position) {
        this.drawArrowTowards(this.worldToScreen(nearestThreat.position), 'rgba(255,60,60,0.9)', 'DANGER');
      }
      if (nearestEdible && nearestEdible.position) {
        this.drawArrowTowards(this.worldToScreen(nearestEdible.position), 'rgba(60,200,80,0.9)', 'EAT');
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

    // Zoom -------------------------------------------------------------------
    getGameCanvas() {
      try {
        const canvases = Array.from(this.doc.querySelectorAll('canvas'));
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

    applyZoomLevel(force = false) {
      if (!this.settings.zoomEnabled && !force) return;
      const target = this.settings.zoomLevel;
      let appliedNative = false;
      try {
        if (this.settings.zoomUseCamera && typeof this.win.game !== 'undefined' && this.win.game) {
          const cam = this.win.game.camera || {};
          if (typeof cam.zoom === 'number') {
            cam.zoom = target;
            appliedNative = true;
          } else if (typeof cam.scale === 'number') {
            cam.scale = target;
            appliedNative = true;
          } else if (this.win.game.renderer && typeof this.win.game.renderer.scale === 'number') {
            this.win.game.renderer.scale = target;
            appliedNative = true;
          }
        }
      } catch (_e) {
        appliedNative = false;
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

      return appliedNative;
    }

    // UI ---------------------------------------------------------------------
    renderControlPanel() {
      if (this.controlPanel) return;
      const panel = this.doc.createElement('div');
      panel.id = 'evoworld-autohit-controls';
      Object.assign(panel.style, {
        position: 'fixed',
        top: '360px',
        right: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 10000,
        fontFamily: 'Arial, sans-serif',
        userSelect: 'none',
      });
      this.doc.body.appendChild(panel);
      this.controlPanel = panel;

      const toggles = [
        {
          id: 'hitbox-toggle',
          label: 'HITBOX',
          getActive: () => this.settings.showHitbox,
          onClick: () => {
            this.settings.showHitbox = !this.settings.showHitbox;
            this.persistSettings();
            if (this.settings.showHitbox) this.startOverlayLoop();
            else if (!this.autoHitting) this.stopOverlayLoop();
          },
        },
        {
          id: 'autohit-toggle',
          label: 'AUTOHIT',
          getActive: () => this.autoHitting,
          onClick: () => {
            this.autoHitting = !this.autoHitting;
            this.flicking = this.autoHitting;
            this.settings.autohit = this.autoHitting;
            this.persistSettings();
            if (this.autoHitting) this.startOverlayLoop();
            else if (!this.settings.showHitbox) this.stopOverlayLoop();
          },
        },
        {
          id: 'zoom-toggle',
          label: 'ZOOM',
          getActive: () => this.settings.zoomEnabled,
          onClick: () => {
            this.settings.zoomEnabled = !this.settings.zoomEnabled;
            this.persistSettings();
            this.applyZoomLevel(true);
          },
        },
        {
          id: 'arrows-toggle',
          label: 'ARROWS',
          getActive: () => this.settings.showArrows,
          onClick: () => {
            this.settings.showArrows = !this.settings.showArrows;
            this.persistSettings();
          },
        },
      ];

      toggles.forEach((cfg) => {
        const btn = this.makeButton(cfg.id, cfg.label, cfg.getActive());
        btn.addEventListener('click', () => {
          cfg.onClick();
          this.setButtonState(btn, cfg.label, cfg.getActive());
        });
        panel.appendChild(btn);
      });

      const zoomModeBtn = this.makeButton(
        'zoom-mode-toggle',
        this.settings.zoomUseCamera ? 'MODE: CAMERA' : 'MODE: CANVAS',
        true,
      );
      zoomModeBtn.addEventListener('click', () => {
        this.settings.zoomUseCamera = !this.settings.zoomUseCamera;
        this.persistSettings();
        this.setButtonState(
          zoomModeBtn,
          this.settings.zoomUseCamera ? 'MODE: CAMERA' : 'MODE: CANVAS',
          true,
        );
        this.applyZoomLevel(true);
      });
      panel.appendChild(zoomModeBtn);

      const zoomRow = this.doc.createElement('div');
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

      const zoomLabel = this.doc.createElement('span');
      zoomLabel.textContent = 'Zoom';
      const zoomInput = this.doc.createElement('input');
      zoomInput.type = 'range';
      zoomInput.min = '0.3';
      zoomInput.max = '1.5';
      zoomInput.step = '0.05';
      zoomInput.value = String(this.settings.zoomLevel);
      zoomInput.style.flex = '1';
      const zoomValue = this.doc.createElement('span');
      zoomValue.textContent = `${(this.settings.zoomLevel * 100).toFixed(0)}%`;

      zoomInput.addEventListener('input', () => {
        this.settings.zoomLevel = Number(zoomInput.value);
        zoomValue.textContent = `${(this.settings.zoomLevel * 100).toFixed(0)}%`;
        this.persistSettings();
        this.applyZoomLevel(true);
      });

      zoomRow.append(zoomLabel, zoomInput, zoomValue);
      panel.appendChild(zoomRow);
    }

    makeButton(id, label, active) {
      const btn = this.doc.createElement('div');
      btn.id = id;
      Object.assign(btn.style, {
        padding: '10px 14px',
        borderRadius: '12px',
        cursor: 'pointer',
        boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        textAlign: 'center',
        fontWeight: 'bold',
        color: '#fff',
      });
      this.setButtonState(btn, label, active);
      return btn;
    }

    setButtonState(btn, label, active) {
      btn.style.backgroundColor = active ? '#4CAF50' : '#f44336';
      btn.textContent = `${label}: ${active ? 'ON' : 'OFF'}`;
    }

    handleKeydown(e) {
      if (!e.key) return;
      const key = e.key.toLowerCase();
      const clickById = (id) => {
        const el = this.doc.getElementById(id);
        if (el) el.click();
      };
      if (key === 'h') clickById('hitbox-toggle');
      else if (key === 'r' || e.keyCode === 40) clickById('autohit-toggle');
      else if (key === 'z') clickById('zoom-toggle');
      else if (key === '-' || key === '_') {
        this.settings.zoomLevel = Math.max(0.5, this.settings.zoomLevel - 0.05);
        this.persistSettings();
        this.applyZoomLevel(true);
        const slider = this.doc.querySelector('#evoworld-autohit-controls input[type="range"]');
        if (slider) {
          slider.value = String(this.settings.zoomLevel);
          slider.dispatchEvent(new this.win.Event('input'));
        }
      } else if (key === '=' || key === '+') {
        this.settings.zoomLevel = Math.min(1.5, this.settings.zoomLevel + 0.05);
        this.persistSettings();
        this.applyZoomLevel(true);
        const slider = this.doc.querySelector('#evoworld-autohit-controls input[type="range"]');
        if (slider) {
          slider.value = String(this.settings.zoomLevel);
          slider.dispatchEvent(new this.win.Event('input'));
        }
      }
    }

    // World helpers ----------------------------------------------------------
    worldToScreen(pos) {
      if (!pos) return { x: 0, y: 0, vis: false };
      let usedTransform = false;
      let screenX = pos.x;
      let screenY = pos.y;
      try {
        if (typeof this.win.game !== 'undefined' && this.win.game) {
          if (typeof this.win.game.getRenderPosition === 'function') {
            const p = this.win.game.getRenderPosition(pos.x, pos.y);
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              screenX = p.x;
              screenY = p.y;
              usedTransform = true;
            }
          }
          if (!usedTransform && this.win.game.camera && typeof this.win.game.camera.toScreen === 'function') {
            const p = this.win.game.camera.toScreen(pos);
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
              return { x: Math.round(p.x), y: Math.round(p.y), vis: true };
            }
          }
          if (!usedTransform && this.win.game.camera && typeof this.win.game.camera.x === 'number' && typeof this.win.game.camera.y === 'number') {
            const zoom = typeof this.win.game.camera.zoom === 'number'
              ? this.win.game.camera.zoom
              : (typeof this.win.game.camera.scale === 'number' ? this.win.game.camera.scale : 1);
            screenX = (pos.x - this.win.game.camera.x) * zoom + this.overlayCssW / 2;
            screenY = (pos.y - this.win.game.camera.y) * zoom + this.overlayCssH / 2;
            usedTransform = true;
          }
          if (!usedTransform && this.win.game.me && this.win.game.me.position) {
            const cx = this.overlayCssW / 2;
            const cy = this.overlayCssH / 2;
            const dx = pos.x - this.win.game.me.position.x;
            const dy = pos.y - this.win.game.me.position.y;
            const zoom = (this.win.game.renderer && typeof this.win.game.renderer.scale === 'number') ? this.win.game.renderer.scale : 1;
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
      if (ent.name && HEIGHT[ent.name]) {
        const h = HEIGHT[ent.name];
        return { w: Math.max(30, Math.min(400, h * 0.6)), h: Math.min(400, h) };
      }
      return { w: 40, h: 80 };
    }

    getHalfExtents(ent) {
      const s = this.getEntityBoxSize(ent);
      return { halfW: s.w / 2, halfH: s.h / 2 };
    }

    getMagnitude(objPos) {
      if (!this.win.game || !this.win.game.me || !this.win.game.me.position) return Number.POSITIVE_INFINITY;
      const myPos = this.win.game.me.position;
      return Math.abs(myPos.x - objPos.x) + Math.abs(myPos.y - objPos.y);
    }

    // Target classification --------------------------------------------------
    classifyEntity(ent) {
      if (!ent || !this.win.game || !this.win.game.me || ent === this.win.game.me) return 'skip';
      const isPlayerLike = ent.hp != null && ent.level != null;
      const myLevel = this.win.game.me.level || 0;

      if (ent.food === true || ent.type === 'food') return 'food';

      if (isPlayerLike) {
        if (typeof ent.level === 'number') {
          if (ent.level > myLevel + 0.5) return 'threat';
          if (ent.level < myLevel - 0.2) return 'prey';
        }
        const myBox = this.getEntityBoxSize(this.win.game.me);
        const otherBox = this.getEntityBoxSize(ent);
        const areaRatio = (otherBox.w * otherBox.h) / Math.max(1, myBox.w * myBox.h);
        if (areaRatio > 1.35) return 'threat';
        if (areaRatio < 0.8) return 'prey';
      }

      return 'neutral';
    }

    // Auto-hit ---------------------------------------------------------------
    getClosestReaper() {
      if (typeof this.win.gameServer === 'undefined' || typeof this.win.game === 'undefined' || !this.win.game || !this.win.game.me || this.win.game.me.deleted || typeof this.win.joinedGame === 'undefined' || !this.win.joinedGame) {
        return undefined;
      }

      const list = this.win.game.sortToDraw(this.win.game.hashMap.retrieveVisibleByClient(this.win.game)) || [];
      const candidates = [];
      for (let i = 0; i < list.length; i += 1) {
        const cur = list[i];
        if (!cur || cur.deleted || cur.hp == null || cur.level == null) continue;
        if (!REAPER_LIST.has(cur.name)) continue;
        if (cur === this.win.game.me) continue;
        candidates.push(cur);
      }

      let closest = undefined;
      let closestMagn = Number.POSITIVE_INFINITY;
      for (let i = 0; i < candidates.length; i += 1) {
        const magn = this.getMagnitude(candidates[i].position);
        if (magn < closestMagn) {
          closest = candidates[i];
          closestMagn = magn;
        }
      }
      return closest;
    }

    simulateQuickArrowKey(code) {
      const keyDownEvent = new this.win.KeyboardEvent('keydown', { keyCode: code, which: code, bubbles: true, cancelable: true });
      this.doc.dispatchEvent(keyDownEvent);
      this.win.setTimeout(() => {
        const keyUpEvent = new this.win.KeyboardEvent('keyup', { keyCode: code, which: code, bubbles: true, cancelable: true });
        this.doc.dispatchEvent(keyUpEvent);
      }, 35);
    }

    autoHit() {
      const enemy = this.getClosestReaper();
      if (typeof enemy !== 'object' || typeof this.win.game === 'undefined' || !this.win.game || typeof this.win.game.me !== 'object' || !REAPER_LIST.has(this.win.game.me.name)) {
        return;
      }

      const onLeftSide = this.win.game.me.position.x <= enemy.position.x;
      const enemyFlicking = (onLeftSide && enemy.direction === 1) || (!onLeftSide && enemy.direction === -1);
      const facingEnemy = this.flicking ? ((onLeftSide && this.win.game.me.direction === 1) || (!onLeftSide && this.win.game.me.direction === -1)) : true;

      const attemptAttack = (rangeTable, distAdj = 0) => {
        if (this.isWithinXRange(this.win.game.me, enemy, rangeTable, distAdj) && this.isWithinYRange(this.win.game.me, enemy, HEIGHT)) {
          if (!facingEnemy) {
            if (onLeftSide) this.simulateQuickArrowKey(39);
            else this.simulateQuickArrowKey(37);
          }
          if (typeof this.win.skillUse === 'function') this.win.skillUse();
          this.win.setTimeout(() => {
            if (typeof this.win.skillStop === 'function') this.win.skillStop();
          }, 100);
        }
      };

      if (facingEnemy) {
        if (enemyFlicking) {
          attemptAttack(HitBackRangeX);
        } else {
          attemptAttack(HitRangeX);
        }
      } else if (enemyFlicking) {
        attemptAttack(HitBackRangeX, -25);
      } else {
        attemptAttack(HitRangeX, -5);
      }
    }

    isWithinXRange(attacker, target, rangeTable, distAdjustment = 0) {
      if (!attacker || !target) return false;
      const aX = attacker.position.x;
      const bX = target.position.x;
      const aHalf = this.getHalfExtents(attacker).halfW;
      const bHalf = this.getHalfExtents(target).halfW;

      const relativeSpeed = Math.abs(
        (attacker.moveSpeed && attacker.moveSpeed.x) ? attacker.moveSpeed.x : 0
        - ((target.moveSpeed && target.moveSpeed.x) ? target.moveSpeed.x : 0),
      );
      const frameTime = (typeof this.win.lastFps === 'number' && this.win.lastFps > 0) ? (1000 / this.win.lastFps) : 16;
      const serverDelay = (typeof this.win.latency === 'number') ? this.win.latency : 0;
      const totalDelay = frameTime + serverDelay;

      const centerDist = Math.abs(bX - aX);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - totalDelay * relativeSpeed / 1000 + distAdjustment;

      let allowedRange = 0;
      try {
        if (rangeTable && attacker.name && target.name && rangeTable[attacker.name] && typeof rangeTable[attacker.name][target.name] !== 'undefined') {
          allowedRange = rangeTable[attacker.name][target.name];
        }
      } catch (_e) { allowedRange = 0; }

      return effectiveDist <= allowedRange;
    }

    isWithinYRange(attacker, target, heights, distAdjustment = 0) {
      if (!attacker || !target) return false;
      const aY = attacker.position.y;
      const bY = target.position.y;
      const aHalf = this.getHalfExtents(attacker).halfH;
      const bHalf = this.getHalfExtents(target).halfH;

      const relativeSpeed = Math.abs(
        (attacker.moveSpeed && attacker.moveSpeed.y) ? attacker.moveSpeed.y : 0
        - ((target.moveSpeed && target.moveSpeed.y) ? target.moveSpeed.y : 0),
      );
      const frameTime = (typeof this.win.lastFps === 'number' && this.win.lastFps > 0) ? (1000 / this.win.lastFps) : 16;
      const serverDelay = (typeof this.win.latency === 'number') ? this.win.latency : 0;
      const totalDelay = frameTime + serverDelay;

      const centerDist = Math.abs(bY - aY);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - totalDelay * relativeSpeed / 1000 + distAdjustment;

      let allowedRangeY = 0;
      try {
        if (heights && attacker.name && target.name) {
          allowedRangeY = heights[target.name] || heights[attacker.name] || 0;
        }
      } catch (_e) { allowedRangeY = 0; }

      return effectiveDist <= allowedRangeY;
    }

    // Lifecycle --------------------------------------------------------------
    handleGameSync() {
      if (this.autoHitting) this.autoHit();
      if (this.settings.showHitbox) {
        try { this.drawAllHitboxes(); } catch (_e) { /* ignored */ }
      }
      this.applyZoomLevel(false);
    }

    handleDisconnect() {
      this.gameServerAttached = false;
      this.win.setTimeout(() => this.waitForGameServer(), 1000);
    }

    attachGameServer() {
      if (this.gameServerAttached) return true;
      if (typeof this.win.gameServer !== 'object' || typeof this.win.gameServer.on !== 'function') return false;
      this.win.gameServer.on('disconnect', this.boundDisconnect);
      if (this.win.socketMsgType && typeof this.win.socketMsgType.SYNC !== 'undefined') {
        this.win.gameServer.on(this.win.socketMsgType.SYNC, this.boundSync);
      }
      this.gameServerAttached = true;
      return true;
    }

    detachGameServer() {
      // gameServer API does not expose "off" in the client, so we rely on guard flags
      this.gameServerAttached = false;
    }

    waitForGameServer() {
      if (this.attachGameServer()) return;
      this.win.setTimeout(() => this.waitForGameServer(), 1000);
    }
  }

  const HitRangeX = {
    grimReaper: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
    pumpkinGhost: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
    ghostlyReaper: { grimReaper: 140, pumpkinGhost: 140, ghostlyReaper: 140 },
  };
  const HitBackRangeX = {
    grimReaper: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
    pumpkinGhost: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
    ghostlyReaper: { grimReaper: 141, pumpkinGhost: 141, ghostlyReaper: 141 },
  };

  globalThisArg.EvoAutoHitController = EvoAutoHit;
  const autoStartInstance = new EvoAutoHit(globalThisArg);
  autoStartInstance.start();
}(typeof window !== 'undefined' ? window : globalThis));
