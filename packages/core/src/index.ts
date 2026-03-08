import { Renderer } from './renderer/Renderer';
import { Scene } from './scene/Scene';
import type { SceneConfig, NamedLocation } from './scene/Scene';
import { SpriteSheet } from './sprites/SpriteSheet';
import type { SpriteSheetConfig } from './sprites/SpriteSheet';
import { Resident, ResidentLayer, TileReservation } from './residents/Resident';
import type { ResidentConfig, AgentState, TypedLocation, AnchorType } from './residents/Resident';
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
  residents: ResidentConfig[];
  scale?: number;
  width?: number;
  height?: number;
  worldBasePath?: string;
  spriteSheets?: Record<string, SpriteSheetConfig>;
  sceneConfig?: SceneConfig;
  objects?: ObjectConfig[];
}

type MiniverseEvent = 'resident:click' | 'object:click' | 'intercom';

export class Miniverse {
  private renderer: Renderer;
  private scene: Scene;
  private residents: Resident[] = [];
  private residentLayer: ResidentLayer;
  private objects: InteractiveObject[] = [];
  private particles: ParticleSystem;
  private speechBubbles: SpeechBubbleSystem;
  private signal: Signal;
  private config: MiniverseConfig;
  private eventHandlers: Map<MiniverseEvent, Set<(data: unknown) => void>> = new Map();

  private particleTimers: Map<string, number> = new Map();
  private typedLocations: TypedLocation[] = [];
  private reservation = new TileReservation();

  constructor(config: MiniverseConfig) {
    this.config = config;
    const scale = config.scale ?? 2;
    const width = config.width ?? 512;
    const height = config.height ?? 384;

    this.renderer = new Renderer(config.container, width, height, scale);
    this.scene = new Scene(config.sceneConfig ?? createDefaultSceneConfig());
    this.residentLayer = new ResidentLayer();
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
    for (const layer of this.residentLayer.getLayers()) {
      this.renderer.addLayer(layer);
    }
    this.renderer.addLayer(this.particles);
    this.renderer.addLayer(this.speechBubbles);

    // Tooltip layer
    this.renderer.addLayer({
      order: 30,
      render: (ctx) => {
        for (const r of this.residents) {
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

    // Set up click handler
    this.renderer.canvas.addEventListener('click', (e) => this.handleClick(e));

    // Set up objects
    if (config.objects) {
      for (const objConfig of config.objects) {
        this.objects.push(new InteractiveObject(objConfig));
      }
    }

    // Update loop for residents
    this.renderer.addLayer({
      order: -1,
      render: (_ctx, delta) => {
        const locations: Record<string, { x: number; y: number }> = {};
        for (const [key, loc] of Object.entries(this.scene.config.locations)) {
          locations[key] = { x: loc.x, y: loc.y };
        }
        for (const resident of this.residents) {
          const otherHomes = this.getOtherHomeAnchors(resident.agentId);
          resident.update(delta, this.scene.pathfinder, locations, this.typedLocations, this.reservation, otherHomes);
          this.updateResidentEffects(resident, delta);
        }
      },
    });
  }

  async start(): Promise<void> {
    const basePath = this.config.worldBasePath ?? `worlds/${this.config.world}`;

    await this.scene.load(basePath);

    // Load residents
    for (const resConfig of this.config.residents) {
      const sheetConfig = this.config.spriteSheets?.[resConfig.sprite] ?? createDefaultSpriteConfig();
      const sheet = new SpriteSheet(sheetConfig);
      await sheet.load(`${basePath}/residents/sprites`);

      const resident = new Resident(
        resConfig,
        sheet,
        this.scene.config.tileWidth,
        this.scene.config.tileHeight,
      );

      // Place at named location (scene locations, then typed locations)
      const loc = this.scene.getLocation(resConfig.position);
      if (loc) {
        resident.setTilePosition(loc.x, loc.y);
      } else {
        const typed = this.typedLocations.find(l => l.name === resConfig.position);
        if (typed) resident.setTilePosition(typed.x, typed.y);
      }

      this.residents.push(resident);
    }

    this.residentLayer.setResidents(this.residents);
    this.signal.start();
    this.renderer.start();
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

      // All residents face "camera" (down)
      for (const resident of this.residents) {
        if (resident.visible) {
          resident.faceDirection('down');
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
    for (const layer of config.layers) {
      for (let r = 0; r < newRows; r++) {
        if (r >= layer.length) {
          layer[r] = new Array(newCols).fill(0);
        }
        while (layer[r].length < newCols) {
          layer[r].push(0);
        }
        layer[r].length = newCols;
      }
      layer.length = newRows;

      // Set border tiles to wall (tile index 1)
      for (let r = 0; r < newRows; r++) {
        for (let c = 0; c < newCols; c++) {
          if (r === 0 || r === newRows - 1 || c === 0 || c === newCols - 1) {
            layer[r][c] = 1;
          } else if (r >= oldRows - 1 || c >= oldCols - 1) {
            // Old border that's now interior becomes floor
            layer[r][c] = 0;
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

  getFloorLayer(): number[][] {
    return this.scene.config.layers[0];
  }

  setTile(col: number, row: number, tileId: number) {
    const layer = this.scene.config.layers[0];
    if (row >= 0 && row < layer.length && col >= 0 && col < layer[0].length) {
      layer[row][col] = tileId;
      // Deadspace tiles are non-walkable
      const walkable = this.scene.config.walkable;
      if (row < walkable.length && col < walkable[0].length) {
        walkable[row][col] = tileId >= 0;
      }
    }
  }

  getTilesetImage(): HTMLImageElement | null {
    return (this.scene as any).tileImages?.[0] ?? null;
  }

  getTilesetConfig() {
    return this.scene.config.tilesets[0];
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
        const isDead = floor?.[r]?.[c] < 0;
        grid[r][c] = !isEdge && !isDead;
      }
    }

    // Overlay furniture blocks
    for (const key of blockedTiles) {
      const [x, y] = key.split(',').map(Number);
      if (y >= 0 && y < rows && x >= 0 && x < cols) {
        grid[y][x] = false;
      }
    }

    // Keep anchor destinations walkable so pathfinding can reach them
    // (but never override deadspace)
    for (const loc of this.typedLocations) {
      if (loc.y >= 0 && loc.y < rows && loc.x >= 0 && loc.x < cols) {
        if (floor?.[loc.y]?.[loc.x] >= 0) {
          grid[loc.y][loc.x] = true;
        }
      }
    }
  }

  getReservation(): TileReservation {
    return this.reservation;
  }

  getResident(agentId: string): Resident | undefined {
    return this.residents.find(r => r.agentId === agentId);
  }

  getResidents(): Resident[] {
    return [...this.residents];
  }

  private handleSignalUpdate(agents: AgentStatus[]) {
    for (const agent of agents) {
      const resident = this.residents.find(r => r.agentId === agent.id);
      if (resident) {
        const prevState = resident.state;
        resident.updateState(agent.state, agent.task, agent.energy);

        // Handle state transitions
        if (prevState !== agent.state) {
          this.handleStateTransition(resident, prevState, agent.state);
        }

        // Update monitor glow
        for (const obj of this.objects) {
          if (obj.config.type === 'monitor' && obj.config.id === `monitor_${agent.id}`) {
            obj.setGlow(agent.state === 'working');
          }
        }
      }
    }
  }

  /** Returns anchor names assigned as home positions to other residents */
  private getOtherHomeAnchors(excludeAgentId: string): Set<string> {
    const homes = new Set<string>();
    for (const r of this.residents) {
      if (r.agentId !== excludeAgentId) {
        homes.add(r.getHomePosition());
      }
    }
    return homes;
  }

  private handleStateTransition(resident: Resident, from: AgentState, to: AgentState) {
    // All assigned home anchors belonging to other residents are always off-limits
    const otherHomes = this.getOtherHomeAnchors(resident.agentId);

    if (this.typedLocations.length > 0) {
      if (to === 'working') {
        // Go to assigned home anchor specifically
        const home = resident.getHomePosition();
        if (!resident.goToAnchor(home, this.typedLocations, this.scene.pathfinder, this.reservation)) {
          // Fallback: any unassigned work anchor
          resident.goToAnchorType('work', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
        }
      } else if (to === 'sleeping') {
        resident.goToAnchorType('rest', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
      } else if (to === 'speaking') {
        resident.goToAnchorType('social', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
      } else if (to === 'thinking') {
        resident.goToAnchorType('utility', this.typedLocations, this.scene.pathfinder, this.reservation, otherHomes);
      }
    }

    if (to === 'working' && resident.task) {
      this.speechBubbles.show(resident.x + 16, resident.y - 8, resident.task, 4, resident);
    } else if (to === 'error') {
      this.particles.emitExclamation(resident.x + 16, resident.y - resident.getSittingOffset());
    } else if (to === 'speaking' && resident.task) {
      this.speechBubbles.show(resident.x + 16, resident.y - 8, resident.task, 5, resident);
    }
  }

  private updateResidentEffects(resident: Resident, delta: number) {
    const key = resident.agentId;
    const timer = (this.particleTimers.get(key) ?? 0) + delta;
    this.particleTimers.set(key, timer);

    if (resident.state === 'sleeping' && timer > 1.5) {
      this.particleTimers.set(key, 0);
      this.particles.emitZzz(resident.x + 16, resident.y);
    }

    if (resident.state === 'thinking' && timer > 2) {
      this.particleTimers.set(key, 0);
      this.particles.emitThought(resident.x + 16, resident.y);
    }

    if (resident.state === 'error' && timer > 2) {
      this.particleTimers.set(key, 0);
      this.particles.emitExclamation(resident.x + 16, resident.y);
    }
  }

  private handleClick(e: MouseEvent) {
    const world = this.renderer.screenToWorld(e.offsetX, e.offsetY);

    // Check residents
    for (const resident of this.residents) {
      if (resident.containsPoint(world.x, world.y)) {
        this.emit('resident:click', {
          agentId: resident.agentId,
          name: resident.name,
          state: resident.state,
          task: resident.task,
          energy: resident.energy,
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
  const floor: number[][] = [];
  const walkable: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    floor[r] = [];
    walkable[r] = [];
    for (let c = 0; c < cols; c++) {
      // Walls around the edges
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        floor[r][c] = 1; // wall tile
        walkable[r][c] = false;
      } else {
        floor[r][c] = 0; // floor tile
        walkable[r][c] = true;
      }
    }
  }

  // Desks (non-walkable)
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
    tilesets: [{
      image: 'tilesets/office.png',
      tileWidth: 32,
      tileHeight: 32,
      columns: 16,
    }],
  };
}

function createDefaultSpriteConfig(): SpriteSheetConfig {
  return {
    sheets: {
      base: 'morty_walk.png',
    },
    animations: {
      idle_down: { sheet: 'base', row: 0, frames: 2, speed: 0.5 },
      idle_up: { sheet: 'base', row: 1, frames: 2, speed: 0.5 },
      walk_down: { sheet: 'base', row: 0, frames: 4, speed: 0.2 },
      walk_up: { sheet: 'base', row: 1, frames: 4, speed: 0.2 },
      walk_left: { sheet: 'base', row: 2, frames: 4, speed: 0.2 },
      walk_right: { sheet: 'base', row: 3, frames: 4, speed: 0.2 },
      working: { sheet: 'base', row: 0, frames: 2, speed: 0.3 },
      sleeping: { sheet: 'base', row: 0, frames: 2, speed: 0.8 },
      talking: { sheet: 'base', row: 0, frames: 4, speed: 0.15 },
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
export { Scene, Pathfinder } from './scene';
export type { SceneConfig, TilesetConfig, NamedLocation } from './scene';
export { Resident, ResidentLayer, TileReservation } from './residents';
export type { ResidentConfig, AgentState, TypedLocation, AnchorType } from './residents';
export { InteractiveObject } from './objects';
export type { ObjectConfig } from './objects';
export { ParticleSystem } from './effects';
export { SpeechBubbleSystem } from './effects';
export { Signal } from './signal';
export type { SignalConfig, SignalCallback, AgentStatus } from './signal';
