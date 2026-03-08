/**
 * Tabbed editor: furniture | characters | behavior
 * Owns the panel chrome, tab switching, and input routing.
 * Delegates to FurnitureSystem for furniture data/rendering.
 */

import type { Miniverse, Resident } from 'miniverse';
import {
  FurnitureSystem,
  ANCHOR_COLORS,
  ANCHOR_TYPES,
  type AnchorType,
  type Anchor,
  type LoadedPiece,
} from './furniture';

export type EditorTab = 'world' | 'furniture' | 'characters' | 'behavior';

export class Editor {
  private active = false;
  private tab: EditorTab = 'world';

  private canvas: HTMLCanvasElement;
  private scale: number;
  private tileSize: number;
  private furniture: FurnitureSystem;
  private mv: Miniverse;

  // DOM
  private wrapper: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private tabBtns: Map<EditorTab, HTMLElement> = new Map();
  private tabContent: HTMLElement | null = null;

  // Undo/redo
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private maxHistory = 50;
  private preActionSnapshot: string | null = null;

  // Characters state
  private selectedResidentId: string | null = null;

  // Behavior state
  private selAnchorPiece: LoadedPiece | null = null;
  private selAnchorIdx = -1;
  private draggingAnchor = false;
  private dragAnchorOx = 0;
  private dragAnchorOy = 0;

  constructor(
    canvas: HTMLCanvasElement,
    furniture: FurnitureSystem,
    mv: Miniverse,
  ) {
    this.canvas = canvas;
    this.scale = furniture.getScale();
    this.tileSize = furniture.getTileSize();
    this.furniture = furniture;
    this.mv = mv;

    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);

    window.addEventListener('keydown', this.onKeyDown);
  }

  isActive(): boolean { return this.active; }
  getTab(): EditorTab { return this.tab; }

  // --- Rendering (called from addLayer) ---

  renderOverlay(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;
    ctx.save();
    this.renderGrid(ctx);

    switch (this.tab) {
      case 'world': this.renderWorldOverlay(ctx); break;
      case 'furniture': this.renderFurnitureOverlay(ctx); break;
      case 'characters': this.renderCharactersOverlay(ctx); break;
      case 'behavior': this.renderBehaviorOverlay(ctx); break;
    }
    ctx.restore();
  }

  // --- Grid (shared across tabs) ---

  private renderGrid(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 0.5;
    const cw = ctx.canvas.width / this.scale;
    const ch = ctx.canvas.height / this.scale;
    for (let x = 0; x <= cw; x += T) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
    }
    for (let y = 0; y <= ch; y += T) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
    }
  }

  // --- World overlay ---

  private selectedTileId = 0;
  private tileNames: Record<number, string> = {
    0: 'Bamboo Floor',
    1: 'White Wall',
    2: 'Wood Slat Wall',
    3: 'Greenery Wall',
    4: 'Window',
    5: 'Door',
  };

  private renderWorldOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;
    const floor = this.mv.getFloorLayer();
    if (!floor) return;

    for (let r = 0; r < floor.length; r++) {
      for (let c = 0; c < floor[r].length; c++) {
        const tid = floor[r][c];
        if (tid < 0) {
          // Deadspace — dark fill with X
          ctx.fillStyle = 'rgba(0,0,0,0.85)';
          ctx.fillRect(c * T, r * T, T, T);
          ctx.strokeStyle = 'rgba(255,50,50,0.4)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(c * T + 4, r * T + 4);
          ctx.lineTo((c + 1) * T - 4, (r + 1) * T - 4);
          ctx.moveTo((c + 1) * T - 4, r * T + 4);
          ctx.lineTo(c * T + 4, (r + 1) * T - 4);
          ctx.stroke();
        } else if (tid === 1) {
          // Wall hint
          ctx.globalAlpha = 0.15;
          ctx.fillStyle = '#ff4444';
          ctx.fillRect(c * T, r * T, T, T);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  private buildWorldTab() {
    const c = this.tabContent!;

    // Controls
    const hint = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    hint.innerHTML = [
      '<span style="color:#00ff88">Click</span> paint tile',
      '<span style="color:#00ff88">Drag</span> paint area',
    ].join('<br>');
    c.appendChild(hint);

    // Grid size
    const gridSection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; display:flex; align-items:center; gap:6px;');
    const { cols, rows } = this.mv.getGridSize();
    this.gridLabel = this.el('span', 'flex:1; color:#888; font-size:10px;');
    this.gridLabel.textContent = `Grid: ${cols}×${rows}`;
    gridSection.appendChild(this.gridLabel);
    gridSection.appendChild(this.makeBtn('+C', () => { this.beginAction(); this.resizeGrid(1, 0); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('-C', () => { this.beginAction(); this.resizeGrid(-1, 0); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('+R', () => { this.beginAction(); this.resizeGrid(0, 1); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('-R', () => { this.beginAction(); this.resizeGrid(0, -1); this.commitAction(); }));
    c.appendChild(gridSection);

    // Tile palette
    const palLabel = this.el('div', 'padding:4px 10px; color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px;');
    palLabel.textContent = 'Tiles';
    c.appendChild(palLabel);

    const palette = this.el('div', 'padding:4px 8px; display:flex; flex-wrap:wrap; gap:4px;');

    // Deadspace tile (always first)
    const deadItem = this.el('div', `
      width:40px; height:40px; border:2px solid ${this.selectedTileId === -1 ? '#00ff88' : '#333'}; border-radius:3px;
      cursor:pointer; background:#0a0a0a; overflow:hidden; position:relative;
      display:flex; align-items:center; justify-content:center;
    `);
    deadItem.title = 'Deadspace (void)';
    const skull = this.el('span', 'font-size:20px; opacity:0.6; user-select:none;');
    skull.textContent = '\u2620';
    deadItem.appendChild(skull);
    deadItem.addEventListener('click', () => {
      this.selectedTileId = -1;
      this.buildTabContent();
    });
    palette.appendChild(deadItem);

    const tsImg = this.mv.getTilesetImage();
    const tsConfig = this.mv.getTilesetConfig();

    if (tsImg && tsConfig) {
      const tileCount = tsConfig.columns * Math.ceil(tsImg.naturalHeight / tsConfig.tileHeight);

      // Scan tiles to find which ones have content
      const scanCanvas = document.createElement('canvas');
      scanCanvas.width = tsImg.naturalWidth;
      scanCanvas.height = tsImg.naturalHeight;
      const scanCtx = scanCanvas.getContext('2d')!;
      scanCtx.drawImage(tsImg, 0, 0);

      const tilesWithContent: number[] = [];
      for (let i = 0; i < tileCount; i++) {
        const sx = (i % tsConfig.columns) * tsConfig.tileWidth;
        const sy = Math.floor(i / tsConfig.columns) * tsConfig.tileHeight;
        const data = scanCtx.getImageData(sx, sy, tsConfig.tileWidth, tsConfig.tileHeight).data;
        let hasContent = false;
        for (let p = 3; p < data.length; p += 4) {
          if (data[p] > 0) { hasContent = true; break; }
        }
        if (hasContent) tilesWithContent.push(i);
      }

      for (const i of tilesWithContent) {
        const tileName = this.tileNames[i] ?? `Tile ${i}`;
        const item = this.el('div', `
          width:40px; height:40px; border:2px solid ${i === this.selectedTileId ? '#00ff88' : '#333'}; border-radius:3px;
          cursor:pointer; background:#1a1a2e; overflow:hidden; position:relative;
        `);
        item.title = tileName;
        // Draw tile preview using a small canvas
        const preview = document.createElement('canvas');
        preview.width = tsConfig.tileWidth;
        preview.height = tsConfig.tileHeight;
        preview.style.cssText = 'width:36px; height:36px; image-rendering:pixelated;';
        const pctx = preview.getContext('2d')!;
        pctx.imageSmoothingEnabled = false;
        const sx = (i % tsConfig.columns) * tsConfig.tileWidth;
        const sy = Math.floor(i / tsConfig.columns) * tsConfig.tileHeight;
        pctx.drawImage(tsImg, sx, sy, tsConfig.tileWidth, tsConfig.tileHeight, 0, 0, tsConfig.tileWidth, tsConfig.tileHeight);
        item.appendChild(preview);

        // Label
        const label = this.el('div', 'position:absolute; bottom:0; right:1px; font-size:7px; color:#888;');
        label.textContent = `${i}`;
        item.appendChild(label);

        item.addEventListener('click', () => {
          this.selectedTileId = i;
          this.buildTabContent();
        });
        palette.appendChild(item);
      }
    }
    c.appendChild(palette);
  }

  private paintTile(wx: number, wy: number) {
    const T = this.tileSize;
    const col = Math.floor(wx / T);
    const row = Math.floor(wy / T);

    // Don't paint deadspace on tiles occupied by furniture
    if (this.selectedTileId < 0 && this.furniture.occupiesTile(col, row)) return;

    this.mv.setTile(col, row, this.selectedTileId);
  }

  // --- Furniture overlay ---

  private renderFurnitureOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;

    // Small anchor dots
    for (const p of this.furniture.pieces) {
      for (const a of p.anchors) {
        this.drawAnchorDot(ctx, (p.x + a.ox) * T + T / 2, (p.y + a.oy) * T + T / 2, a.type, 3);
      }
    }

    // Selected piece highlight
    const s = this.furniture.selected;
    if (s) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(s.x * T, s.y * T, s.w * T, s.h * T);
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = '7px monospace';
      const label = `${s.id} (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(s.x * T, s.y * T - 10, tw + 4, 10);
      ctx.fillStyle = '#00ff88';
      ctx.fillText(label, s.x * T + 2, s.y * T - 2);
    }

    this.refreshTabContent();
  }

  // --- Characters overlay ---

  private renderCharactersOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;
    for (const r of this.mv.getResidents()) {
      if (!r.visible) continue;
      const cx = r.x + T / 2;
      const cy = r.y + T / 2;
      const selected = r.agentId === this.selectedResidentId;

      ctx.beginPath();
      ctx.arc(cx, cy, selected ? 14 : 10, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? '#00ff88' : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();

      if (selected) {
        ctx.fillStyle = 'rgba(0,255,136,0.1)';
        ctx.fill();
      }
    }
    this.refreshTabContent();
  }

  // --- Behavior overlay ---

  private renderBehaviorOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;

    // Piece outlines (dimmed)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (const p of this.furniture.pieces) {
      ctx.strokeRect(p.x * T, p.y * T, p.w * T, p.h * T);
    }

    // All anchor dots (large)
    for (const p of this.furniture.pieces) {
      for (let i = 0; i < p.anchors.length; i++) {
        const a = p.anchors[i];
        const ax = (p.x + a.ox) * T + T / 2;
        const ay = (p.y + a.oy) * T + T / 2;
        const isSel = p === this.selAnchorPiece && i === this.selAnchorIdx;
        this.drawAnchorDot(ctx, ax, ay, a.type, isSel ? 7 : 5);

        if (isSel) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(ax, ay, 9, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Label
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#ccc';
        ctx.font = '6px monospace';
        ctx.fillText(a.name, (p.x + a.ox) * T + 2, (p.y + a.oy) * T - 2);
        ctx.globalAlpha = 1;
      }
    }

    // Wander points
    for (const wp of this.furniture.wanderPoints) {
      const wx = wp.x * T + T / 2;
      const wy = wp.y * T + T / 2;
      this.drawAnchorDot(ctx, wx, wy, 'wander', 5);
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(wx, wy, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.font = '6px monospace';
      ctx.fillStyle = '#888';
      ctx.fillText(wp.name, wp.x * T + 2, wp.y * T - 2);
      ctx.globalAlpha = 1;
    }

    this.refreshTabContent();
  }

  private drawAnchorDot(ctx: CanvasRenderingContext2D, x: number, y: number, type: AnchorType, r: number) {
    ctx.fillStyle = ANCHOR_COLORS[type];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // --- Panel ---

  private buildPanel() {
    if (this.panel) return;

    const container = this.canvas.parentElement!;
    this.wrapper = document.createElement('div');
    this.wrapper.id = 'editor-wrapper';
    this.wrapper.style.cssText = 'display:flex; gap:0; align-items:stretch;';
    container.parentElement!.insertBefore(this.wrapper, container);
    this.wrapper.appendChild(container);

    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      width: 190px;
      background: #111;
      border: 2px solid #00ff88;
      border-left: none;
      border-radius: 0 4px 4px 0;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      color: #ccc;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    `;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex; border-bottom:1px solid #333;';
    const tabs: EditorTab[] = ['world', 'furniture', 'characters', 'behavior'];
    for (const t of tabs) {
      const btn = document.createElement('div');
      btn.textContent = t.charAt(0).toUpperCase() + t.slice(1, 4);
      btn.style.cssText = `
        flex:1; text-align:center; padding:6px 0; cursor:pointer;
        font-size:10px; text-transform:uppercase; letter-spacing:1px;
        transition: background 0.1s, color 0.1s;
      `;
      btn.addEventListener('click', () => this.switchTab(t));
      tabBar.appendChild(btn);
      this.tabBtns.set(t, btn);
    }
    this.panel.appendChild(tabBar);

    // Content area
    this.tabContent = document.createElement('div');
    this.tabContent.style.cssText = 'flex:1; overflow-y:auto; display:flex; flex-direction:column;';
    this.panel.appendChild(this.tabContent);

    // Undo/redo bar (bottom)
    const undoBar = document.createElement('div');
    undoBar.style.cssText = 'display:flex; border-top:1px solid #333; padding:4px 6px; gap:4px; margin-top:auto;';
    const undoBtn = this.makeBtn('⟵ Undo', () => this.undo());
    const redoBtn = this.makeBtn('Redo ⟶', () => this.redo());
    undoBtn.style.cssText += 'flex:1; text-align:center; font-size:11px; padding:4px 0;';
    redoBtn.style.cssText += 'flex:1; text-align:center; font-size:11px; padding:4px 0;';
    undoBar.appendChild(undoBtn);
    undoBar.appendChild(redoBtn);
    this.panel.appendChild(undoBar);

    this.wrapper.appendChild(this.panel);
    this.updateTabStyles();
    this.buildTabContent();
  }

  private updateTabStyles() {
    for (const [t, btn] of this.tabBtns) {
      if (t === this.tab) {
        btn.style.background = '#00ff8825';
        btn.style.color = '#00ff88';
        btn.style.borderBottom = '2px solid #00ff88';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = '#666';
        btn.style.borderBottom = '2px solid transparent';
      }
    }
  }

  private switchTab(tab: EditorTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.furniture.selected = null;
    this.selAnchorPiece = null;
    this.selAnchorIdx = -1;
    this.selectedResidentId = null;
    this.updateTabStyles();
    this.buildTabContent();
  }

  private buildTabContent() {
    if (!this.tabContent) return;
    this.tabContent.innerHTML = '';
    switch (this.tab) {
      case 'world': this.buildWorldTab(); break;
      case 'furniture': this.buildFurnitureTab(); break;
      case 'characters': this.buildCharactersTab(); break;
      case 'behavior': this.buildBehaviorTab(); break;
    }
  }

  private refreshTabContent() {
    switch (this.tab) {
      case 'world': break; // static panel, no per-frame refresh needed
      case 'furniture': this.refreshFurnitureTab(); break;
      case 'characters': this.refreshCharactersTab(); break;
      case 'behavior': this.refreshBehaviorTab(); break;
    }
  }

  // --- Furniture tab ---

  private furnitureInfo: HTMLElement | null = null;

  private buildFurnitureTab() {
    const c = this.tabContent!;

    // Controls
    const controls = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    controls.innerHTML = [
      '<span style="color:#00ff88">Drag</span> move',
      '<span style="color:#00ff88">Arrows</span> nudge',
      '<span style="color:#00ff88">+ / -</span> resize',
      '<span style="color:#00ff88">L</span> layer',
      '<span style="color:#00ff88">Del</span> remove',
      '<span style="color:#00ff88">S</span> save',
    ].join('<br>');
    c.appendChild(controls);

    // Selected info
    this.furnitureInfo = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; min-height:36px; color:#888;');
    this.furnitureInfo.innerHTML = '<span style="color:#555">Click a piece</span>';
    c.appendChild(this.furnitureInfo);

    // Inventory
    const invLabel = this.el('div', 'padding:4px 10px; color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px;');
    invLabel.textContent = 'Inventory';
    c.appendChild(invLabel);

    const grid = this.el('div', 'padding:4px 8px; display:flex; flex-wrap:wrap; gap:4px;');
    for (const [id, src] of this.furniture.getImageSrcs()) {
      const item = this.el('div', `
        width:40px; height:40px; border:1px solid #333; border-radius:3px;
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; background:#1a1a2e;
      `);
      item.title = id;
      const thumb = document.createElement('img');
      thumb.src = src;
      thumb.style.cssText = 'max-width:34px; max-height:34px; image-rendering:pixelated;';
      item.appendChild(thumb);
      item.addEventListener('mouseenter', () => { item.style.borderColor = '#00ff88'; });
      item.addEventListener('mouseleave', () => { item.style.borderColor = '#333'; });
      item.addEventListener('click', () => {
        this.beginAction();
        const p = this.furniture.addPiece(id);
        if (p) this.furniture.selected = p;
        this.commitAction();
      });
      grid.appendChild(item);
    }
    c.appendChild(grid);
  }

  private refreshFurnitureTab() {
    if (!this.furnitureInfo) return;
    const s = this.furniture.selected;
    if (!s) {
      this.furnitureInfo.innerHTML = '<span style="color:#555">Click a piece</span>';
      return;
    }
    const anchors = s.anchors.length > 0
      ? s.anchors.map(a => `<span style="color:${ANCHOR_COLORS[a.type]}">\u25CF</span> ${a.name}`).join('<br>')
      : '<span style="color:#555">no anchors</span>';
    this.furnitureInfo.innerHTML = [
      `<span style="color:#00ff88">${s.id}</span>`,
      `pos: ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`,
      `size: ${s.w.toFixed(1)}\u00D7${s.h.toFixed(1)}  layer: <span style="color:${s.layer === 'above' ? '#ff8844' : '#4488ff'}">${s.layer}</span>`,
      anchors,
    ].join('<br>');
  }

  // --- Characters tab ---

  private charsInfo: HTMLElement | null = null;
  private charsList: HTMLElement | null = null;

  private buildCharactersTab() {
    const c = this.tabContent!;

    const hint = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    hint.innerHTML = [
      '<span style="color:#00ff88">Click</span> select resident',
      '<span style="color:#00ff88">Desk</span> assign work anchor',
    ].join('<br>');
    c.appendChild(hint);

    // Residents list
    this.charsList = this.el('div', 'padding:4px 8px; border-bottom:1px solid #333;');
    this.rebuildCharsList();
    c.appendChild(this.charsList);

    // Selected info
    this.charsInfo = this.el('div', 'padding:6px 10px; min-height:40px; color:#888;');
    this.charsInfo.innerHTML = '<span style="color:#555">Select a resident</span>';
    c.appendChild(this.charsInfo);
  }

  private rebuildCharsList() {
    if (!this.charsList) return;
    this.charsList.innerHTML = '';
    for (const r of this.mv.getResidents()) {
      const row = this.el('div', `
        padding:4px 6px; cursor:pointer; display:flex; align-items:center; gap:6px;
        border-radius:3px; margin-bottom:2px;
        border:1px solid ${r.agentId === this.selectedResidentId ? '#00ff88' : 'transparent'};
        background:${r.agentId === this.selectedResidentId ? '#00ff8815' : 'transparent'};
      `);
      const dot = this.el('span', `
        width:6px; height:6px; border-radius:50%; display:inline-block;
        background:${this.stateColor(r.state)};
      `);
      row.appendChild(dot);
      const name = this.el('span', 'flex:1;');
      name.textContent = r.name;
      row.appendChild(name);
      const pos = this.el('span', 'color:#555; font-size:9px;');
      pos.textContent = r.getHomePosition();
      row.appendChild(pos);
      row.addEventListener('click', () => {
        this.selectedResidentId = r.agentId;
        this.charsBuiltFor = null;
        this.rebuildCharsList();
      });
      this.charsList.appendChild(row);
    }
  }

  private charsBuiltFor: string | null = null;

  private refreshCharactersTab() {
    if (!this.charsInfo) return;
    if (!this.selectedResidentId) {
      this.charsBuiltFor = null;
      this.charsInfo.innerHTML = '<span style="color:#555">Select a resident</span>';
      return;
    }

    // Only rebuild if selection changed — avoids destroying active dropdowns
    if (this.charsBuiltFor === this.selectedResidentId) return;
    this.charsBuiltFor = this.selectedResidentId;

    const r = this.mv.getResident(this.selectedResidentId);
    if (!r) return;

    // Build map of which work anchors are assigned to whom
    const assigned = new Map<string, string>();
    for (const res of this.mv.getResidents()) {
      assigned.set(res.getHomePosition(), res.name);
    }

    // Only show work anchors
    const workAnchors = this.furniture.getLocations().filter(l => l.type === 'work');
    const currentHome = r.getHomePosition();
    const isWorkAnchor = workAnchors.some(a => a.name === currentHome);
    const unassignedOpt = !isWorkAnchor
      ? `<option value="${currentHome}" selected style="color:#f44">${currentHome} (not a desk)</option>`
      : '';
    const homeOptions = unassignedOpt + workAnchors.map(a => {
      const owner = assigned.get(a.name);
      const isOwn = currentHome === a.name;
      const taken = owner && !isOwn;
      return `<option value="${a.name}" ${isOwn ? 'selected' : ''} ${taken ? 'disabled' : ''}>${a.name}${taken ? ` (${owner})` : ''}</option>`;
    }).join('');

    this.charsInfo.innerHTML = [
      `<span style="color:#00ff88">${r.name}</span> <span style="color:#555">(${r.agentId})</span>`,
      `state: ${r.state}`,
      `desk: <select id="ed-home-select" style="background:#222;border:1px solid #444;color:#ccc;font-family:inherit;font-size:10px;padding:1px 2px;border-radius:2px;">${homeOptions}</select>`,
    ].join('<br>');

    const sel = this.charsInfo.querySelector('#ed-home-select') as HTMLSelectElement | null;
    sel?.addEventListener('change', () => {
      this.beginAction();
      r.setHomePosition(sel.value);
      this.saveCharacterAssignments();
      this.charsBuiltFor = null; // force info panel rebuild
      this.rebuildCharsList();
      this.commitAction();
    });
  }

  private stateColor(state: string): string {
    const map: Record<string, string> = {
      working: '#4ade80', idle: '#fbbf24', sleeping: '#818cf8',
      thinking: '#f472b6', error: '#ef4444', speaking: '#22d3ee',
    };
    return map[state] ?? '#555';
  }

  // --- Behavior tab ---

  private behaviorInfo: HTMLElement | null = null;

  private buildBehaviorTab() {
    const c = this.tabContent!;

    const hint = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    hint.innerHTML = [
      '<span style="color:#00ff88">Click</span> select anchor',
      '<span style="color:#00ff88">Drag</span> reposition',
      '<span style="color:#00ff88">T</span> cycle type',
      '<span style="color:#00ff88">Del</span> remove anchor',
      '<span style="color:#00ff88">S</span> save',
    ].join('<br>');
    c.appendChild(hint);

    // Anchor legend
    const legend = this.el('div', 'padding:4px 10px; border-bottom:1px solid #333; font-size:10px; line-height:1.6;');
    legend.innerHTML = Object.entries(ANCHOR_COLORS).map(([type, color]) =>
      `<span style="color:${color}">\u25CF</span> ${type}`
    ).join('&nbsp;&nbsp;');
    c.appendChild(legend);

    // Selected anchor info
    this.behaviorInfo = this.el('div', 'padding:6px 10px; min-height:40px; color:#888;');
    this.behaviorInfo.innerHTML = '<span style="color:#555">Click an anchor</span>';
    c.appendChild(this.behaviorInfo);

    // Anchor list (grouped by piece)
    const list = this.el('div', 'padding:4px 8px; overflow-y:auto; flex:1;');
    for (const p of this.furniture.pieces) {
      if (p.anchors.length === 0) continue;
      const group = this.el('div', 'margin-bottom:6px;');
      const header = this.el('div', 'color:#555; font-size:9px; padding:2px 0;');
      header.textContent = `${p.id} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
      group.appendChild(header);
      for (let i = 0; i < p.anchors.length; i++) {
        const a = p.anchors[i];
        const row = this.el('div', `
          padding:2px 4px; cursor:pointer; border-radius:2px;
          border:1px solid ${(p === this.selAnchorPiece && i === this.selAnchorIdx) ? '#fff' : 'transparent'};
        `);
        row.innerHTML = `<span style="color:${ANCHOR_COLORS[a.type]}">\u25CF</span> ${a.name} <span style="color:#555">(${a.type})</span>`;
        const pi = this.furniture.pieces.indexOf(p);
        row.addEventListener('click', () => {
          this.selAnchorPiece = this.furniture.pieces[pi];
          this.selAnchorIdx = i;
          this.buildTabContent();
        });
        group.appendChild(row);
      }
      list.appendChild(group);
    }
    c.appendChild(list);
  }

  private refreshBehaviorTab() {
    if (!this.behaviorInfo) return;
    if (!this.selAnchorPiece || this.selAnchorIdx < 0) {
      this.behaviorInfo.innerHTML = '<span style="color:#555">Click an anchor</span>';
      return;
    }
    const a = this.selAnchorPiece.anchors[this.selAnchorIdx];
    if (!a) return;
    this.behaviorInfo.innerHTML = [
      `<span style="color:${ANCHOR_COLORS[a.type]}">\u25CF</span> <span style="color:#fff">${a.name}</span>`,
      `type: <span style="color:${ANCHOR_COLORS[a.type]}">${a.type}</span>`,
      `offset: ${a.ox.toFixed(2)}, ${a.oy.toFixed(2)}`,
      `world: ${(this.selAnchorPiece.x + a.ox).toFixed(1)}, ${(this.selAnchorPiece.y + a.oy).toFixed(1)}`,
    ].join('<br>');
  }

  // --- Input ---

  private toWorld(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / this.scale,
      y: (e.clientY - rect.top) / this.scale,
    };
  }

  private painting = false;

  private onMouseDown(e: MouseEvent) {
    const { x, y } = this.toWorld(e);
    this.beginAction();

    if (this.tab === 'world') {
      this.paintTile(x, y);
      this.painting = true;
      e.preventDefault();
    } else if (this.tab === 'furniture') {
      if (this.furniture.handleMouseDown(x, y)) e.preventDefault();
    } else if (this.tab === 'characters') {
      this.pickResident(x, y);
    } else if (this.tab === 'behavior') {
      this.pickAnchor(x, y);
      e.preventDefault();
    }
  }

  private onMouseMove(e: MouseEvent) {
    const { x, y } = this.toWorld(e);

    if (this.tab === 'world' && this.painting) {
      this.paintTile(x, y);
      e.preventDefault();
    } else if (this.tab === 'furniture') {
      this.furniture.handleMouseMove(x, y);
      e.preventDefault();
    } else if (this.tab === 'behavior' && this.draggingAnchor && this.selAnchorPiece) {
      const T = this.tileSize;
      const a = this.selAnchorPiece.anchors[this.selAnchorIdx];
      if (a) {
        a.ox = Math.round((x / T - this.selAnchorPiece.x) * 4) / 4;
        a.oy = Math.round((y / T - this.selAnchorPiece.y) * 4) / 4;
      }
      e.preventDefault();
    }
  }

  private onMouseUp(_e: MouseEvent) {
    if (this.tab === 'furniture') this.furniture.handleMouseUp();
    this.painting = false;
    this.draggingAnchor = false;
    this.commitAction();
  }

  private pickResident(wx: number, wy: number) {
    const T = this.tileSize;
    for (const r of this.mv.getResidents()) {
      if (!r.visible) continue;
      const dx = wx - (r.x + T / 2);
      const dy = wy - (r.y + T / 2);
      if (dx * dx + dy * dy < T * T) {
        this.selectedResidentId = r.agentId;
        this.charsBuiltFor = null;
        this.rebuildCharsList();
        return;
      }
    }
    this.selectedResidentId = null;
    this.charsBuiltFor = null;
    this.rebuildCharsList();
  }

  private pickAnchor(wx: number, wy: number) {
    const T = this.tileSize;
    const hitR = 8;
    for (const p of this.furniture.pieces) {
      for (let i = 0; i < p.anchors.length; i++) {
        const a = p.anchors[i];
        const ax = (p.x + a.ox) * T + T / 2;
        const ay = (p.y + a.oy) * T + T / 2;
        const dx = wx - ax, dy = wy - ay;
        if (dx * dx + dy * dy < hitR * hitR) {
          this.selAnchorPiece = p;
          this.selAnchorIdx = i;
          this.draggingAnchor = true;
          return;
        }
      }
    }
    this.selAnchorPiece = null;
    this.selAnchorIdx = -1;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

    // E toggles editor
    if (e.key === 'e' || e.key === 'E') {
      this.active = !this.active;
      if (this.active) {
        this.buildPanel();
        this.panel!.style.display = 'flex';
        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        this.canvas.addEventListener('mouseup', this.onMouseUp);
      } else {
        this.furniture.save();
        this.saveScene();
        if (this.panel) this.panel.style.display = 'none';
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('mouseup', this.onMouseUp);
        this.furniture.selected = null;
        this.selAnchorPiece = null;
        this.selectedResidentId = null;
      }
      return;
    }

    if (!this.active) return;

    // Undo / Redo — Ctrl+Z / Ctrl+Shift+Z (or Cmd on Mac)
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault();
      this.redo();
      return;
    }

    // Global save — works on any tab
    if (e.key === 's' || e.key === 'S') {
      this.furniture.save();
      this.saveScene();
      return;
    }

    // Tab-specific keys (wrapped in undo)
    if (this.tab === 'furniture') {
      this.beginAction();
      this.furniture.handleKey(e);
      this.commitAction();
    } else if (this.tab === 'behavior') {
      this.beginAction();
      this.handleBehaviorKey(e);
      this.commitAction();
    }
  }

  private handleBehaviorKey(e: KeyboardEvent) {
    if (!this.selAnchorPiece || this.selAnchorIdx < 0) return;
    const a = this.selAnchorPiece.anchors[this.selAnchorIdx];
    if (!a) return;

    if (e.key === 't' || e.key === 'T') {
      const idx = ANCHOR_TYPES.indexOf(a.type);
      a.type = ANCHOR_TYPES[(idx + 1) % ANCHOR_TYPES.length];
      this.buildTabContent();
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.selAnchorPiece.anchors.splice(this.selAnchorIdx, 1);
      this.selAnchorPiece = null;
      this.selAnchorIdx = -1;
      this.buildTabContent();
    }

    if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 1 : 0.25;
      if (e.key === 'ArrowLeft') a.ox -= step;
      if (e.key === 'ArrowRight') a.ox += step;
      if (e.key === 'ArrowUp') a.oy -= step;
      if (e.key === 'ArrowDown') a.oy += step;
      e.preventDefault();
    }
  }

  // --- Undo / Redo ---

  private captureState(): string {
    const characters: Record<string, string> = {};
    for (const r of this.mv.getResidents()) {
      characters[r.agentId] = r.getHomePosition();
    }
    const { cols, rows } = this.mv.getGridSize();
    return JSON.stringify({
      gridCols: cols,
      gridRows: rows,
      floor: this.mv.getFloorLayer(),
      furniture: this.furniture.getLayout(),
      characters,
      wanderPoints: this.furniture.wanderPoints,
    });
  }

  private restoreState(snapshot: string) {
    const s = JSON.parse(snapshot);

    // Resize grid if needed
    const { cols, rows } = this.mv.getGridSize();
    if (s.gridCols !== cols || s.gridRows !== rows) {
      this.mv.resizeGrid(s.gridCols, s.gridRows);
    }

    // Restore floor
    if (s.floor) {
      const floor = this.mv.getFloorLayer();
      for (let r = 0; r < s.floor.length && r < floor.length; r++) {
        for (let c = 0; c < s.floor[r].length && c < floor[r].length; c++) {
          floor[r][c] = s.floor[r][c];
        }
      }
    }

    // Restore furniture
    this.furniture.setLayout(s.furniture ?? []);
    if (s.wanderPoints) this.furniture.setWanderPoints(s.wanderPoints);

    // Restore characters
    if (s.characters) {
      for (const r of this.mv.getResidents()) {
        if (s.characters[r.agentId]) r.setHomePosition(s.characters[r.agentId]);
      }
    }

    // Clear selection state
    this.furniture.selected = null;
    this.selAnchorPiece = null;
    this.selAnchorIdx = -1;
    this.charsBuiltFor = null;

    // Refresh UI
    if (this.gridLabel) {
      const sz = this.mv.getGridSize();
      this.gridLabel.textContent = `Grid: ${sz.cols}×${sz.rows}`;
    }
    this.buildTabContent();
  }

  /** Call before an action to prepare for undo */
  private beginAction() {
    this.preActionSnapshot = this.captureState();
  }

  /** Call after an action completes to push undo state */
  private commitAction() {
    if (!this.preActionSnapshot) return;
    const current = this.captureState();
    if (current === this.preActionSnapshot) {
      this.preActionSnapshot = null;
      return; // no change
    }
    this.undoStack.push(this.preActionSnapshot);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0; // clear redo on new action
    this.preActionSnapshot = null;
  }

  private undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this.captureState());
    this.restoreState(this.undoStack.pop()!);
    console.log(`[editor] Undo (${this.undoStack.length} left)`);
  }

  private redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this.captureState());
    this.restoreState(this.redoStack.pop()!);
    console.log(`[editor] Redo (${this.redoStack.length} left)`);
  }

  // --- Scene persistence ---

  private saveCharacterAssignments() {
    // No-op locally — full scene save handles it
  }

  async saveScene() {
    const characters: Record<string, string> = {};
    for (const r of this.mv.getResidents()) {
      characters[r.agentId] = r.getHomePosition();
    }
    const { cols, rows } = this.mv.getGridSize();
    const scene = {
      gridCols: cols,
      gridRows: rows,
      floor: this.mv.getFloorLayer(),
      furniture: this.furniture.getLayout(),
      characters,
      wanderPoints: this.furniture.wanderPoints,
    };
    try {
      const res = await fetch('/api/save-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scene),
      });
      if (res.ok) {
        console.log('[editor] Scene saved to scene.json');
      } else {
        console.error('[editor] Save failed:', await res.text());
      }
    } catch (e) {
      console.error('[editor] Save failed (is dev server running?):', e);
    }
  }

  /** Apply saved character assignments from scene data */
  loadCharacterAssignments(assignments?: Record<string, string>) {
    if (!assignments) return;
    for (const r of this.mv.getResidents()) {
      if (assignments[r.agentId]) {
        r.setHomePosition(assignments[r.agentId]);
      }
    }
  }

  // --- Grid resize ---

  private gridLabel: HTMLElement | null = null;

  private resizeGrid(dc: number, dr: number) {
    const { cols, rows } = this.mv.getGridSize();
    this.mv.resizeGrid(cols + dc, rows + dr);
    if (this.gridLabel) {
      const s = this.mv.getGridSize();
      this.gridLabel.textContent = `Grid: ${s.cols}×${s.rows}`;
    }
  }

  private makeBtn(label: string, onClick: () => void): HTMLElement {
    const btn = this.el('div', `
      padding:2px 5px; border:1px solid #444; border-radius:2px;
      cursor:pointer; font-size:9px; color:#ccc; background:#222;
    `);
    btn.textContent = label;
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#00ff88'; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#444'; });
    btn.addEventListener('click', onClick);
    return btn;
  }

  // --- Helpers ---

  private el(tag: string, style: string): HTMLElement {
    const el = document.createElement(tag);
    el.style.cssText = style;
    return el;
  }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    if (this.wrapper) {
      const container = this.canvas.parentElement!;
      this.wrapper.parentElement!.insertBefore(container, this.wrapper);
      this.wrapper.remove();
    }
  }
}
