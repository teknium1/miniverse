/**
 * Tabbed editor: props | characters | behavior
 * Owns the panel chrome, tab switching, and input routing.
 * Delegates to PropSystem for props data/rendering.
 */

import type { Miniverse } from '../index';
import {
  PropSystem,
  ANCHOR_COLORS,
  ANCHOR_TYPES,
  type LoadedPiece,
} from '../props';
import type { AnchorType } from '../citizens/Citizen';
import type { PropLayout } from '../props';

export interface CitizenDef {
  agentId: string;
  name: string;
  sprite: string;
  position: string;
  type: 'npc' | 'agent';
}

export interface SceneSnapshot {
  worldId?: string;
  gridCols: number;
  gridRows: number;
  floor: string[][];
  tiles: Record<string, string>;
  props: PropLayout;
  wanderPoints: { name: string; x: number; y: number }[];
  propImages?: Record<string, string>;
  citizens?: CitizenDef[];
}

export type SaveSceneFn = (scene: SceneSnapshot) => Promise<void>;

export interface EditorConfig {
  canvas: HTMLCanvasElement;
  props: PropSystem;
  miniverse: Miniverse;
  worldId?: string;
  onSave?: SaveSceneFn;
  /** Base URL for generation API (default: http://localhost:4321) */
  apiBase?: string;
}

export type EditorTab = 'world' | 'props' | 'citizens' | 'behavior' | 'generate';

export class Editor {
  private active = false;
  private tab: EditorTab = 'world';

  private canvas: HTMLCanvasElement;
  private scale: number;
  private tileSize: number;
  private props: PropSystem;
  private mv: Miniverse;
  private worldId: string;
  private saveFn: SaveSceneFn | null;
  private apiBase: string;

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
  private selectedCitizenId: string | null = null;
  /** Tracks NPC vs Agent per agentId. Default is 'agent' for backwards compat. */
  private citizenTypes: Map<string, 'npc' | 'agent'> = new Map();
  /** Tracks sprite key per agentId */
  private citizenSprites: Map<string, string> = new Map();

  // Behavior state
  private selAnchorPiece: LoadedPiece | null = null;
  private selAnchorIdx = -1;
  private draggingAnchor = false;
  private dragAnchorOx = 0;
  private dragAnchorOy = 0;

  // Generate state
  private genType: 'props' | 'texture' | 'character' = 'props';
  private genStatus = '';
  private genPreview: string | null = null;
  private genBusy = false;

  constructor(config: EditorConfig) {
    this.canvas = config.canvas;
    this.scale = config.props.getScale();
    this.tileSize = config.props.getTileSize();
    this.props = config.props;
    this.mv = config.miniverse;
    this.worldId = config.worldId ?? '';
    this.saveFn = config.onSave ?? null;
    this.apiBase = config.apiBase ?? '';

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
      case 'props': this.renderPropsOverlay(ctx); break;
      case 'citizens': this.renderCitizensOverlay(ctx); break;
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

  private selectedTileKey = '';

  /** @deprecated No longer needed — tileMap keys are the names. */
  setTileNames(_names: Record<number, string>) {}

  private renderWorldOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;
    const floor = this.mv.getFloorLayer();
    if (!floor) return;

    for (let r = 0; r < floor.length; r++) {
      for (let c = 0; c < floor[r].length; c++) {
        const key = floor[r][c];
        if (key === '') {
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
        }
      }
    }
  }

  private buildWorldTab() {
    const c = this.tabContent!;

    const hint = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    hint.innerHTML = [
      '<span style="color:#00ff88">Click</span> paint tile',
      '<span style="color:#00ff88">Drag</span> paint area',
    ].join('<br>');
    c.appendChild(hint);

    const gridSection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; display:flex; align-items:center; gap:6px;');
    const { cols, rows } = this.mv.getGridSize();
    this.gridLabel = this.el('span', 'flex:1; color:#888; font-size:10px;');
    this.gridLabel.textContent = `Grid: ${cols}\u00D7${rows}`;
    gridSection.appendChild(this.gridLabel);
    gridSection.appendChild(this.makeBtn('+C', () => { this.beginAction(); this.resizeGrid(1, 0); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('-C', () => { this.beginAction(); this.resizeGrid(-1, 0); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('+R', () => { this.beginAction(); this.resizeGrid(0, 1); this.commitAction(); }));
    gridSection.appendChild(this.makeBtn('-R', () => { this.beginAction(); this.resizeGrid(0, -1); this.commitAction(); }));
    c.appendChild(gridSection);

    const palLabel = this.el('div', 'padding:4px 10px; color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px;');
    palLabel.textContent = 'Tiles';
    c.appendChild(palLabel);

    const palette = this.el('div', 'padding:4px 8px; display:flex; flex-wrap:wrap; gap:4px;');

    // Deadspace option
    const deadItem = this.el('div', `
      width:40px; height:40px; border:2px solid ${this.selectedTileKey === '' ? '#00ff88' : '#333'}; border-radius:3px;
      cursor:pointer; background:#0a0a0a; overflow:hidden; position:relative;
      display:flex; align-items:center; justify-content:center;
    `);
    deadItem.title = 'Deadspace (void)';
    const skull = this.el('span', 'font-size:20px; opacity:0.6; user-select:none;');
    skull.textContent = '\u2620';
    deadItem.appendChild(skull);
    deadItem.addEventListener('click', () => {
      this.selectedTileKey = '';
      this.buildTabContent();
    });
    palette.appendChild(deadItem);

    // Show all tiles from tileMap
    const tileImages = this.mv.getTileImages();
    const tileMap = this.mv.getTiles();

    for (const key of Object.keys(tileMap)) {
      const img = tileImages.get(key);
      const item = this.el('div', `
        width:40px; height:40px; border:2px solid ${key === this.selectedTileKey ? '#00ff88' : '#333'}; border-radius:3px;
        cursor:pointer; background:#1a1a2e; overflow:hidden; position:relative;
      `);
      item.title = key;

      if (img) {
        const preview = document.createElement('canvas');
        preview.width = 32;
        preview.height = 32;
        preview.style.cssText = 'width:36px; height:36px; image-rendering:pixelated;';
        const pctx = preview.getContext('2d')!;
        pctx.imageSmoothingEnabled = false;
        pctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, 32, 32);
        item.appendChild(preview);
      }

      const label = this.el('div', 'position:absolute; bottom:0; left:1px; right:1px; font-size:7px; color:#888; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;');
      label.textContent = key;
      item.appendChild(label);

      item.addEventListener('click', () => {
        this.selectedTileKey = key;
        this.buildTabContent();
      });
      palette.appendChild(item);
    }

    c.appendChild(palette);

    // Discover extra tiles from /api/tiles not yet loaded
    const worldParam = this.worldId ? `?worldId=${this.worldId}` : '';
    fetch(`${this.apiBase}/api/tiles${worldParam}`).then(r => r.json()).then((names: string[]) => {
      for (const name of names) {
        if (tileMap[name]) continue; // already loaded

        const tilesBase = this.worldId ? `/worlds/${this.worldId}/world_assets/tiles` : '/universal_assets/tiles';
        const src = `${tilesBase}/${name}.png`;
        const img = new Image();
        img.onload = () => {
          this.mv.addTile(name, img, src);

          const item = this.el('div', `
            width:40px; height:40px; border:2px solid #333; border-radius:3px;
            cursor:pointer; background:#1a1a2e; overflow:hidden; position:relative;
          `);
          item.title = name;
          const preview = document.createElement('canvas');
          preview.width = 32;
          preview.height = 32;
          preview.style.cssText = 'width:36px; height:36px; image-rendering:pixelated;';
          const pctx = preview.getContext('2d')!;
          pctx.imageSmoothingEnabled = false;
          pctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, 32, 32);
          item.appendChild(preview);

          const label = this.el('div', 'position:absolute; bottom:0; left:1px; right:1px; font-size:7px; color:#888; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;');
          label.textContent = name;
          item.appendChild(label);

          item.addEventListener('click', () => {
            this.selectedTileKey = name;
            this.buildTabContent();
          });
          palette.appendChild(item);
        };
        img.src = src;
      }
    }).catch(() => {});
  }

  private paintTile(wx: number, wy: number) {
    const T = this.tileSize;
    const col = Math.floor(wx / T);
    const row = Math.floor(wy / T);

    if (this.selectedTileKey === '' && this.props.occupiesTile(col, row)) return;

    this.mv.setTile(col, row, this.selectedTileKey);
  }

  // --- Props overlay ---

  private renderPropsOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;

    for (const p of this.props.pieces) {
      for (const a of p.anchors) {
        this.drawAnchorDot(ctx, (p.x + a.ox) * T + T / 2, (p.y + a.oy) * T + T / 2, a.type, 3);
      }
    }

    for (const s of this.props.selected) {
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

  // --- Citizens overlay ---

  private renderCitizensOverlay(ctx: CanvasRenderingContext2D) {
    const T = this.tileSize;
    for (const r of this.mv.getCitizens()) {
      if (!r.visible) continue;
      const cx = r.x + T / 2;
      const cy = r.y + T / 2;
      const selected = r.agentId === this.selectedCitizenId;

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

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (const p of this.props.pieces) {
      ctx.strokeRect(p.x * T, p.y * T, p.w * T, p.h * T);
    }

    for (const p of this.props.pieces) {
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

        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#ccc';
        ctx.font = '6px monospace';
        ctx.fillText(a.name, (p.x + a.ox) * T + 2, (p.y + a.oy) * T - 2);
        ctx.globalAlpha = 1;
      }
    }

    for (const wp of this.props.wanderPoints) {
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
    this.wrapper.style.cssText = 'display:flex; gap:0; align-items:flex-start;';
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
    // Match panel height exactly to canvas
    const syncHeight = () => {
      const h = this.canvas.clientHeight || this.canvas.height;
      if (this.panel) this.panel.style.height = h + 'px';
    };
    syncHeight();
    const ro = new ResizeObserver(syncHeight);
    ro.observe(this.canvas);

    // Scrollbar styling
    const style = document.createElement('style');
    style.textContent = `
      #editor-wrapper ::-webkit-scrollbar { width: 6px; }
      #editor-wrapper ::-webkit-scrollbar-track { background: #1a1a2e; }
      #editor-wrapper ::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
      #editor-wrapper ::-webkit-scrollbar-thumb:hover { background: #666; }
    `;
    document.head.appendChild(style);

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex; border-bottom:1px solid #333;';
    const tabs: EditorTab[] = ['world', 'props', 'citizens', 'behavior', 'generate'];
    for (const t of tabs) {
      const btn = document.createElement('div');
      const tabLabels: Record<EditorTab, string> = {
        world: 'World', props: 'Props', citizens: 'Cit',
        behavior: 'Behv', generate: 'Gen',
      };
      btn.textContent = tabLabels[t];
      btn.style.cssText = `
        flex:1; text-align:center; padding:6px 0; cursor:pointer;
        font-size:9px; text-transform:uppercase; letter-spacing:0.5px;
        transition: background 0.1s, color 0.1s;
      `;
      btn.addEventListener('click', () => this.switchTab(t));
      tabBar.appendChild(btn);
      this.tabBtns.set(t, btn);
    }
    this.panel.appendChild(tabBar);

    this.tabContent = document.createElement('div');
    this.tabContent.style.cssText = 'flex:1; overflow-y:auto; display:flex; flex-direction:column;';
    this.panel.appendChild(this.tabContent);

    const undoBar = document.createElement('div');
    undoBar.style.cssText = 'display:flex; border-top:1px solid #333; padding:4px 6px; gap:4px; margin-top:auto;';
    const undoBtn = this.makeBtn('\u27F5 Undo', () => this.undo());
    const redoBtn = this.makeBtn('Redo \u27F6', () => this.redo());
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
    this.props.selected.clear();
    this.selAnchorPiece = null;
    this.selAnchorIdx = -1;
    this.selectedCitizenId = null;
    this.updateTabStyles();
    this.buildTabContent();
  }

  private buildTabContent() {
    if (!this.tabContent) return;
    this.tabContent.innerHTML = '';
    switch (this.tab) {
      case 'world': this.buildWorldTab(); break;
      case 'props': this.buildPropsTab(); break;
      case 'citizens': this.buildCitizensTab(); break;
      case 'behavior': this.buildBehaviorTab(); break;
      case 'generate': this.buildGenerateTab(); break;
    }
  }

  private refreshTabContent() {
    switch (this.tab) {
      case 'world': break;
      case 'props': this.refreshPropsTab(); break;
      case 'citizens': this.refreshCitizensTab(); break;
      case 'behavior': this.refreshBehaviorTab(); break;
    }
  }

  // --- Props tab ---

  private propsInfo: HTMLElement | null = null;

  private buildPropsTab() {
    const c = this.tabContent!;

    const controls = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; line-height:1.6;');
    controls.innerHTML = [
      '<span style="color:#00ff88">Drag</span> move',
      '<span style="color:#00ff88">Shift+Click</span> multi-select',
      '<span style="color:#00ff88">\u2318C / \u2318V</span> copy/paste',
      '<span style="color:#00ff88">Arrows</span> nudge',
      '<span style="color:#00ff88">+ / -</span> resize',
      '<span style="color:#00ff88">L</span> layer',
      '<span style="color:#00ff88">Del</span> remove',
      '<span style="color:#00ff88">S</span> save',
    ].join('<br>');
    c.appendChild(controls);

    this.propsInfo = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; min-height:36px; color:#888;');
    this.propsInfo.innerHTML = '<span style="color:#555">Click a piece</span>';
    c.appendChild(this.propsInfo);

    const invLabel = this.el('div', 'padding:4px 10px; color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px;');
    invLabel.textContent = 'Inventory';
    c.appendChild(invLabel);

    const grid = this.el('div', 'padding:4px 8px; display:flex; flex-wrap:wrap; gap:4px;');
    for (const [id, src] of this.props.getImageSrcs()) {
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
        const p = this.props.addPiece(id);
        if (p) {
          this.props.selected.clear();
          this.props.selected.add(p);
        }
        this.commitAction();
      });
      grid.appendChild(item);
    }
    c.appendChild(grid);
  }

  private refreshPropsTab() {
    if (!this.propsInfo) return;
    const sel = this.props.selected;
    if (sel.size === 0) {
      this.propsInfo.innerHTML = '<span style="color:#555">Click a piece</span>';
      return;
    }
    if (sel.size > 1) {
      this.propsInfo.innerHTML = `<span style="color:#00ff88">${sel.size} pieces selected</span>`;
      return;
    }
    const s = [...sel][0];
    const anchors = s.anchors.length > 0
      ? s.anchors.map(a => `<span style="color:${ANCHOR_COLORS[a.type]}">\u25CF</span> ${a.name}`).join('<br>')
      : '<span style="color:#555">no anchors</span>';
    this.propsInfo.innerHTML = [
      `<span style="color:#00ff88">${s.id}</span>`,
      `pos: ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`,
      `size: ${s.w.toFixed(1)}\u00D7${s.h.toFixed(1)}  layer: <span style="color:${s.layer === 'above' ? '#ff8844' : '#4488ff'}">${s.layer}</span>`,
      anchors,
    ].join('<br>');
  }

  // --- Citizens tab ---

  private citizensInfo: HTMLElement | null = null;
  private citizensList: HTMLElement | null = null;

  private buildCitizensTab() {
    const c = this.tabContent!;

    // Add character button
    const addSection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333;');
    const addBtn = this.makeBtn('+ Add Citizen', () => this.showAddCitizenUI());
    addBtn.style.cssText += 'width:100%; text-align:center; padding:5px 0; border-color:#00ff88; color:#00ff88;';
    addSection.appendChild(addBtn);
    c.appendChild(addSection);

    this.citizensList = this.el('div', 'padding:4px 8px; border-bottom:1px solid #333;');
    this.rebuildCitizensList();
    c.appendChild(this.citizensList);

    this.citizensInfo = this.el('div', 'padding:6px 10px; min-height:40px; color:#888;');
    this.citizensInfo.innerHTML = '<span style="color:#555">Select a citizen</span>';
    c.appendChild(this.citizensInfo);
  }

  private showAddCitizenUI() {
    if (!this.tabContent) return;
    this.tabContent.innerHTML = '';
    const c = this.tabContent;

    const header = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333; color:#00ff88; font-size:11px;');
    header.textContent = 'Add Citizen';
    c.appendChild(header);

    const form = this.el('div', 'padding:8px 10px; display:flex; flex-direction:column; gap:6px;');

    // Name
    const nameLabel = this.el('div', 'color:#888; font-size:9px;');
    nameLabel.textContent = 'Name';
    form.appendChild(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.placeholder = 'e.g. nova';
    nameInput.style.cssText = 'background:#222; border:1px solid #444; color:#ccc; padding:4px; font-family:inherit; font-size:10px; border-radius:2px;';
    form.appendChild(nameInput);

    // Sprite grid
    const spriteLabel = this.el('div', 'color:#888; font-size:9px;');
    spriteLabel.textContent = 'Sprite';
    form.appendChild(spriteLabel);

    let selectedSprite = '';
    const spriteGrid = this.el('div', 'display:flex; flex-wrap:wrap; gap:4px;');
    const spriteCards: Map<string, HTMLElement> = new Map();

    const updateSpriteSelection = (key: string) => {
      selectedSprite = key;
      for (const [k, card] of spriteCards) {
        card.style.borderColor = k === key ? '#00ff88' : '#333';
        card.style.background = k === key ? '#00ff8815' : '#1a1a2e';
      }
    };

    const addSpriteCard = (key: string, walkImg: HTMLImageElement) => {
      if (spriteCards.has(key)) return;
      const card = this.el('div', `
        width:52px; height:64px; border:2px solid #333; border-radius:3px;
        cursor:pointer; background:#1a1a2e; overflow:hidden;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
      `);
      card.title = key;
      spriteCards.set(key, card);

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 48;
      thumbCanvas.height = 48;
      thumbCanvas.style.cssText = 'image-rendering:pixelated;';
      const tctx = thumbCanvas.getContext('2d')!;
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(walkImg, 0, 0, 64, 64, 0, 0, 48, 48);
      card.appendChild(thumbCanvas);

      const label = this.el('div', 'color:#888; font-size:7px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%; padding:0 2px;');
      label.textContent = key;
      card.appendChild(label);

      card.addEventListener('click', () => updateSpriteSelection(key));
      spriteGrid.appendChild(card);

      // Auto-select the first card added
      if (spriteCards.size === 1) updateSpriteSelection(key);
    };

    // 1. Add sprites from already-loaded citizens
    for (const r of this.mv.getCitizens()) {
      const sprKey = this.citizenSprites.get(r.agentId) || r.name;
      const walkImg = r.spriteSheet.getImage('walk');
      if (walkImg) addSpriteCard(sprKey, walkImg);
    }

    // 2. Fetch all available walk sprites from /api/citizens
    const loadingHint = this.el('div', 'color:#555; font-size:9px;');
    loadingHint.textContent = 'Loading sprites...';
    spriteGrid.appendChild(loadingHint);

    fetch(`${this.apiBase}/api/citizens`).then(r => r.json()).then((names: string[]) => {
      loadingHint.remove();
      for (const name of names) {
        if (spriteCards.has(name)) continue;
        const img = new Image();
        img.onload = () => addSpriteCard(name, img);
        img.src = `/universal_assets/citizens/${name}_walk.png`;
      }
    }).catch(() => {
      loadingHint.textContent = '';
    });

    form.appendChild(spriteGrid);

    // Type toggle
    const typeLabel = this.el('div', 'color:#888; font-size:9px;');
    typeLabel.textContent = 'Type';
    form.appendChild(typeLabel);
    const typeRow = this.el('div', 'display:flex; gap:4px;');
    let selectedType: 'npc' | 'agent' = 'npc';
    const npcBtn = this.el('div', 'flex:1; text-align:center; padding:4px 0; cursor:pointer; font-size:9px; border-radius:2px; border:1px solid #00ff88; color:#00ff88; background:#00ff8815;');
    npcBtn.textContent = 'NPC';
    const agentBtn = this.el('div', 'flex:1; text-align:center; padding:4px 0; cursor:pointer; font-size:9px; border-radius:2px; border:1px solid #444; color:#888; background:transparent;');
    agentBtn.textContent = 'Agent';
    npcBtn.addEventListener('click', () => {
      selectedType = 'npc';
      npcBtn.style.borderColor = '#00ff88'; npcBtn.style.color = '#00ff88'; npcBtn.style.background = '#00ff8815';
      agentBtn.style.borderColor = '#444'; agentBtn.style.color = '#888'; agentBtn.style.background = 'transparent';
    });
    agentBtn.addEventListener('click', () => {
      selectedType = 'agent';
      agentBtn.style.borderColor = '#00ff88'; agentBtn.style.color = '#00ff88'; agentBtn.style.background = '#00ff8815';
      npcBtn.style.borderColor = '#444'; npcBtn.style.color = '#888'; npcBtn.style.background = 'transparent';
    });
    typeRow.appendChild(npcBtn);
    typeRow.appendChild(agentBtn);
    form.appendChild(typeRow);

    // Submit
    const submitRow = this.el('div', 'display:flex; gap:4px; margin-top:4px;');
    const cancelBtn = this.makeBtn('Cancel', () => this.buildTabContent());
    cancelBtn.style.cssText += 'flex:1; text-align:center; padding:5px 0;';
    const createBtn = this.makeBtn('Create', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const agentId = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

      if (this.mv.getCitizen(agentId)) {
        nameInput.style.borderColor = '#ef4444';
        return;
      }

      const sprite = selectedSprite || agentId;
      const workAnchors = this.props.getLocations().filter(l => l.type === 'work');
      const wanderPoints = this.props.wanderPoints;
      const position = workAnchors[this.mv.getCitizens().length]?.name
        ?? wanderPoints[0]?.name ?? 'wander_0';

      this.citizenTypes.set(agentId, selectedType);
      this.citizenSprites.set(agentId, sprite);

      // Build sheet config: prefer from spriteSheets config, else use standard convention
      const { createStandardSpriteConfig } = await import('../index');
      const sheetConfig = this.mv.getSpriteSheetConfig(sprite)
        ?? createStandardSpriteConfig(sprite);
      await this.mv.addCitizen(
        { agentId, name, sprite, position, npc: selectedType === 'npc' },
        sheetConfig,
      );

      if (selectedType === 'npc') {
        this.mv.getCitizen(agentId)?.updateState('idle', null, 1);
      }

      this.props.save();
      await this.saveScene();
      this.buildTabContent();
    });
    createBtn.style.cssText += 'flex:1; text-align:center; padding:5px 0; border-color:#00ff88; color:#00ff88;';
    submitRow.appendChild(cancelBtn);
    submitRow.appendChild(createBtn);
    form.appendChild(submitRow);

    c.appendChild(form);
  }

  private rebuildCitizensList() {
    if (!this.citizensList) return;
    this.citizensList.innerHTML = '';
    for (const r of this.mv.getCitizens()) {
      const charType = this.citizenTypes.get(r.agentId) ?? 'agent';
      const isSel = r.agentId === this.selectedCitizenId;
      const row = this.el('div', `
        padding:4px 6px; cursor:pointer; display:flex; align-items:center; gap:6px;
        border-radius:3px; margin-bottom:2px;
        border:1px solid ${isSel ? '#00ff88' : 'transparent'};
        background:${isSel ? '#00ff8815' : 'transparent'};
      `);

      // Sprite thumbnail
      const walkImg = r.spriteSheet.getImage('walk');
      if (walkImg) {
        const thumb = document.createElement('canvas');
        thumb.width = 24;
        thumb.height = 24;
        thumb.style.cssText = 'image-rendering:pixelated; flex-shrink:0;';
        const tctx = thumb.getContext('2d')!;
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(walkImg, 0, 0, 64, 64, 0, 0, 24, 24);
        row.appendChild(thumb);
      } else {
        const dot = this.el('span', `
          width:6px; height:6px; border-radius:50%; display:inline-block;
          background:${this.stateColor(r.state)};
        `);
        row.appendChild(dot);
      }

      const name = this.el('span', 'flex:1;');
      name.textContent = r.name;
      row.appendChild(name);
      const badge = this.el('span', `font-size:8px; padding:1px 4px; border-radius:2px; border:1px solid ${charType === 'agent' ? '#818cf8' : '#fbbf24'}; color:${charType === 'agent' ? '#818cf8' : '#fbbf24'};`);
      badge.textContent = charType.toUpperCase();
      row.appendChild(badge);
      const removeBtn = this.el('span', 'color:#ef4444; font-size:11px; cursor:pointer; padding:0 2px; opacity:0.5;');
      removeBtn.textContent = '\u00D7';
      removeBtn.title = 'Remove character';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.mv.removeCitizen(r.agentId);
        this.citizenTypes.delete(r.agentId);
        this.citizenSprites.delete(r.agentId);
        if (this.selectedCitizenId === r.agentId) {
          this.selectedCitizenId = null;
          this.citizensBuiltFor = null;
        }
        this.props.save();
        this.saveScene();
        this.rebuildCitizensList();
      });
      removeBtn.addEventListener('mouseenter', () => { removeBtn.style.opacity = '1'; });
      removeBtn.addEventListener('mouseleave', () => { removeBtn.style.opacity = '0.5'; });
      row.appendChild(removeBtn);
      row.addEventListener('click', () => {
        this.selectedCitizenId = r.agentId;
        this.citizensBuiltFor = null;
        this.rebuildCitizensList();
      });
      this.citizensList.appendChild(row);
    }
  }

  private citizensBuiltFor: string | null = null;

  private refreshCitizensTab() {
    if (!this.citizensInfo) return;
    if (!this.selectedCitizenId) {
      this.citizensBuiltFor = null;
      this.citizensInfo.innerHTML = '<span style="color:#555">Select a citizen</span>';
      return;
    }

    if (this.citizensBuiltFor === this.selectedCitizenId) return;
    this.citizensBuiltFor = this.selectedCitizenId;

    const r = this.mv.getCitizen(this.selectedCitizenId);
    if (!r) return;

    const assigned = new Map<string, string>();
    for (const res of this.mv.getCitizens()) {
      assigned.set(res.getHomePosition(), res.name);
    }

    const workAnchors = this.props.getLocations().filter(l => l.type === 'work');
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

    const charType = this.citizenTypes.get(r.agentId) ?? 'agent';
    const typeColor = charType === 'agent' ? '#818cf8' : '#fbbf24';

    const lines = [
      `<span style="color:#00ff88">${r.name}</span> <span style="color:#555">(${r.agentId})</span>`,
      `type: <span style="color:${typeColor}">${charType}</span> <span id="ed-toggle-type" style="color:#555;cursor:pointer;font-size:9px;text-decoration:underline;">[toggle]</span>`,
      `state: ${r.state}`,
      `desk: <select id="ed-home-select" style="background:#222;border:1px solid #444;color:#ccc;font-family:inherit;font-size:10px;padding:1px 2px;border-radius:2px;">${homeOptions}</select>`,
    ];

    if (charType === 'agent') {
      lines.push(
        `<div style="margin-top:6px;padding:4px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;font-size:9px;">` +
        `<div style="color:#818cf8;margin-bottom:2px;">Heartbeat endpoint:</div>` +
        `<code style="color:#ccc;word-break:break-all;">POST /api/heartbeat</code><br>` +
        `<code style="color:#888;word-break:break-all;">{"agent":"${r.agentId}","state":"working","task":"doing stuff","energy":0.8}</code>` +
        `</div>`
      );
    } else {
      lines.push(`<div style="margin-top:4px;color:#555;font-size:9px;">NPC — auto-idle, no heartbeat needed</div>`);
    }

    this.citizensInfo.innerHTML = lines.join('<br>');

    const sel = this.citizensInfo.querySelector('#ed-home-select') as HTMLSelectElement | null;
    sel?.addEventListener('change', () => {
      this.beginAction();
      r.setHomePosition(sel.value);
      this.citizensBuiltFor = null;
      this.rebuildCitizensList();
      this.commitAction();
    });

    const toggleType = this.citizensInfo.querySelector('#ed-toggle-type');
    toggleType?.addEventListener('click', () => {
      const current = this.citizenTypes.get(r.agentId) ?? 'agent';
      const next = current === 'agent' ? 'npc' : 'agent';
      this.citizenTypes.set(r.agentId, next);
      if (next === 'npc') {
        r.updateState('idle', null, 1);
      }
      this.citizensBuiltFor = null;
      this.rebuildCitizensList();
      this.refreshCitizensTab();
      this.saveScene();
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

    const legend = this.el('div', 'padding:4px 10px; border-bottom:1px solid #333; font-size:10px; line-height:1.6;');
    legend.innerHTML = Object.entries(ANCHOR_COLORS).map(([type, color]) =>
      `<span style="color:${color}">\u25CF</span> ${type}`
    ).join('&nbsp;&nbsp;');
    c.appendChild(legend);

    this.behaviorInfo = this.el('div', 'padding:6px 10px; min-height:40px; color:#888;');
    this.behaviorInfo.innerHTML = '<span style="color:#555">Click an anchor</span>';
    c.appendChild(this.behaviorInfo);

    const list = this.el('div', 'padding:4px 8px; overflow-y:auto; flex:1;');
    for (const p of this.props.pieces) {
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
        const pi = this.props.pieces.indexOf(p);
        row.addEventListener('click', () => {
          this.selAnchorPiece = this.props.pieces[pi];
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

  // --- Generate tab ---

  private buildGenerateTab() {
    const c = this.tabContent!;
    const falKey = localStorage.getItem('miniverse_fal_key') ?? '';

    // FAL Key section
    const keySection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333;');
    if (!falKey) {
      const label = this.el('div', 'color:#888; font-size:9px; margin-bottom:4px;');
      label.textContent = 'FAL API Key';
      keySection.appendChild(label);

      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Enter fal.ai key...';
      input.style.cssText = 'width:100%; background:#222; border:1px solid #444; color:#ccc; padding:4px; font-family:inherit; font-size:10px; border-radius:2px; box-sizing:border-box;';
      keySection.appendChild(input);

      const saveBtn = this.makeBtn('Save Key', () => {
        if (input.value.trim()) {
          localStorage.setItem('miniverse_fal_key', input.value.trim());
          this.buildTabContent();
        }
      });
      saveBtn.style.marginTop = '4px';
      keySection.appendChild(saveBtn);
    } else {
      const row = this.el('div', 'display:flex; align-items:center; gap:6px;');
      const check = this.el('span', 'color:#00ff88; font-size:10px;');
      check.textContent = '\u2713 API key set';
      row.appendChild(check);
      const clearBtn = this.makeBtn('Clear', () => {
        localStorage.removeItem('miniverse_fal_key');
        this.buildTabContent();
      });
      row.appendChild(clearBtn);
      keySection.appendChild(row);
    }
    c.appendChild(keySection);

    // Type selector
    const typeSection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333;');
    const typeLabel = this.el('div', 'color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;');
    typeLabel.textContent = 'Type';
    typeSection.appendChild(typeLabel);

    const types: ('props' | 'texture' | 'character')[] = ['props', 'texture', 'character'];
    const typeRow = this.el('div', 'display:flex; gap:4px;');
    for (const t of types) {
      const btn = this.el('div', `
        flex:1; text-align:center; padding:4px 0; cursor:pointer;
        font-size:9px; border-radius:2px;
        border:1px solid ${t === this.genType ? '#00ff88' : '#444'};
        color:${t === this.genType ? '#00ff88' : '#888'};
        background:${t === this.genType ? '#00ff8815' : 'transparent'};
      `);
      btn.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      btn.addEventListener('click', () => {
        this.genType = t;
        this.buildTabContent();
      });
      typeRow.appendChild(btn);
    }
    typeSection.appendChild(typeRow);
    c.appendChild(typeSection);

    // Prompt
    const promptSection = this.el('div', 'padding:6px 10px; border-bottom:1px solid #333;');
    const promptLabel = this.el('div', 'color:#555; font-size:9px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;');
    promptLabel.textContent = 'Prompt';
    promptSection.appendChild(promptLabel);

    const textarea = document.createElement('textarea');
    textarea.placeholder = this.genType === 'props' ? 'A wooden desk with monitor...'
      : this.genType === 'texture' ? 'Light oak wood planks...'
      : 'Young developer, blue hoodie...';
    textarea.style.cssText = 'width:100%; height:60px; background:#222; border:1px solid #444; color:#ccc; padding:4px; font-family:inherit; font-size:10px; border-radius:2px; resize:vertical; box-sizing:border-box;';
    promptSection.appendChild(textarea);

    // Image upload (optional)
    const uploadRow = this.el('div', 'margin-top:4px; display:flex; align-items:center; gap:6px;');
    const fileLabel = this.el('label', 'color:#555; font-size:9px; cursor:pointer;');
    fileLabel.textContent = '+ Reference image';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    let refImageBase64: string | null = null;
    const fileStatus = this.el('span', 'color:#888; font-size:9px;');

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        refImageBase64 = dataUrl.split(',')[1]; // strip data:image/...;base64,
        fileStatus.textContent = file.name;
        fileStatus.style.color = '#00ff88';
      };
      reader.readAsDataURL(file);
    });
    fileLabel.addEventListener('click', () => fileInput.click());
    uploadRow.appendChild(fileLabel);
    uploadRow.appendChild(fileInput);
    uploadRow.appendChild(fileStatus);
    promptSection.appendChild(uploadRow);

    // Generate button
    const genBtn = this.makeBtn(this.genBusy ? 'Generating...' : 'Generate', async () => {
      if (this.genBusy) return;
      const prompt = textarea.value.trim();
      if (!prompt) return;

      const key = localStorage.getItem('miniverse_fal_key');
      if (!key) {
        this.genStatus = 'Set your FAL API key first';
        this.buildTabContent();
        return;
      }

      this.genBusy = true;
      this.genStatus = 'Generating...';
      this.genPreview = null;
      this.buildTabContent();

      const doGenerate = async () => {
        try {
          const payload: Record<string, string> = {
            type: this.genType, prompt, falKey: key, worldId: this.worldId,
          };
          if (refImageBase64) payload.image = refImageBase64;

          const url = `${this.apiBase}/api/generate`;
          console.log('[gen] Sending request...', url, payload.type);
          let resp: Response;
          try {
            resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch (fetchErr) {
            console.error('[gen] Fetch failed:', fetchErr);
            this.genStatus = 'Cannot reach /api/generate. Make sure your dev server has the generate plugin loaded.';
            this.genBusy = false;
            this.buildTabContent();
            return;
          }

          console.log('[gen] Response status:', resp.status);
          const result = await resp.json();
          console.log('[gen] Result:', result);

          if (result.ok) {
            this.genPreview = result.path;
            const id = result.id || result.path.split('/').pop()?.replace('.png', '') || `gen_${Date.now()}`;
            console.log('[gen] Loading sprite:', id, result.path);

            if (this.genType === 'props' && result.path) {
              // Retry with cache-bust — Vite may need a moment to detect the new file
              let loaded = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await this.props.loadSprite(id, result.path + '?t=' + Date.now());
                  loaded = true;
                  break;
                } catch {
                  console.log(`[gen] Sprite load attempt ${attempt + 1} failed, retrying...`);
                  await new Promise(r => setTimeout(r, 1000));
                }
              }
              if (!loaded) {
                this.genStatus = 'Sprite generated but failed to load image. Try refreshing.';
                this.genBusy = false;
                this.buildTabContent();
                return;
              }
              console.log('[gen] Sprite loaded, adding piece...');
              this.beginAction();
              const p = this.props.addPiece(id);
              console.log('[gen] Piece added:', p?.id, p?.x, p?.y);
              if (p) {
                this.props.selected.clear();
                this.props.selected.add(p);
              }
              this.commitAction();
              this.genStatus = `Added "${id}" to scene`;
              this.props.save();
              await this.saveScene();
              console.log('[gen] Scene saved');
            } else if (this.genType === 'texture' && result.path) {
              // Load the texture with retry (Vite may need a moment to detect the new file)
              let tileImg: HTMLImageElement | null = null;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  tileImg = await new Promise<HTMLImageElement>((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error('Failed to load texture'));
                    img.src = result.path + '?t=' + Date.now();
                  });
                  break;
                } catch {
                  console.log(`[gen] Texture load attempt ${attempt + 1} failed, retrying...`);
                  await new Promise(r => setTimeout(r, 1000));
                }
              }
              if (!tileImg) {
                this.genStatus = 'Texture generated but failed to load. Try refreshing.';
                this.genBusy = false;
                this.buildTabContent();
                return;
              }
              this.mv.addTile(id, tileImg, result.path);
              this.selectedTileKey = id;
              this.genStatus = `Added tile "${id}"`;
              await this.saveScene();
            } else {
              this.genStatus = `Saved to ${result.path}`;
            }
          } else {
            this.genStatus = result.error || 'Generation failed';
          }
        } catch (err) {
          console.error('[gen] Error:', err);
          this.genStatus = `Error: ${err}`;
        }

        this.genBusy = false;
        console.log('[gen] Done, rebuilding tab. Status:', this.genStatus);
        this.buildTabContent();
      };
      doGenerate();
    });
    genBtn.style.cssText += 'margin-top:6px; text-align:center; padding:6px 0; width:100%;';
    if (this.genBusy) {
      genBtn.style.opacity = '0.5';
      genBtn.style.cursor = 'default';
    }
    promptSection.appendChild(genBtn);
    c.appendChild(promptSection);

    // Status
    if (this.genStatus) {
      const isError = this.genStatus.startsWith('Error') || this.genStatus.startsWith('Set ') || this.genStatus.includes('failed');
      const isLoading = this.genStatus === 'Generating...';
      const statusEl = this.el('div', `padding:6px 10px; font-size:10px; color:${isError ? '#ef4444' : isLoading ? '#fbbf24' : '#00ff88'};`);
      statusEl.textContent = this.genStatus;
      c.appendChild(statusEl);
    }

    // Preview
    if (this.genPreview) {
      const previewSection = this.el('div', 'padding:6px 10px;');
      const img = document.createElement('img');
      img.src = this.genPreview;
      img.style.cssText = 'max-width:100%; image-rendering:pixelated; border:1px solid #333; border-radius:3px;';
      previewSection.appendChild(img);
      c.appendChild(previewSection);
    }
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
    } else if (this.tab === 'props') {
      if (this.props.handleMouseDown(x, y, e.shiftKey)) e.preventDefault();
    } else if (this.tab === 'citizens') {
      this.pickCitizen(x, y);
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
    } else if (this.tab === 'props') {
      this.props.handleMouseMove(x, y);
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
    if (this.tab === 'props') this.props.handleMouseUp();
    this.painting = false;
    this.draggingAnchor = false;
    this.commitAction();
  }

  private pickCitizen(wx: number, wy: number) {
    const T = this.tileSize;
    for (const r of this.mv.getCitizens()) {
      if (!r.visible) continue;
      const dx = wx - (r.x + T / 2);
      const dy = wy - (r.y + T / 2);
      if (dx * dx + dy * dy < T * T) {
        this.selectedCitizenId = r.agentId;
        this.citizensBuiltFor = null;
        this.rebuildCitizensList();
        return;
      }
    }
    this.selectedCitizenId = null;
    this.citizensBuiltFor = null;
    this.rebuildCitizensList();
  }

  private pickAnchor(wx: number, wy: number) {
    const T = this.tileSize;
    const hitR = 8;
    for (const p of this.props.pieces) {
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

    if (e.key === 'e' || e.key === 'E') {
      this.active = !this.active;
      if (this.active) {
        this.buildPanel();
        this.panel!.style.display = 'flex';
        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        this.canvas.addEventListener('mouseup', this.onMouseUp);
      } else {
        this.props.save();
        this.saveScene();
        if (this.panel) this.panel.style.display = 'none';
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('mouseup', this.onMouseUp);
        this.props.selected.clear();
        this.selAnchorPiece = null;
        this.selectedCitizenId = null;
      }
      return;
    }

    if (!this.active) return;

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

    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
      this.props.save();
      this.saveScene();
      return;
    }

    if (this.tab === 'props') {
      this.beginAction();
      this.props.handleKey(e);
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
    for (const r of this.mv.getCitizens()) {
      characters[r.agentId] = r.getHomePosition();
    }
    const { cols, rows } = this.mv.getGridSize();
    return JSON.stringify({
      gridCols: cols,
      gridRows: rows,
      floor: this.mv.getFloorLayer(),
      props: this.props.getLayout(),
      characters,
      wanderPoints: this.props.wanderPoints,
    });
  }

  private restoreState(snapshot: string) {
    const s = JSON.parse(snapshot);

    const { cols, rows } = this.mv.getGridSize();
    if (s.gridCols !== cols || s.gridRows !== rows) {
      this.mv.resizeGrid(s.gridCols, s.gridRows);
    }

    if (s.floor) {
      const floor = this.mv.getFloorLayer();
      for (let r = 0; r < s.floor.length && r < floor.length; r++) {
        for (let c = 0; c < s.floor[r].length && c < floor[r].length; c++) {
          floor[r][c] = s.floor[r][c];
        }
      }
    }

    this.props.setLayout(s.props ?? []);
    if (s.wanderPoints) this.props.setWanderPoints(s.wanderPoints);

    if (s.characters) {
      for (const r of this.mv.getCitizens()) {
        if (s.characters[r.agentId]) r.setHomePosition(s.characters[r.agentId]);
      }
    }

    this.props.selected.clear();
    this.selAnchorPiece = null;
    this.selAnchorIdx = -1;
    this.citizensBuiltFor = null;

    if (this.gridLabel) {
      const sz = this.mv.getGridSize();
      this.gridLabel.textContent = `Grid: ${sz.cols}\u00D7${sz.rows}`;
    }
    this.buildTabContent();
  }

  private beginAction() {
    this.preActionSnapshot = this.captureState();
  }

  private commitAction() {
    if (!this.preActionSnapshot) return;
    const current = this.captureState();
    if (current === this.preActionSnapshot) {
      this.preActionSnapshot = null;
      return;
    }
    this.undoStack.push(this.preActionSnapshot);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
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

  private buildSceneSnapshot(): SceneSnapshot {
    const { cols, rows } = this.mv.getGridSize();

    const worldPrefix = this.worldId ? `/worlds/${this.worldId}` : '';
    const stripPrefix = (src: string) => {
      let clean = src.split('?')[0];
      if (worldPrefix && clean.startsWith(worldPrefix)) {
        clean = clean.slice(worldPrefix.length);
      }
      if (clean.startsWith('/')) clean = clean.slice(1);
      return clean;
    };

    // Build propImages from loaded props images
    const propImages: Record<string, string> = {};
    for (const [id, src] of this.props.getImageSrcs()) {
      propImages[id] = stripPrefix(src);
    }

    // Build citizens from current citizens + type/sprite maps
    const citizens: CitizenDef[] = this.mv.getCitizens().map(r => ({
      agentId: r.agentId,
      name: r.name,
      sprite: this.citizenSprites.get(r.agentId) || r.name,
      position: r.getHomePosition(),
      type: this.citizenTypes.get(r.agentId) ?? 'agent',
    }));

    // Build tiles — strip world prefix and cache-bust params for persistence
    const tiles: Record<string, string> = {};
    for (const [key, src] of Object.entries(this.mv.getTiles())) {
      tiles[key] = stripPrefix(src);
    }

    // Sanitize: remove anything outside grid bounds
    const props = this.props.getLayout().filter(p =>
      p.x >= 0 && p.y >= 0 && p.x + p.w <= cols && p.y + p.h <= rows
    );
    const wanderPoints = this.props.wanderPoints.filter(wp =>
      wp.x >= 0 && wp.y >= 0 && wp.x < cols && wp.y < rows
    );

    // Build set of valid location names from in-bounds props anchors + wander points
    const validLocations = new Set<string>();
    for (const p of props) {
      for (const a of p.anchors ?? []) {
        const ax = Math.round(p.x + a.ox);
        const ay = Math.round(p.y + a.oy);
        if (ax >= 0 && ay >= 0 && ax < cols && ay < rows) {
          validLocations.add(a.name);
        }
      }
    }
    for (const wp of wanderPoints) {
      validLocations.add(wp.name);
    }

    // Drop citizens whose home position no longer exists
    const validCitizens = citizens.filter(r => validLocations.has(r.position));

    const removed = {
      props: this.props.getLayout().length - props.length,
      wanderPoints: this.props.wanderPoints.length - wanderPoints.length,
      citizens: citizens.length - validCitizens.length,
    };
    const total = removed.props + removed.wanderPoints + removed.citizens;
    if (total > 0) {
      console.log(`[editor] Sanitized: removed ${removed.props} props, ${removed.wanderPoints} wander points, ${removed.citizens} citizens outside ${cols}x${rows} grid`);
    }

    return {
      worldId: this.worldId || undefined,
      gridCols: cols,
      gridRows: rows,
      floor: this.mv.getFloorLayer(),
      tiles,
      props,
      wanderPoints,
      propImages,
      citizens: validCitizens,
    };
  }

  async saveScene() {
    const scene = this.buildSceneSnapshot();
    if (this.saveFn) {
      try {
        await this.saveFn(scene);
        console.log('[editor] Scene saved');
      } catch (e) {
        console.error('[editor] Save failed:', e);
      }
    } else {
      console.warn('[editor] No save function configured');
    }
  }

  loadCitizenDefs(defs?: CitizenDef[]) {
    if (!defs) return;
    for (const def of defs) {
      this.citizenTypes.set(def.agentId, def.type);
      this.citizenSprites.set(def.agentId, def.sprite);
      const r = this.mv.getCitizen(def.agentId);
      if (r) {
        r.setHomePosition(def.position);
        if (def.type === 'npc') r.updateState('idle', null, 1);
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
      this.gridLabel.textContent = `Grid: ${s.cols}\u00D7${s.rows}`;
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
