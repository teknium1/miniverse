import { Renderer } from './renderer/Renderer';
import { Scene } from './scene/Scene';
import type { SceneConfig, NamedLocation } from './scene/Scene';
import { SpriteSheet } from './sprites/SpriteSheet';
import type { SpriteSheetConfig } from './sprites/SpriteSheet';
import { Citizen, CitizenLayer, TileReservation } from './citizens/Citizen';
import type { CitizenConfig, AgentState, TypedLocation, AnchorType } from './citizens/Citizen';
import { InteractiveObject } from './objects/InteractiveObject';
import type { ObjectConfig } from './objects/InteractiveObject';
import { ParticleSystem } from './effects/Particles';
import { SpeechBubbleSystem } from './effects/SpeechBubble';
import { Signal } from './signal/Signal';
import type { SignalConfig, AgentStatus } from './signal/Signal';

export interface MiniverseConfig {
  container: HTMLElement;
  world: string;
  scene: string;
  signal: SignalConfig;
  citizens: CitizenConfig[];
  scale?: number;
  width?: number;
  height?: number;
  worldBasePath?: string;
  spriteSheets?: Record<string, SpriteSheetConfig>;
  sceneConfig?: SceneConfig;
  objects?: ObjectConfig[];
  /** Sprite names to cycle through when auto-creating citizens for new agents */
  defaultSprites?: string[];
  /** Set to false to disable auto-creating citizens for unknown agents (default: true) */
  autoSpawn?: boolean;
}

type MiniverseEvent = 'citizen:click' | 'object:click' | 'intercom';

export class Miniverse {
  private renderer: Renderer;
  private scene: Scene;
  private citizens: Citizen[] = [];
  private citizenLayer: CitizenLayer;
  private objects: InteractiveObject[] = [];
  private particles: ParticleSystem;
  private speechBubbles: SpeechBubbleSystem;
  private signal: Signal;
  private config: MiniverseConfig;
  private eventHandlers: Map<MiniverseEvent, Set<(data: unknown) => void>> = new Map();

  private particleTimers: Map<string, number> = new Map();
  private typedLocations: TypedLocation[] = [];
  private reservation = new TileReservation();
  /** Agent IDs currently being spawned (to avoid duplicate async addCitizen calls) */
  private spawningAgents: Set<string> = new Set();
  private autoSpawnIndex = 0;

  constructor(config: MiniverseConfig) {
    this.config = config;
    const scale = config.scale ?? 2;
    const width = config.width ?? 512;
    const height = config.height ?? 384;

    this.renderer = new Renderer(config.container, width, height, scale);
    this.scene = new Scene(config.sceneConfig ?? createDefaultSceneConfig());
    this.citizenLayer = new CitizenLayer();
    this.particles = new ParticleSystem();
    this.speechBubbles = new SpeechBubbleSystem();
    this.signal = new Signal(config.signal);

    // Add render layers
    this.renderer.addLayer(this.scene);
    this.renderer.addLayer({
      order: 5,
      render: (ctx, delta) => {
        for (const obj of this.objects) {
          obj.update(delta);
          obj.draw(ctx);
        }
      },
    });
    for (const layer of this.citizenLayer.getLayers()) {
      this.renderer.addLayer(layer);
    }
    this.renderer.addLayer(this.particles);
    this.renderer.addLayer(this.speechBubbles);

    // Tooltip layer
    this.renderer.addLayer({
      order: 30,
      render: (ctx) => {
        for (const r of this.citizens) {
          if (!r.visible) continue;
          // Draw name tag
          ctx.save();
          ctx.font = '8px monospace';
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          const nameWidth = ctx.measureText(r.name).width;
          const tagX = r.x + (this.scene.config.tileWidth - nameWidth) / 2;
          const tagY = r.y - r.spriteSheet.config.frameHeight + this.scene.config.tileHeight - 4 - r.getSittingOffset();
          ctx.fillRect(tagX - 2, tagY - 8, nameWidth + 4, 12);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(r.name, tagX, tagY);
          ctx.restore();
        }
      },
    });

    // Set up signal handler
    this.signal.onUpdate((agents) => this.handleSignalUpdate(agents));

    // Handle DM events — walk sender to adjacent tile near recipient
    this.signal.onEvent((event) => {
      if (event.action?.type === 'message' && event.action?.to) {
        const sender = this.citizens.find(r => r.agentId === event.agentId);
        const recipient = this.citizens.find(r => r.agentId === event.action.to);
        if (sender && recipient && sender !== recipient) {
          const sPos = sender.getTilePosition();
          const rPos = recipient.getTilePosition();
          // Try adjacent tiles (left, right, up, down) — pick the shortest reachable path
          const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];
          let bestPath: { x: number; y: number }[] = [];
          for (const [dx, dy] of offsets) {
            const path = this.scene.pathfinder.findPath(sPos.x, sPos.y, rPos.x + dx, rPos.y + dy);
            if (path.length > 1 && (bestPath.length === 0 || path.length < bestPath.length)) {
              bestPath = path;
            }
          }
          if (bestPath.length > 1) {
            sender.walkTo(bestPath);
          }
        }
      }
    });

    // Set up click handler
    this.renderer.canvas.addEventListener('click', (e) => this.handleClick(e));

    // Set up objects
    if (config.objects) {
      for (const objConfig of config.objects) {
        this.objects.push(new InteractiveObject(objConfig));
      }
    }

    // Update loop for citizens
    this.renderer.addLayer({
      order: -1,
      render: (_ctx, delta) => {
        const locations: Record<string, { x: number; y: number }> = {};
        for (const [key, loc] of Object.entries(this.scene.config.locations)) {
          locations[key] = { x: loc.x, y: loc.y };
        }
        for (const citizen of this.citizens) {
          const otherHomes = this.getOtherHomeAnchors(citizen.agentId);
          citizen.update(delta, this.scene.pathfinder, locations, this.typedLocations, this.reservation, otherHomes);
          citizen.applySeparation(this.citizens, delta);
          this.updateCitizenEffects(citizen, delta);
        }
      },
    });
  }

  async start(): Promise<void> {
    const basePath = this.config.worldBasePath ?? `worlds/${this.config.world}`;

    await this.scene.load(basePath);

    // Load citizens
    for (const resConfig of this.config.citizens) {
      const sheetConfig = this.config.spriteSheets?.[resConfig.sprite]
        ?? createStandardSpriteConfig(resConfig.sprite);
      const sheet = new SpriteSheet(sheetConfig);
      await sheet.load(basePath);

      const citizen = new Citizen(
        resConfig,
        sheet,
        this.scene.config.tileWidth,
        this.scene.config.tileHeight,
      );

      // Place at named location (scene locations, then typed locations)
      const loc = this.scene.getLocation(resConfig.position);
      if (loc) {
        citizen.setTilePosition(loc.x, loc.y);
      } else {
        const typed = this.typedLocations.find(l => l.name === resConfig.position);
        if (typed) citizen.setTilePosition(typed.x, typed.y);
      }

      this.citizens.push(citizen);
    }

    this.citizenLayer.setCitizens(this.citizens);
    this.unstickCitizens();
    this.signal.start();
    this.renderer.start();
  }

  /** Nudge any citizen that can't pathfind to any destination to the nearest open tile */
  private unstickCitizens() {
    const grid = this.scene.config.walkable;
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]] as const;

    // Collect all destination tiles (wander points + typed locations)
    const destinations = this.typedLocations
      .filter(l => l.type === 'wander' || l.type === 'social' || l.type === 'utility')
      .map(l => ({ x: l.x, y: l.y }));

    // Count how many walkable neighbors a tile has (connectivity score)
    const connectivity = (tx: number, ty: number) => {
      let count = 0;
      for (const [dx, dy] of dirs) {
        const nx = tx + dx, ny = ty + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && grid[ny][nx]) count++;
      }
      return count;
    };

    for (const citizen of this.citizens) {
      const tile = citizen.getTilePosition();

      // Check if we can pathfind to at least one destination
      const canReachAny = destinations.some(d =>
        this.scene.pathfinder.findPath(tile.x, tile.y, d.x, d.y).length > 1
      );
      if (canReachAny) continue;

      // BFS outward for nearest well-connected tile that can reach a destination
      const visited = new Set<string>();
      const queue: { x: number; y: number }[] = [{ x: tile.x, y: tile.y }];
      visited.add(`${tile.x},${tile.y}`);
      let found = false;

      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const [dx, dy] of dirs) {
          const nx = cur.x + dx, ny = cur.y + dy;
          const key = `${nx},${ny}`;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          if (visited.has(key)) continue;
          visited.add(key);

          if (grid[ny][nx] && connectivity(nx, ny) >= 2) {
            // Verify this tile can actually reach a destination
            const reachable = destinations.some(d =>
              this.scene.pathfinder.findPath(nx, ny, d.x, d.y).length > 1
            );
            if (reachable) {
              citizen.setTilePosition(nx, ny);
              console.log(`[miniverse] Unstuck "${citizen.agentId}" from (${tile.x},${tile.y}) to (${nx},${ny})`);
              found = true;
              break;
            }
          }
          queue.push({ x: nx, y: ny });
        }
        if (found) break;
      }
    }
  }

  stop() {
    this.renderer.stop();
    this.signal.stop();
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.canvas;
  }

  addLayer(layer: { order: number; render(ctx: CanvasRenderingContext2D, delta: number): void }) {
    this.renderer.addLayer(layer);
  }

  on(event: MiniverseEvent, handler: (data: unknown) => void) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: MiniverseEvent, handler: (data: unknown) => void) {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: MiniverseEvent, data: unknown) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  triggerEvent(type: string, data?: Record<string, unknown>) {
    if (type === 'intercom') {
      // Activate intercom object
      for (const obj of this.objects) {
        if (obj.config.type === 'intercom') {
          obj.activate();
        }
      }

      // All citizens face "camera" (down)
      for (const citizen of this.citizens) {
        if (citizen.visible) {
          citizen.faceDirection('down');
        }
      }

      if (data?.message) {
        this.speechBubbles.show(
          this.renderer.canvas.width / (2 * (this.config.scale ?? 2)),
          20,
          String(data.message),
          4,
        );
      }

      this.emit('intercom', data ?? {});
    }
  }

  setTypedLocations(locations: TypedLocation[]) {
    this.typedLocations = locations;
  }

  /** Resize the grid by expanding right/down. Existing coords stay the same. */
  resizeGrid(newCols: number, newRows: number) {
    const config = this.scene.config;
    const oldRows = config.walkable.length;
    const oldCols = config.walkable[0]?.length ?? 0;
    if (newCols < 4 || newRows < 4) return;

    // Expand walkable grid
    for (let r = 0; r < newRows; r++) {
      if (r >= oldRows) {
        config.walkable[r] = new Array(newCols).fill(true);
      }
      while (config.walkable[r].length < newCols) {
        config.walkable[r].push(true);
      }
      config.walkable[r].length = newCols;
    }
    config.walkable.length = newRows;

    // Expand floor layer
    const defaultTile = Object.keys(config.tiles)[0] ?? 'floor';
    for (const layer of config.layers) {
      for (let r = 0; r < newRows; r++) {
        if (r >= layer.length) {
          layer[r] = new Array(newCols).fill(defaultTile);
        }
        while (layer[r].length < newCols) {
          layer[r].push(defaultTile);
        }
        layer[r].length = newCols;
      }
      layer.length = newRows;

      // New expansion cells get the default floor tile
      for (let r = 0; r < newRows; r++) {
        for (let c = 0; c < newCols; c++) {
          if (r >= oldRows || c >= oldCols) {
            layer[r][c] = defaultTile;
          }
        }
      }
    }

    // Resize canvas to match
    const tw = config.tileWidth;
    const th = config.tileHeight;
    this.renderer.resize(newCols * tw, newRows * th);
  }

  getGridSize(): { cols: number; rows: number } {
    const grid = this.scene.config.walkable;
    return { cols: grid[0]?.length ?? 0, rows: grid.length };
  }

  getFloorLayer(): string[][] {
    return this.scene.config.layers[0];
  }

  setTile(col: number, row: number, tileKey: string) {
    const layer = this.scene.config.layers[0];
    if (row >= 0 && row < layer.length && col >= 0 && col < layer[0].length) {
      layer[row][col] = tileKey;
      const walkable = this.scene.config.walkable;
      if (row < walkable.length && col < walkable[0].length) {
        walkable[row][col] = tileKey !== '';
      }
    }
  }

  getTiles(): Record<string, string> {
    return this.scene.config.tiles;
  }

  getTileImages(): Map<string, HTMLImageElement> {
    return this.scene.getTileImages();
  }

  addTile(key: string, img: HTMLImageElement, src?: string) {
    this.scene.addTile(key, img);
    if (src) this.scene.config.tiles[key] = src;
  }

  /** Update walkability grid: reset to base then overlay blocked tiles */
  updateWalkability(blockedTiles: Set<string>) {
    const grid = this.scene.config.walkable;
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;

    // Reset: walls on edges, deadspace tiles, floor inside
    const floor = this.scene.config.layers[0];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isEdge = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
        const isDead = floor?.[r]?.[c] === '';
        grid[r][c] = !isEdge && !isDead;
      }
    }

    // Overlay prop blocks
    for (const key of blockedTiles) {
      const [x, y] = key.split(',').map(Number);
      if (y >= 0 && y < rows && x >= 0 && x < cols) {
        grid[y][x] = false;
      }
    }

    // Keep anchor destinations walkable so pathfinding can reach them,
    // and ensure at least one adjacent "approach tile" is also walkable
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    for (const loc of this.typedLocations) {
      if (loc.y >= 0 && loc.y < rows && loc.x >= 0 && loc.x < cols) {
        if (floor?.[loc.y]?.[loc.x] !== '') {
          grid[loc.y][loc.x] = true;
        }
      }
      // Ensure at least one neighbor is walkable so the anchor is reachable
      let hasApproach = false;
      for (const [dx, dy] of dirs) {
        const nx = loc.x + dx, ny = loc.y + dy;
        if (nx > 0 && nx < cols - 1 && ny > 0 && ny < rows - 1 && grid[ny][nx]) {
          hasApproach = true;
          break;
        }
      }
      if (!hasApproach) {
        // Open the best neighbor (prefer below, then sides) as an approach tile
        for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
          const nx = loc.x + dx, ny = loc.y + dy;
          if (nx > 0 && nx < cols - 1 && ny > 0 && ny < rows - 1 && floor?.[ny]?.[nx] !== '') {
            grid[ny][nx] = true;
            break;
          }
        }
      }
    }
  }

  getReservation(): TileReservation {
    return this.reservation;
  }

  getCitizen(agentId: string): Citizen | undefined {
    return this.citizens.find(r => r.agentId === agentId);
  }

  getCitizens(): Citizen[] {
    return [...this.citizens];
  }

  getSpriteSheetKeys(): string[] {
    return Object.keys(this.config.spriteSheets ?? {});
  }

  getSpriteSheetConfig(key: string): SpriteSheetConfig | undefined {
    return this.config.spriteSheets?.[key];
  }

  getBasePath(): string {
    return this.config.worldBasePath ?? `worlds/${this.config.world}`;
  }

  async addCitizen(config: CitizenConfig, sheetConfig?: SpriteSheetConfig): Promise<Citizen> {
    const sc = sheetConfig ?? createStandardSpriteConfig(config.sprite);
    const sheet = new SpriteSheet(sc);
    const basePath = this.config.worldBasePath ?? `worlds/${this.config.world}`;
    await sheet.load(basePath);

    const citizen = new Citizen(
      config,
      sheet,
      this.scene.config.tileWidth,
      this.scene.config.tileHeight,
    );

    // Place at named location
    const loc = this.scene.getLocation(config.position);
    if (loc) {
      citizen.setTilePosition(loc.x, loc.y);
    } else {
      const typed = this.typedLocations.find(l => l.name === config.position);
      if (typed) citizen.setTilePosition(typed.x, typed.y);
    }

    this.citizens.push(citizen);
    this.citizenLayer.setCitizens(this.citizens);
    this.unstickCitizens();
    return citizen;
  }

  removeCitizen(agentId: string) {
    const idx = this.citizens.findIndex(r => r.agentId === agentId);
    if (idx < 0) return;
    this.reservation.release(agentId);
    this.citizens.splice(idx, 1);
    this.citizenLayer.setCitizens(this.citizens);
  }

  /** Timestamps of last movement transition per citizen, for debouncing */
  private lastTransitionTime: Map<string, number> = new Map();
  private static readonly TRANSITION_DEBOUNCE_MS = 8000;

  private handleSignalUpdate(agents: AgentStatus[]) {
    for (const agent of agents) {
      const citizen = this.citizens.find(r => r.agentId === agent.id);
      if (!citizen) {
        // Auto-spawn a citizen for this unknown agent
        if (this.config.autoSpawn !== false
          && agent.state !== 'offline'
          && !this.spawningAgents.has(agent.id)) {
          this.autoSpawnCitizen(agent);
        }
        continue;
      }

      // NPCs drive their own state — skip signal overrides
      if (citizen.isNpc) continue;

      const prevState = citizen.state;
      citizen.updateState(agent.state, agent.task, agent.energy);

      // Handle state transitions with debouncing — rapid hook events
      // (PreToolUse → PostToolUse → Stop) would otherwise cause citizens
      // to constantly turn around before reaching their destination
      if (prevState !== agent.state) {
        const now = Date.now();
        const lastTransition = this.lastTransitionTime.get(citizen.agentId) ?? 0;
        const elapsed = now - lastTransition;

        // Always allow: going to work, going offline, or citizen is standing still
        // Debounce: everything else (don't interrupt a walk mid-path)
        const shouldTransition =
          elapsed >= Miniverse.TRANSITION_DEBOUNCE_MS
          || agent.state === 'working'
          || agent.state === 'offline'
          || prevState === 'offline'
          || !citizen.isMoving();

        if (shouldTransition) {
          this.handleStateTransition(citizen, prevState, agent.state);
          this.lastTransitionTime.set(citizen.agentId, now);
        }
      }

      // Update monitor glow
      for (const obj of this.objects) {
        if (obj.config.type === 'monitor' && obj.config.id === `monitor_${agent.id}`) {
          obj.setGlow(agent.state === 'working');
        }
      }
    }
  }

  private autoSpawnCitizen(agent: AgentStatus) {
    const sprites = this.config.defaultSprites ?? ['nova', 'rio', 'dexter', 'morty'];
    const sprite = sprites[this.autoSpawnIndex % sprites.length];
    this.autoSpawnIndex++;

    // Pick an unreserved wander point as the spawn position
    const wanderPoints = this.typedLocations.filter(l => l.type === 'wander');
    const shuffled = [...wanderPoints].sort(() => Math.random() - 0.5);
    let spawnLoc: TypedLocation | null = shuffled.find(l => this.reservation.isAvailable(l.x, l.y, agent.id))
      ?? shuffled[0] ?? null;

    // Fallback: if no wander points, try any typed location
    if (!spawnLoc && this.typedLocations.length > 0) {
      const anyShuffled = [...this.typedLocations].sort(() => Math.random() - 0.5);
      spawnLoc = anyShuffled.find(l => this.reservation.isAvailable(l.x, l.y, agent.id)) ?? null;
    }

    // Last resort: pick a random walkable tile
    let spawnPosition: string;
    if (spawnLoc) {
      spawnPosition = spawnLoc.name;
      this.reservation.reserve(spawnLoc.x, spawnLoc.y, agent.id);
    } else {
      // Find a random walkable tile that isn't reserved
      const walkable = this.scene.pathfinder.getWalkableTiles();
      const candidates = walkable.sort(() => Math.random() - 0.5);
      const tile = candidates.find(t => this.reservation.isAvailable(t.x, t.y, agent.id))
        ?? candidates[0];
      if (tile) {
        // Create a dynamic position name and reserve it
        spawnPosition = `_spawn_${tile.x}_${tile.y}`;
        this.scene.config.locations[spawnPosition] = { x: tile.x, y: tile.y, label: spawnPosition };
        this.reservation.reserve(tile.x, tile.y, agent.id);
      } else {
        spawnPosition = 'center';
      }
    }

    this.spawningAgents.add(agent.id);
    this.addCitizen({ agentId: agent.id, name: agent.name, sprite, position: spawnPosition })
      .then((citizen) => {
        citizen.updateState(agent.state, agent.task, agent.energy);
      })
      .catch(() => { /* sprite load failed — agent just won't appear */ })
      .finally(() => { this.spawningAgents.delete(agent.id); });
  }

  /** Returns anchor names assigned as home positions to other citizens */
  private getOtherHomeAnchors(excludeAgentId: string): Set<string> {
    const homes = new Set<string>();
    for (const r of this.citizens) {
      if (r.agentId !== excludeAgentId) {
        homes.add(r.getHomePosition());
      }
    }
    return homes;
  }

  private handleStateTransition(citizen: Citizen, from: AgentState, to: AgentState) {
    // All assigned home anchors belonging to other citizens are always off-limits
    const otherHomes = this.getOtherHomeAnchors(citizen.agentId);

    if (this.typedLocations.length > 0) {
      if (to === 'working') {
        // Go to assigned home anchor specifically
        const home = citizen.getHomePosition();
        const anchor = this.typedLocations.find(l => l.name === home);
        if (!citizen.goToAnchor(home, this.typedLocations, this.scene.pathfinder, this.reservation)) {
          // Fallback: any unassigned work anchor
          citizen.goToAnchorType('work', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
        }
      } else if (to === 'sleeping') {
        citizen.goToAnchorType('rest', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
      } else if (to === 'speaking') {
        // If already walking (e.g. toward DM recipient), don't redirect to social anchor
        if (!citizen.isMoving()) {
          citizen.goToAnchorType('social', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
        }
      } else if (to === 'thinking') {
        citizen.goToAnchorType('utility', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
      }
    }

    if (to === 'working' && citizen.task) {
      this.speechBubbles.show(citizen.x + 16, citizen.y - 8, citizen.task, 4, citizen);
    } else if (to === 'error') {
      this.particles.emitExclamation(citizen.x + 16, citizen.y - citizen.getSittingOffset());
    } else if (to === 'speaking' && citizen.task) {
      this.speechBubbles.show(citizen.x + 16, citizen.y - 8, citizen.task, 5, citizen);
    }
  }

  private updateCitizenEffects(citizen: Citizen, delta: number) {
    const key = citizen.agentId;
    const timer = (this.particleTimers.get(key) ?? 0) + delta;
    this.particleTimers.set(key, timer);

    if (citizen.state === 'sleeping' && timer > 1.5) {
      this.particleTimers.set(key, 0);
      this.particles.emitZzz(citizen.x + 16, citizen.y);
    }

    if (citizen.state === 'thinking' && timer > 2) {
      this.particleTimers.set(key, 0);
      this.particles.emitThought(citizen.x + 16, citizen.y);
    }

    if (citizen.state === 'error' && timer > 2) {
      this.particleTimers.set(key, 0);
      this.particles.emitExclamation(citizen.x + 16, citizen.y);
    }
  }

  private handleClick(e: MouseEvent) {
    const world = this.renderer.screenToWorld(e.offsetX, e.offsetY);

    // Check citizens
    for (const citizen of this.citizens) {
      if (citizen.containsPoint(world.x, world.y)) {
        this.emit('citizen:click', {
          agentId: citizen.agentId,
          name: citizen.name,
          state: citizen.state,
          task: citizen.task,
          energy: citizen.energy,
        });
        return;
      }
    }

    // Check objects
    for (const obj of this.objects) {
      if (obj.containsPoint(world.x, world.y)) {
        this.emit('object:click', { id: obj.config.id, type: obj.config.type });
        return;
      }
    }
  }
}

function createDefaultSceneConfig(): SceneConfig {
  const cols = 16;
  const rows = 12;

  // Simple office floor plan
  const floor: string[][] = [];
  const walkable: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    floor[r] = [];
    walkable[r] = [];
    for (let c = 0; c < cols; c++) {
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        floor[r][c] = 'floor';
        walkable[r][c] = false;
      } else {
        floor[r][c] = 'floor';
        walkable[r][c] = true;
      }
    }
  }

  walkable[2][2] = false;
  walkable[2][3] = false;
  walkable[2][6] = false;
  walkable[2][7] = false;

  return {
    name: 'main',
    tileWidth: 32,
    tileHeight: 32,
    layers: [floor],
    walkable,
    locations: {
      desk_1: { x: 3, y: 3, label: 'Desk 1' },
      desk_2: { x: 7, y: 3, label: 'Desk 2' },
      coffee_machine: { x: 12, y: 2, label: 'Coffee Machine' },
      couch: { x: 10, y: 8, label: 'Couch' },
      whiteboard: { x: 7, y: 1, label: 'Whiteboard' },
      intercom: { x: 1, y: 1, label: 'Intercom' },
      center: { x: 7, y: 6, label: 'Center' },
    },
    tiles: {
      floor: 'tiles/office.png',
    },
  };
}

/** Standard sprite sheet config for a citizen using walk + actions convention */
export function createStandardSpriteConfig(sprite: string): SpriteSheetConfig {
  return {
    sheets: {
      walk: `/universal_assets/citizens/${sprite}_walk.png`,
      actions: `/universal_assets/citizens/${sprite}_actions.png`,
    },
    animations: {
      idle_down: { sheet: 'actions', row: 3, frames: 4, speed: 0.5 },
      idle_up: { sheet: 'actions', row: 3, frames: 4, speed: 0.5 },
      walk_down: { sheet: 'walk', row: 0, frames: 4, speed: 0.15 },
      walk_up: { sheet: 'walk', row: 1, frames: 4, speed: 0.15 },
      walk_left: { sheet: 'walk', row: 2, frames: 4, speed: 0.15 },
      walk_right: { sheet: 'walk', row: 3, frames: 4, speed: 0.15 },
      working: { sheet: 'actions', row: 0, frames: 4, speed: 0.3 },
      sleeping: { sheet: 'actions', row: 1, frames: 2, speed: 0.8 },
      talking: { sheet: 'actions', row: 2, frames: 4, speed: 0.15 },
    },
    frameWidth: 64,
    frameHeight: 64,
  };
}

// Re-export everything
export { Renderer } from './renderer';
export type { RenderLayer } from './renderer';
export { Camera } from './renderer';
export { SpriteSheet, Animator } from './sprites';
export type { SpriteSheetConfig, AnimationDef } from './sprites';
export { Scene, Pathfinder, DEADSPACE } from './scene';
export type { SceneConfig, NamedLocation } from './scene';
export { Citizen, CitizenLayer, TileReservation } from './citizens';
export type { CitizenConfig, AgentState, TypedLocation, AnchorType } from './citizens';
export { InteractiveObject } from './objects';
export type { ObjectConfig } from './objects';
export { ParticleSystem } from './effects';
export { SpeechBubbleSystem } from './effects';
export { Signal } from './signal';
export type { SignalConfig, SignalCallback, EventCallback, MessageCallback, AgentStatus } from './signal';
export { PropSystem, ANCHOR_TYPES, ANCHOR_COLORS } from './props';
export type { Anchor, PropPiece, PropLayout, LoadedPiece } from './props';
export { Editor } from './editor';
export type { EditorTab, EditorConfig, SceneSnapshot, SaveSceneFn, CitizenDef } from './editor';
export type {
  AgentAction, WorldEvent, WorldSnapshot,
  CitizenSnapshot, LocationSnapshot, PropSnapshot,
  ServerMessage, ClientMessage,
} from './protocol';
