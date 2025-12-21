// ==UserScript==
// @name         EvoWorld Hitbox Overlay (Focused)
// @version      2.2.0
// @description  Minimal hitbox overlay for evoworld.io. Draws your hitbox on top of the game canvas and exposes a tiny API for future tweaks.
// @author       ChatGPT
// @match        https://evoworld.io/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=evoworld.io
// @license      MIT
// @grant        none
// @namespace    https://greasyfork.org/users/1536224
// ==/UserScript==

/* globals game */

(function bootstrap(global) {
  'use strict';

  const STORAGE_KEY = 'evoworld_hitbox_overlay';
  const DEFAULT_SETTINGS = { showHitbox: true };

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const createSettingsStore = (storage = global.localStorage) => {
    const load = () => {
      try {
        return { ...DEFAULT_SETTINGS, ...(JSON.parse(storage.getItem(STORAGE_KEY) || '{}')) };
      } catch (_e) {
        return { ...DEFAULT_SETTINGS };
      }
    };

    let data = load();
    const listeners = new Set();

    const persist = () => {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (_e) {
        /* ignored */
      }
    };

    const update = (partial) => {
      data = { ...data, ...partial };
      persist();
      listeners.forEach((fn) => fn(data));
      return data;
    };

    return {
      get: () => data,
      set: (key, value) => update({ [key]: value }),
      toggle: (key) => update({ [key]: !data[key] }),
      onChange: (fn) => listeners.add(fn),
      offChange: (fn) => listeners.delete(fn),
    };
  };

  const findGameCanvas = (doc) => {
    const canvases = Array.from(doc.querySelectorAll('canvas'));
    if (!canvases.length) return null;
    return canvases.reduce((best, cur) => {
      const area = (cur.width || 0) * (cur.height || 0);
      const bestArea = best ? (best.width || 0) * (best.height || 0) : 0;
      return area > bestArea ? cur : best;
    }, null);
  };

  const createOverlay = (win, doc) => {
    let canvas;
    let ctx;
    let cssWidth = 0;
    let cssHeight = 0;

    const ensureCanvas = () => {
      if (canvas) return;
      canvas = doc.createElement('canvas');
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
      doc.body.appendChild(canvas);
      ctx = canvas.getContext('2d');
      resize();
      win.addEventListener('resize', resize);
    };

    const resize = () => {
      if (!canvas) return;
      cssWidth = win.innerWidth;
      cssHeight = win.innerHeight;
      const dpr = win.devicePixelRatio || 1;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const syncToGameCanvas = () => {
      if (!canvas) return;
      const target = findGameCanvas(doc);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      canvas.style.left = `${rect.left}px`;
      canvas.style.top = `${rect.top}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      canvas.style.transformOrigin = getComputedStyle(target).transformOrigin || 'center center';
      canvas.style.transform = target.style.transform || '';
      cssWidth = rect.width;
      cssHeight = rect.height;
      const dpr = win.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const clear = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, cssWidth, cssHeight);
    };

    return {
      ensureCanvas,
      syncToGameCanvas,
      clear,
      get ctx() {
        return ctx;
      },
      get canvas() {
        return canvas;
      },
      get cssWidth() {
        return cssWidth;
      },
      get cssHeight() {
        return cssHeight;
      },
    };
  };

  const getEntitySize = (ent) => {
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
    return { w: 40, h: 80 };
  };

  const createProjector = (overlay, getGame) => (pos) => {
    const gameRef = getGame();
    if (!pos || !gameRef) return { x: 0, y: 0, vis: false };
    overlay.ensureCanvas();
    let x = pos.x;
    let y = pos.y;
    let transformed = false;

    try {
      if (typeof gameRef.getRenderPosition === 'function') {
        const p = gameRef.getRenderPosition(pos.x, pos.y);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          x = p.x;
          y = p.y;
          transformed = true;
        }
      }

      if (!transformed && gameRef.camera && typeof gameRef.camera.x === 'number' && typeof gameRef.camera.y === 'number') {
        const zoom =
          typeof gameRef.camera.zoom === 'number'
            ? gameRef.camera.zoom
            : typeof gameRef.camera.scale === 'number'
            ? gameRef.camera.scale
            : 1;
        x = (pos.x - gameRef.camera.x) * zoom + overlay.cssWidth / 2;
        y = (pos.y - gameRef.camera.y) * zoom + overlay.cssHeight / 2;
        transformed = true;
      }

      if (!transformed && gameRef.me && gameRef.me.position) {
        const zoom = gameRef.renderer && typeof gameRef.renderer.scale === 'number' ? gameRef.renderer.scale : 1;
        const cx = overlay.cssWidth / 2;
        const cy = overlay.cssHeight / 2;
        x = cx + (pos.x - gameRef.me.position.x) * zoom;
        y = cy + (pos.y - gameRef.me.position.y) * zoom;
        transformed = true;
      }
    } catch (_e) {
      /* ignored */
    }

    const margin = 200;
    const vis =
      transformed &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= -margin &&
      x <= overlay.cssWidth + margin &&
      y >= -margin &&
      y <= overlay.cssHeight + margin;
    return { x: Math.round(x), y: Math.round(y), vis };
  };

  const computeScreenRect = (ent, overlay, projector, gameRef) => {
    if (!ent?.position) return null;
    const size = getEntitySize(ent);

    const scale =
      (gameRef?.camera && typeof gameRef.camera.zoom === 'number' && gameRef.camera.zoom) ||
      (gameRef?.renderer && typeof gameRef.renderer.scale === 'number' && gameRef.renderer.scale) ||
      gameRef?.zoom ||
      1;
    const scaleX = (gameRef?.scaleX || 1) * scale;
    const scaleY = (gameRef?.scaleY || 1) * scale;

    const centerWorld = ent.positionCenter || {
      x: ent.position.x + size.w / 2,
      y: ent.position.y + size.h / 2,
    };

    const centerScreen = projector(centerWorld);
    if (!centerScreen.vis) return null;

    const w = size.w * scaleX;
    const h = size.h * scaleY;
    return {
      x: centerScreen.x - w / 2,
      y: centerScreen.y - h / 2,
      w,
      h,
      cx: centerScreen.x,
      cy: centerScreen.y,
    };
  };

  const drawEntityHitbox = (ent, overlay, projector, getGame, color) => {
    const gameRef = getGame();
    const ctx = overlay.ctx;
    if (!ctx || !gameRef) return;
    const rect = computeScreenRect(ent, overlay, projector, gameRef);
    if (!rect) return;

    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = `${color}24`;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 2 * (gameRef?.camera?.zoom || 1));
    ctx.strokeStyle = color;
    ctx.stroke();

    const label =
      ent === gameRef.me ? 'YOU' : (typeof ent.level === 'number' ? `LV ${ent.level}` : '');
    if (label) {
      ctx.font = `${12 * clamp(gameRef?.camera?.zoom || 1, 1, 3)}px Arial`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(label, rect.cx, rect.y - 6);
    }
  };

  const createKeyboardShortcuts = (doc, settings, redraw) => {
    doc.addEventListener('keydown', (e) => {
      if (!e.key) return;
      const key = e.key.toLowerCase();
      if (key === 'h') {
        settings.toggle('showHitbox');
        redraw();
      }
    });
  };

  const createHitboxOverlay = (deps = {}) => {
    const win = deps.window || global;
    const doc = deps.document || global.document;
    const getGame = () => deps.game || global.game;

    const settings = createSettingsStore(win.localStorage);
    const overlay = createOverlay(win, doc);
    const projector = createProjector(overlay, getGame);

    let rafId = null;

    const drawAll = () => {
      overlay.syncToGameCanvas();
      overlay.clear();
      if (settings.get().showHitbox) {
        const gameRef = getGame();
        if (!gameRef?.hashMap || !gameRef.sortToDraw) return;
        const visible = gameRef.sortToDraw(gameRef.hashMap.retrieveVisibleByClient(gameRef)) || [];
        for (let i = 0; i < visible.length; i += 1) {
          const ent = visible[i];
          if (!ent || ent.deleted || !ent.position) continue;
          if (ent.hp == null || ent.level == null) continue; // focus on player-like entities
          drawEntityHitbox(ent, overlay, projector, getGame, ent === gameRef.me ? 'rgba(255,0,0,0.95)' : 'rgba(0,140,255,0.95)');
        }
      }
    };

    const loop = () => {
      try {
        drawAll();
      } catch (_e) {
        /* ignored */
      }
      rafId = win.requestAnimationFrame(loop);
    };

    const start = () => {
      overlay.ensureCanvas();
      if (!rafId) loop();
    };

    const stop = () => {
      if (rafId) win.cancelAnimationFrame(rafId);
      rafId = null;
      overlay.clear();
    };

    createKeyboardShortcuts(doc, settings, drawAll);

    return { start, stop, settings };
  };

  const hitboxOverlay = createHitboxOverlay();
  hitboxOverlay.start();
  global.EvoHitboxOverlay = hitboxOverlay;
})(typeof window !== 'undefined' ? window : this);
