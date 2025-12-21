// ==UserScript==
// @name         Enhanced Autohit + Hitbox Overlay (Library Ready)
// @version      2.1.0
// @description  Modular autohit helper for evoworld.io with hitbox overlay, directional markers, and zoom controls. Exposes window.EvoAutoHit for library-style use.
// @author       ChatGPT
// @match        https://evoworld.io/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=evoworld.io
// @license      MIT
// @grant        none
// @namespace    https://greasyfork.org/users/1536224
// ==/UserScript==

/* globals game, gameServer, socketMsgType, joinedGame, latency, lastFps, skillUse, skillStop */

(function bootstrap(global) {
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

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const createSettingsStore = (storage = global.localStorage) => {
    const load = () => {
      try {
        return { ...DEFAULT_SETTINGS, ...(JSON.parse(storage.getItem(STORAGE_KEY) || '{}')) };
      } catch (error) {
        console.warn('[EvoAutoHit] Failed to load settings:', error);
        return { ...DEFAULT_SETTINGS };
      }
    };

    let data = load();
    const listeners = new Set();

    const persist = () => {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch (error) {
        console.warn('[EvoAutoHit] Failed to persist settings:', error);
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
      onChange: (fn) => listeners.add(fn),
      offChange: (fn) => listeners.delete(fn),
      toggle: (key) => update({ [key]: !data[key] }),
      set: (key, value) => update({ [key]: value }),
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
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = 9998;
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
    if (ent.name && HEIGHT[ent.name]) {
      const h = HEIGHT[ent.name];
      return { w: Math.max(30, Math.min(400, h * 0.6)), h: Math.min(400, h) };
    }
    return { w: 40, h: 80 };
  };

  const getHalfExtents = (ent) => {
    const { w, h } = getEntitySize(ent);
    return { halfW: w / 2, halfH: h / 2 };
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

      if (!transformed && gameRef.camera && typeof gameRef.camera.toScreen === 'function') {
        const p = gameRef.camera.toScreen(pos);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return { x: Math.round(p.x), y: Math.round(p.y), vis: true };
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
    } catch (error) {
      console.warn('[EvoAutoHit] projector failure', error);
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

  const classifyEntity = (ent, me) => {
    if (!ent || ent === me) return 'skip';
    const isPlayerLike = ent.hp != null && ent.level != null;
    const myLevel = me?.level || 0;

    if (ent.food === true || ent.type === 'food') return 'food';

    if (isPlayerLike) {
      if (typeof ent.level === 'number') {
        if (ent.level > myLevel + 0.5) return 'threat';
        if (ent.level < myLevel - 0.2) return 'prey';
      }
      const myBox = getEntitySize(me);
      const otherBox = getEntitySize(ent);
      const ratio = (otherBox.w * otherBox.h) / Math.max(1, myBox.w * myBox.h);
      if (ratio > 1.35) return 'threat';
      if (ratio < 0.8) return 'prey';
    }
    return 'neutral';
  };

  const drawArrowTowards = (ctx, canvas, screenPos, color, label) => {
    if (!ctx || !canvas || !screenPos) return;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = screenPos.x - cx;
    const dy = screenPos.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const pad = 28;
    const maxX = (canvas.width / 2 - pad) / (Math.abs(nx) || 1);
    const maxY = (canvas.height / 2 - pad) / (Math.abs(ny) || 1);
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

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    if (label) {
      ctx.font = '12px Arial';
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(label, tipX, tipY - 6);
    }
  };

  const simulateQuickArrowKey = (code, doc) => {
    const down = new KeyboardEvent('keydown', { keyCode: code, which: code, bubbles: true, cancelable: true });
    doc.dispatchEvent(down);
    setTimeout(() => {
      const up = new KeyboardEvent('keyup', { keyCode: code, which: code, bubbles: true, cancelable: true });
      doc.dispatchEvent(up);
    }, 35);
  };

  const AutoHitEngine = (deps) => {
    const { getGame, getServer, msgTypes, settings, projector, overlay, doc } = deps;
    let overlayLoopId = null;
    let flicking = settings.get().autohit;

    const getMagnitude = (pos) => {
      const gameRef = getGame();
      if (!gameRef?.me?.position) return Number.POSITIVE_INFINITY;
      const myPos = gameRef.me.position;
      return Math.abs(myPos.x - pos.x) + Math.abs(myPos.y - pos.y);
    };

    const getClosestReaper = () => {
      const gameRef = getGame();
      if (!gameRef || !gameRef.me || gameRef.me.deleted || typeof joinedGame === 'undefined' || !joinedGame) return undefined;
      if (!gameRef.hashMap || !gameRef.sortToDraw) return undefined;
      const list = gameRef.sortToDraw(gameRef.hashMap.retrieveVisibleByClient(gameRef)) || [];
      const candidates = list.filter((ent) => ent && !ent.deleted && ent.hp != null && ent.level != null && REAPER_LIST.has(ent.name) && ent !== gameRef.me);
      let closest;
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < candidates.length; i += 1) {
        const magn = getMagnitude(candidates[i].position);
        if (magn < best) {
          best = magn;
          closest = candidates[i];
        }
      }
      return closest;
    };

    const isWithinXRange = (attacker, target, rangeTable, distAdjustment = 0) => {
      if (!attacker || !target) return false;
      const aX = attacker.position.x;
      const bX = target.position.x;
      const aHalf = getHalfExtents(attacker).halfW;
      const bHalf = getHalfExtents(target).halfW;
      const relativeSpeed =
        Math.abs((attacker.moveSpeed?.x || 0) - (target.moveSpeed?.x || 0));
      const frameTime = typeof lastFps === 'number' && lastFps > 0 ? 1000 / lastFps : 16;
      const serverDelay = typeof latency === 'number' ? latency : 0;
      const totalDelay = frameTime + serverDelay;
      const centerDist = Math.abs(bX - aX);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - (totalDelay * relativeSpeed) / 1000 + distAdjustment;
      let allowedRange = 0;
      if (rangeTable && attacker.name && target.name && rangeTable[attacker.name]) {
        allowedRange = rangeTable[attacker.name][target.name] ?? 0;
      }
      return effectiveDist <= allowedRange;
    };

    const isWithinYRange = (attacker, target, heights, distAdjustment = 0) => {
      if (!attacker || !target) return false;
      const aY = attacker.position.y;
      const bY = target.position.y;
      const aHalf = getHalfExtents(attacker).halfH;
      const bHalf = getHalfExtents(target).halfH;
      const relativeSpeed =
        Math.abs((attacker.moveSpeed?.y || 0) - (target.moveSpeed?.y || 0));
      const frameTime = typeof lastFps === 'number' && lastFps > 0 ? 1000 / lastFps : 16;
      const serverDelay = typeof latency === 'number' ? latency : 0;
      const totalDelay = frameTime + serverDelay;
      const centerDist = Math.abs(bY - aY);
      const edgeGap = centerDist - (aHalf + bHalf);
      const effectiveDist = edgeGap - (totalDelay * relativeSpeed) / 1000 + distAdjustment;
      let allowedRange = 0;
      if (heights && attacker.name && target.name) {
        allowedRange = heights[target.name] || heights[attacker.name] || 0;
      }
      return effectiveDist <= allowedRange;
    };

    const autoHit = () => {
      const gameRef = getGame();
      const enemy = getClosestReaper();
      if (!gameRef || typeof enemy !== 'object' || !REAPER_LIST.has(gameRef?.me?.name)) return;
      const onLeft = gameRef.me.position.x <= enemy.position.x;
      const enemyFlicking = (onLeft && enemy.direction === 1) || (!onLeft && enemy.direction === -1);
      const facingEnemy = flicking ? (onLeft ? gameRef.me.direction === 1 : gameRef.me.direction === -1) : true;

      const attemptAttack = (rangeTable, distAdj = 0) => {
        if (isWithinXRange(gameRef.me, enemy, rangeTable, distAdj) && isWithinYRange(gameRef.me, enemy, HEIGHT)) {
          if (!facingEnemy) {
            simulateQuickArrowKey(onLeft ? 39 : 37, doc);
          }
          skillUse?.();
          setTimeout(() => skillStop?.(), 100);
        }
      };

      if (facingEnemy) {
        attemptAttack(enemyFlicking ? HitBackRangeX : HitRangeX);
      } else {
        attemptAttack(enemyFlicking ? HitBackRangeX : HitRangeX, enemyFlicking ? -25 : -5);
      }
    };

    const drawEntityHighlight = (ent, cls) => {
      const gameRef = getGame();
      const ctx = overlay.ctx;
      const canvas = overlay.canvas;
      if (!ctx || !canvas || !ent?.position) return;
      const screen = projector(ent.position);
      if (!screen.vis) return;
      let scale = 1;
      try {
        scale =
          (gameRef?.camera && typeof gameRef.camera.zoom === 'number' && gameRef.camera.zoom) ||
          (gameRef?.renderer && typeof gameRef.renderer.scale === 'number' && gameRef.renderer.scale) ||
          1;
      } catch {
        scale = 1;
      }

      const { w, h } = getEntitySize(ent);
      const drawW = w * scale;
      const drawH = h * scale;
      const x = screen.x - drawW / 2;
      const y = screen.y - drawH / 2;
      let color = 'rgba(255,200,50,0.8)';
      if (cls === 'threat') color = 'rgba(255,60,60,0.85)';
      else if (cls === 'prey' || cls === 'food') color = 'rgba(60,200,80,0.85)';

      ctx.beginPath();
      ctx.rect(x, y, drawW, drawH);
      ctx.lineWidth = Math.max(1.5, 2 * scale);
      ctx.strokeStyle = color;
      ctx.stroke();

      const tipX = screen.x;
      const tipY = y - 10 * scale;
      const baseY = tipY - 16 * scale;
      const wing = 8 * scale;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - wing, baseY);
      ctx.lineTo(tipX + wing, baseY);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    const drawDirectionalMarkers = () => {
      const gameRef = getGame();
      if (!gameRef?.hashMap || !gameRef.sortToDraw || !gameRef.me) return;
      const ctx = overlay.ctx;
      if (!ctx || !overlay.canvas) return;
      const visible = gameRef.sortToDraw(gameRef.hashMap.retrieveVisibleByClient(gameRef)) || [];
      let nearestThreat = null;
      let nearestThreatDist = Number.POSITIVE_INFINITY;
      let nearestEdible = null;
      let nearestEdibleDist = Number.POSITIVE_INFINITY;

      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted || ent === gameRef.me) continue;
        const cls = classifyEntity(ent, gameRef.me);
        if (cls === 'skip' || cls === 'neutral') continue;
        if (!ent.position) continue;
        const mag = getMagnitude(ent.position);
        if (cls === 'threat' && mag < nearestThreatDist) {
          nearestThreat = ent;
          nearestThreatDist = mag;
        } else if ((cls === 'prey' || cls === 'food') && mag < nearestEdibleDist) {
          nearestEdible = ent;
          nearestEdibleDist = mag;
        }
      }

      if (nearestThreat?.position) {
        drawArrowTowards(ctx, overlay.canvas, projector(nearestThreat.position), 'rgba(255,60,60,0.9)', 'DANGER');
      }
      if (nearestEdible?.position) {
        drawArrowTowards(ctx, overlay.canvas, projector(nearestEdible.position), 'rgba(60,200,80,0.9)', 'EAT');
      }
    };

    const drawMyHitbox = () => {
      const gameRef = getGame();
      const ctx = overlay.ctx;
      if (!ctx || !gameRef?.me?.position) return;
      const screen = projector(gameRef.me.position);
      if (!screen.vis) return;
      const { w, h } = getEntitySize(gameRef.me);
      let scale = 1;
      try {
        scale =
          (gameRef?.camera && typeof gameRef.camera.zoom === 'number' && gameRef.camera.zoom) ||
          (gameRef?.renderer && typeof gameRef.renderer.scale === 'number' && gameRef.renderer.scale) ||
          1;
      } catch {
        scale = 1;
      }
      const drawW = w * scale;
      const drawH = h * scale;
      const x = screen.x - drawW / 2;
      const y = screen.y - drawH / 2;
      ctx.beginPath();
      ctx.rect(x, y, drawW, drawH);
      ctx.fillStyle = 'rgba(255,0,0,0.14)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, 2 * scale);
      ctx.strokeStyle = 'rgba(255,0,0,0.95)';
      ctx.stroke();
      ctx.font = `${12 * Math.max(1, scale)}px Arial`;
      ctx.fillStyle = 'rgba(255,0,0,0.95)';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', screen.x, y - 6 * scale);
    };

    const drawEntityHighlights = () => {
      const gameRef = getGame();
      if (!gameRef?.hashMap || !gameRef.sortToDraw || !gameRef.me) return;
      const visible = gameRef.sortToDraw(gameRef.hashMap.retrieveVisibleByClient(gameRef)) || [];
      for (let i = 0; i < visible.length; i += 1) {
        const ent = visible[i];
        if (!ent || ent.deleted || ent === gameRef.me) continue;
        if (!ent.position || !Number.isFinite(ent.position.x) || !Number.isFinite(ent.position.y)) continue;
        const cls = classifyEntity(ent, gameRef.me);
        if (cls === 'skip' || cls === 'neutral') continue;
        drawEntityHighlight(ent, cls);
      }
    };

    const drawAll = () => {
      overlay.syncToGameCanvas();
      overlay.clear();
      const config = settings.get();
      if (!getGame()?.me) return;
      if (config.showHitbox) drawMyHitbox();
      if (config.showArrows) {
        drawDirectionalMarkers();
        drawEntityHighlights();
      }
    };

    const applyZoomLevel = (force = false) => {
      const config = settings.get();
      if (!config.zoomEnabled && !force) return;
      const target = config.zoomLevel;
      const canvasEl = findGameCanvas(doc);
      const gameRef = getGame();
      if (config.zoomUseCamera) {
        try {
          if (gameRef?.camera && typeof gameRef.camera.zoom === 'number') {
            gameRef.camera.zoom = target;
          } else if (gameRef?.camera && typeof gameRef.camera.scale === 'number') {
            gameRef.camera.scale = target;
          } else if (gameRef?.renderer && typeof gameRef.renderer.scale === 'number') {
            gameRef.renderer.scale = target;
          }
        } catch (error) {
          console.warn('[EvoAutoHit] failed native zoom', error);
        }
      }
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
    };

    const startOverlayLoop = () => {
      if (overlayLoopId) return;
      const loop = () => {
        try {
          drawAll();
        } catch (error) {
          console.warn('[EvoAutoHit] draw loop error', error);
        }
        overlayLoopId = global.requestAnimationFrame(loop);
      };
      loop();
    };

    const stopOverlayLoop = () => {
      if (overlayLoopId) global.cancelAnimationFrame(overlayLoopId);
      overlayLoopId = null;
      overlay.clear();
    };

    const onServerSync = () => {
      const config = settings.get();
      if (config.autohit) autoHit();
      if (config.showHitbox || config.showArrows) {
        try {
          drawAll();
        } catch (error) {
          console.warn('[EvoAutoHit] draw on sync error', error);
        }
      }
      applyZoomLevel(false);
    };

    const bindServer = () => {
      const server = getServer();
      if (!server?.on || !msgTypes?.SYNC) return;
      server.on(msgTypes.SYNC, onServerSync);
      server.on('disconnect', waitForServer);
      return () => {
        try {
          server.off?.(msgTypes.SYNC, onServerSync);
          server.off?.('disconnect', waitForServer);
        } catch (error) {
          console.warn('[EvoAutoHit] failed to detach', error);
        }
      };
    };

    let unbindServer = null;

    const waitForServer = () => {
      if (unbindServer) {
        unbindServer();
        unbindServer = null;
      }
      setTimeout(() => {
        unbindServer = bindServer();
      }, 1000);
    };

    const handleSettingsChange = (config) => {
      if (config.autohit || config.showHitbox || config.showArrows) startOverlayLoop();
      else stopOverlayLoop();
      applyZoomLevel(true);
    };

    settings.onChange(handleSettingsChange);

    const init = () => {
      overlay.ensureCanvas();
      const config = settings.get();
      if (config.autohit || config.showHitbox || config.showArrows) startOverlayLoop();
      applyZoomLevel(true);
      unbindServer = bindServer();
      setInterval(() => applyZoomLevel(false), 750);
    };

    const teardown = () => {
      stopOverlayLoop();
      unbindServer?.();
      settings.offChange(handleSettingsChange);
    };

    return {
      init,
      teardown,
      autoHit,
      applyZoomLevel,
      startOverlayLoop,
      stopOverlayLoop,
    };
  };

  const createControlPanel = (doc, settings, engine) => {
    const panel = doc.createElement('div');
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
    doc.body.appendChild(panel);

    const makeButton = (id, label, isToggle, getter, onClick) => {
      const btn = doc.createElement('div');
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
      const refresh = () => {
        const active = getter();
        btn.style.backgroundColor = active ? '#4CAF50' : '#f44336';
        btn.textContent = `${label}: ${active ? 'ON' : 'OFF'}`;
      };
      btn.addEventListener('click', () => {
        onClick();
        refresh();
      });
      refresh();
      panel.appendChild(btn);
      return refresh;
    };

    const refreshers = [];

    refreshers.push(
      makeButton(
        'hitbox-toggle',
        'HITBOX',
        true,
        () => settings.get().showHitbox,
        () => settings.toggle('showHitbox'),
      ),
    );
    refreshers.push(
      makeButton(
        'autohit-toggle',
        'AUTOHIT',
        true,
        () => settings.get().autohit,
        () => settings.toggle('autohit'),
      ),
    );
    refreshers.push(
      makeButton(
        'zoom-toggle',
        'ZOOM',
        true,
        () => settings.get().zoomEnabled,
        () => settings.toggle('zoomEnabled'),
      ),
    );
    refreshers.push(
      makeButton(
        'arrows-toggle',
        'ARROWS',
        true,
        () => settings.get().showArrows,
        () => settings.toggle('showArrows'),
      ),
    );
    refreshers.push(
      makeButton(
        'zoom-mode-toggle',
        'MODE',
        true,
        () => true,
        () => settings.set('zoomUseCamera', !settings.get().zoomUseCamera),
      ),
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
    const zoomInput = doc.createElement('input');
    zoomInput.type = 'range';
    zoomInput.min = '0.3';
    zoomInput.max = '1.5';
    zoomInput.step = '0.05';
    zoomInput.value = String(settings.get().zoomLevel);
    zoomInput.style.flex = '1';
    const zoomValue = doc.createElement('span');
    zoomValue.textContent = `${(settings.get().zoomLevel * 100).toFixed(0)}%`;
    zoomInput.addEventListener('input', () => {
      const value = clamp(Number(zoomInput.value), 0.3, 1.5);
      settings.set('zoomLevel', value);
      zoomValue.textContent = `${(value * 100).toFixed(0)}%`;
      engine.applyZoomLevel(true);
    });
    zoomRow.append(zoomLabel, zoomInput, zoomValue);
    panel.appendChild(zoomRow);

    const refreshAll = () => refreshers.forEach((fn) => fn());
    return { refreshAll, panel, zoomInput, zoomValue };
  };

  const createKeyboardShortcuts = (doc, ui, settings) => {
    doc.addEventListener('keydown', (e) => {
      if (!e.key) return;
      const key = e.key.toLowerCase();
      if (key === 'h') {
        settings.toggle('showHitbox');
      } else if (key === 'r' || e.keyCode === 40) {
        settings.toggle('autohit');
      } else if (key === 'z') {
        settings.toggle('zoomEnabled');
      } else if (key === '-' || key === '_') {
        settings.set('zoomLevel', clamp(settings.get().zoomLevel - 0.05, 0.5, 1.5));
        ui.zoomInput.value = String(settings.get().zoomLevel);
        ui.zoomValue.textContent = `${(settings.get().zoomLevel * 100).toFixed(0)}%`;
      } else if (key === '=' || key === '+') {
        settings.set('zoomLevel', clamp(settings.get().zoomLevel + 0.05, 0.5, 1.5));
        ui.zoomInput.value = String(settings.get().zoomLevel);
        ui.zoomValue.textContent = `${(settings.get().zoomLevel * 100).toFixed(0)}%`;
      }
      ui.refreshAll();
    });
  };

  const createEvoAutoHit = (deps = {}) => {
    const win = deps.window || global;
    const doc = deps.document || global.document;
    const getGame = () => deps.game || global.game;
    const getServer = () => deps.gameServer || global.gameServer;
    const msgTypes = deps.socketMsgType || global.socketMsgType;

    const settings = createSettingsStore(win.localStorage);
    const overlay = createOverlay(win, doc);
    const projector = createProjector(overlay, getGame);
    const engine = AutoHitEngine({ getGame, getServer, msgTypes, settings, projector, overlay, doc });
    const ui = createControlPanel(doc, settings, engine);
    createKeyboardShortcuts(doc, ui, settings);

    return {
      start: engine.init,
      stop: engine.teardown,
      settings,
    };
  };

  const autoHitInstance = createEvoAutoHit();
  autoHitInstance.start();
  global.EvoAutoHit = autoHitInstance;
})(typeof window !== 'undefined' ? window : this);
