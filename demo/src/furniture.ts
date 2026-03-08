/**
 * Data-driven furniture system — data, rendering, and layout management.
 * Editor chrome (panel, tabs, input) lives in editor.ts.
 */

// --- Types ---

export type AnchorType = 'work' | 'rest' | 'social' | 'utility' | 'wander';

export const ANCHOR_TYPES: AnchorType[] = ['work', 'rest', 'social', 'utility', 'wander'];

export interface Anchor {
  name: string;
  ox: number;
  oy: number;
  type: AnchorType;
}

export interface FurniturePiece {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: 'below' | 'above';
  anchors?: Anchor[];
}

export type FurnitureLayout = FurniturePiece[];

export interface ResolvedLocation {
  name: string;
  x: number;
  y: number;
  type: AnchorType;
}

// --- Auto-anchor templates ---

const ANCHOR_TEMPLATES: Record<string, Omit<Anchor, 'name'>[]> = {
  desk:           [{ ox: 1, oy: 2, type: 'work' }],
  chair:          [],
  couch:          [{ ox: 0.5, oy: 0, type: 'rest' }, { ox: 1.5, oy: 0, type: 'rest' }],
  coffee_machine: [{ ox: 0.5, oy: 1.8, type: 'utility' }],
  whiteboard:     [{ ox: 1, oy: 1.5, type: 'social' }],
  bookshelf:      [],
  water_cooler:   [{ ox: 0, oy: 1.8, type: 'utility' }],
  plant:          [],
  lamp:           [],
};

function autoAnchors(piece: FurniturePiece, index: number): Anchor[] {
  const templates = ANCHOR_TEMPLATES[piece.id];
  if (!templates || templates.length === 0) return [];
  return templates.map((t, i) => ({
    ...t,
    name: `${piece.id}_${index}_${i}`,
  }));
}

export const ANCHOR_COLORS: Record<AnchorType, string> = {
  work: '#4ade80',
  rest: '#818cf8',
  social: '#fbbf24',
  utility: '#22d3ee',
  wander: '#888888',
};

// --- Loaded piece (internal) ---

export interface LoadedPiece extends FurniturePiece {
  img: HTMLImageElement;
  anchors: Anchor[];
}

// --- Main class ---

export class FurnitureSystem {
  pieces: LoadedPiece[] = [];
  selected: LoadedPiece | null = null;
  wanderPoints: { name: string; x: number; y: number }[];

  private images: Map<string, HTMLImageElement> = new Map();
  private imageSrcs: Map<string, string> = new Map();
  private tileSize: number;
  private scale: number;
  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private onSaveCallback: (() => void) | null = null;
  private deadspaceCheck: ((col: number, row: number) => boolean) | null = null;

  constructor(tileSize: number, scale: number) {
    this.tileSize = tileSize;
    this.scale = scale;
    this.wanderPoints = [
      { name: 'wander_center', x: 7, y: 6 },
      { name: 'wander_lounge', x: 5, y: 8 },
    ];
  }

  async loadSprite(id: string, src: string): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.src = src;
    });
    this.images.set(id, img);
    this.imageSrcs.set(id, src);
  }

  getImageSrcs(): Map<string, string> { return this.imageSrcs; }
  getTileSize(): number { return this.tileSize; }
  getScale(): number { return this.scale; }

  setLayout(layout: FurnitureLayout) {
    this.pieces = layout.map((p, i) => ({
      ...p,
      img: this.images.get(p.id)!,
      anchors: p.anchors ?? autoAnchors(p, i),
    })).filter(p => p.img);
  }

  getLayout(): FurnitureLayout {
    return this.pieces.map(({ id, x, y, w, h, layer, anchors }) => ({
      id, x, y, w, h, layer,
      anchors: anchors.length > 0 ? anchors : undefined,
    }));
  }

  getLocations(): ResolvedLocation[] {
    const locs: ResolvedLocation[] = [];
    for (const p of this.pieces) {
      for (const a of p.anchors) {
        locs.push({
          name: a.name,
          x: Math.round(p.x + a.ox),
          y: Math.round(p.y + a.oy),
          type: a.type,
        });
      }
    }
    for (const wp of this.wanderPoints) {
      locs.push({ name: wp.name, x: wp.x, y: wp.y, type: 'wander' });
    }
    return locs;
  }

  getLocationMap(): Record<string, { x: number; y: number; label: string }> {
    const map: Record<string, { x: number; y: number; label: string }> = {};
    for (const loc of this.getLocations()) {
      map[loc.name] = { x: loc.x, y: loc.y, label: loc.name };
    }
    return map;
  }

  onSave(callback: () => void) { this.onSaveCallback = callback; }

  /** Register a callback to check if a tile is deadspace */
  setDeadspaceCheck(check: (col: number, row: number) => boolean) {
    this.deadspaceCheck = check;
  }

  /** Check if any furniture piece occupies a given tile */
  occupiesTile(col: number, row: number): boolean {
    for (const p of this.pieces) {
      if (col >= Math.floor(p.x) && col < Math.ceil(p.x + p.w) &&
          row >= Math.floor(p.y) && row < Math.ceil(p.y + p.h)) {
        return true;
      }
    }
    return false;
  }

  /** Check if a piece's bounds overlap any deadspace tiles */
  private overlapsDeadspace(x: number, y: number, w: number, h: number): boolean {
    if (!this.deadspaceCheck) return false;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.ceil(x + w);
    const y1 = Math.ceil(y + h);
    for (let r = y0; r < y1; r++) {
      for (let c = x0; c < x1; c++) {
        if (this.deadspaceCheck(c, r)) return true;
      }
    }
    return false;
  }

  /** Returns tile coords blocked by furniture bounds */
  getBlockedTiles(): Set<string> {
    const blocked = new Set<string>();
    for (const p of this.pieces) {
      const x0 = Math.floor(p.x);
      const y0 = Math.floor(p.y);
      const x1 = Math.ceil(p.x + p.w);
      const y1 = Math.ceil(p.y + p.h);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          blocked.add(`${x},${y}`);
        }
      }
    }
    return blocked;
  }

  setWanderPoints(points: { name: string; x: number; y: number }[]) {
    this.wanderPoints = points;
  }

  save() {
    console.log('[furniture] Layout updated');
    this.onSaveCallback?.();
  }

  addPiece(id: string): LoadedPiece | null {
    const img = this.images.get(id);
    if (!img) return null;
    const aspect = img.naturalWidth / img.naturalHeight;
    const h = 2;
    const w = Math.round(h * aspect * 10) / 10;

    // Find a valid placement spot (skip deadspace)
    let px = 6, py = 5;
    if (this.overlapsDeadspace(px, py, w, h)) {
      let found = false;
      for (let r = 1; r < 20 && !found; r++) {
        for (let c = 1; c < 20 && !found; c++) {
          if (!this.overlapsDeadspace(c, r, w, h)) {
            px = c; py = r; found = true;
          }
        }
      }
    }

    const index = this.pieces.length;
    const piece: LoadedPiece = {
      id, img,
      x: px, y: py,
      w, h,
      layer: id === 'chair' ? 'above' : 'below',
      anchors: autoAnchors({ id, x: 6, y: 5, w, h, layer: 'below' }, index),
    };
    this.pieces.push(piece);
    return piece;
  }

  removePiece(piece: LoadedPiece) {
    this.pieces = this.pieces.filter(p => p !== piece);
    if (this.selected === piece) this.selected = null;
  }

  // --- Rendering ---

  renderBelow(ctx: CanvasRenderingContext2D) {
    ctx.imageSmoothingEnabled = false;
    const T = this.tileSize;
    for (const p of this.pieces) {
      if (p.layer === 'below') {
        ctx.drawImage(p.img, p.x * T, p.y * T, p.w * T, p.h * T);
      }
    }
  }

  renderAbove(ctx: CanvasRenderingContext2D) {
    ctx.imageSmoothingEnabled = false;
    const T = this.tileSize;
    for (const p of this.pieces) {
      if (p.layer === 'above') {
        ctx.drawImage(p.img, p.x * T, p.y * T, p.w * T, p.h * T);
      }
    }
  }

  // --- Mouse interaction (world pixel coords) ---

  handleMouseDown(wx: number, wy: number): boolean {
    const hit = this.pieceAt(wx, wy);
    this.selected = hit;
    if (hit) {
      this.dragging = true;
      this.dragOffsetX = wx - hit.x * this.tileSize;
      this.dragOffsetY = wy - hit.y * this.tileSize;
      return true;
    }
    return false;
  }

  handleMouseMove(wx: number, wy: number) {
    if (!this.dragging || !this.selected) return;
    const T = this.tileSize;
    const newX = this.snap((wx - this.dragOffsetX) / T);
    const newY = this.snap((wy - this.dragOffsetY) / T);

    // Don't allow dragging into deadspace
    if (this.overlapsDeadspace(newX, newY, this.selected.w, this.selected.h)) return;

    this.selected.x = newX;
    this.selected.y = newY;
  }

  handleMouseUp() { this.dragging = false; }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.selected) return false;

    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this.removePiece(this.selected);
      return true;
    }

    if ((e.key === 'l' || e.key === 'L') && this.selected) {
      this.selected.layer = this.selected.layer === 'below' ? 'above' : 'below';
      return true;
    }

    if (this.selected && e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 1 : 0.25;
      const s = this.selected;
      let nx = s.x, ny = s.y;
      if (e.key === 'ArrowLeft') nx -= step;
      if (e.key === 'ArrowRight') nx += step;
      if (e.key === 'ArrowUp') ny -= step;
      if (e.key === 'ArrowDown') ny += step;
      if (!this.overlapsDeadspace(nx, ny, s.w, s.h)) {
        s.x = nx;
        s.y = ny;
      }
      e.preventDefault();
      return true;
    }

    if (this.selected && (e.key === '=' || e.key === '+')) {
      this.selected.w += 0.1;
      this.selected.h += 0.1;
      return true;
    }
    if (this.selected && e.key === '-') {
      this.selected.w = Math.max(0.5, this.selected.w - 0.1);
      this.selected.h = Math.max(0.5, this.selected.h - 0.1);
      return true;
    }

    return false;
  }

  // --- Helpers ---

  pieceAt(wx: number, wy: number): LoadedPiece | null {
    const T = this.tileSize;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      const px = p.x * T, py = p.y * T, pw = p.w * T, ph = p.h * T;
      if (wx >= px && wx <= px + pw && wy >= py && wy <= py + ph) {
        return p;
      }
    }
    return null;
  }

  private snap(v: number): number {
    return Math.round(v * 4) / 4;
  }
}
