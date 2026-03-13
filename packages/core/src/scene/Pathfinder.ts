interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

export class Pathfinder {
  private grid: boolean[][];

  constructor(walkableGrid: boolean[][]) {
    this.grid = walkableGrid;
  }

  private get height(): number { return this.grid.length; }
  private get width(): number { return this.grid[0]?.length ?? 0; }

  findPath(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): { x: number; y: number }[] {
    const sx = Math.round(startX);
    const sy = Math.round(startY);
    const ex = Math.round(endX);
    const ey = Math.round(endY);

    if (!this.isWalkable(ex, ey)) return [];

    const open: Node[] = [];
    const closed = new Set<string>();

    const startNode: Node = { x: sx, y: sy, g: 0, h: 0, f: 0, parent: null };
    startNode.h = this.heuristic(sx, sy, ex, ey);
    startNode.f = startNode.h;
    open.push(startNode);

    while (open.length > 0) {
      open.sort((a, b) => a.f - b.f);
      const current = open.shift()!;
      const key = `${current.x},${current.y}`;

      if (current.x === ex && current.y === ey) {
        return this.reconstructPath(current);
      }

      closed.add(key);

      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        const nkey = `${nx},${ny}`;

        if (!this.isWalkable(nx, ny) || closed.has(nkey)) continue;

        const g = current.g + 1;
        const existing = open.find(n => n.x === nx && n.y === ny);

        if (!existing) {
          const h = this.heuristic(nx, ny, ex, ey);
          open.push({ x: nx, y: ny, g, h, f: g + h, parent: current });
        } else if (g < existing.g) {
          existing.g = g;
          existing.f = g + existing.h;
          existing.parent = current;
        }
      }
    }

    return [];
  }

  private isWalkable(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && y < this.height && x < this.width && this.grid[y][x];
  }

  /** Returns all walkable tile coordinates (cached after first call) */
  private walkableCache: { x: number; y: number }[] | null = null;
  getWalkableTiles(): { x: number; y: number }[] {
    if (this.walkableCache) return this.walkableCache;
    const tiles: { x: number; y: number }[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.grid[y][x]) tiles.push({ x, y });
      }
    }
    this.walkableCache = tiles;
    return tiles;
  }

  private heuristic(ax: number, ay: number, bx: number, by: number): number {
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  private reconstructPath(node: Node): { x: number; y: number }[] {
    const path: { x: number; y: number }[] = [];
    let current: Node | null = node;
    while (current) {
      path.unshift({ x: current.x, y: current.y });
      current = current.parent;
    }
    return path;
  }
}
