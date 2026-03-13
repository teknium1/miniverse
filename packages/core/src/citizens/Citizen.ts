import { Animator } from '../sprites/Animator';
import { SpriteSheet } from '../sprites/SpriteSheet';
import type { RenderLayer } from '../renderer/Renderer';
import type { Pathfinder } from '../scene/Pathfinder';

export type AgentState =
  | 'working'
  | 'idle'
  | 'thinking'
  | 'error'
  | 'waiting'
  | 'collaborating'
  | 'sleeping'
  | 'listening'
  | 'speaking'
  | 'offline';

export type AnchorType = 'work' | 'rest' | 'social' | 'utility' | 'wander';

export interface TypedLocation {
  name: string;
  x: number;
  y: number;
  type: AnchorType;
}

/** Maps tile "x,y" → agentId that currently claims it */
export class TileReservation {
  private map = new Map<string, string>();

  private key(x: number, y: number): string { return `${x},${y}`; }

  reserve(x: number, y: number, agentId: string): boolean {
    const k = this.key(x, y);
    const current = this.map.get(k);
    if (current && current !== agentId) return false;
    this.map.set(k, agentId);
    return true;
  }

  release(agentId: string) {
    for (const [k, v] of this.map) {
      if (v === agentId) this.map.delete(k);
    }
  }

  isAvailable(x: number, y: number, agentId: string): boolean {
    const current = this.map.get(this.key(x, y));
    return !current || current === agentId;
  }
}

export interface CitizenConfig {
  agentId: string;
  name: string;
  sprite: string;
  position: string;
  npc?: boolean;
}

const STATE_ANIMATION_MAP: Record<AgentState, string> = {
  working: 'working',
  idle: 'idle_down',
  thinking: 'idle_down',
  error: 'idle_down',
  waiting: 'idle_down',
  collaborating: 'walk_down',
  sleeping: 'sleeping',
  listening: 'idle_down',
  speaking: 'talking',
  offline: 'idle_down',
};

export class Citizen {
  readonly agentId: string;
  readonly name: string;
  readonly animator: Animator;
  readonly spriteSheet: SpriteSheet;

  x = 0;
  y = 0;
  state: AgentState = 'idle';
  task: string | null = null;
  energy = 1;
  visible = true;

  /** Separation steering offset (pixels), applied during rendering */
  separationX = 0;
  separationY = 0;

  private path: { x: number; y: number }[] = [];
  private pathIndex = 0;
  private moveSpeed = 2; // tiles per second
  private moveProgress = 0;
  private homePosition = '';
  private tileWidth = 16;
  private tileHeight = 16;
  private frameWidth: number;
  private frameHeight: number;

  private idleBehaviorTimer = 0;
  private idleBehaviorInterval = 5 + Math.random() * 5;
  private currentAnchor: string | null = null;

  // NPC auto-behavior
  readonly isNpc: boolean;
  private npcPhase: 'idle' | 'working' | 'resting' = 'idle';
  private npcPhaseTimer = 0;
  private npcPhaseDuration = 0;

  constructor(
    config: CitizenConfig,
    spriteSheet: SpriteSheet,
    tileWidth: number,
    tileHeight: number,
  ) {
    this.agentId = config.agentId;
    this.name = config.name;
    this.spriteSheet = spriteSheet;
    this.animator = new Animator(spriteSheet);
    this.homePosition = config.position;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    this.frameWidth = spriteSheet.config.frameWidth;
    this.frameHeight = spriteSheet.config.frameHeight;
    this.isNpc = config.npc ?? false;
    if (this.isNpc) {
      this.npcPhase = 'idle';
      this.npcPhaseDuration = 3 + Math.random() * 5; // start with a short wander phase
    }
  }

  getHomePosition(): string {
    return this.homePosition;
  }

  setHomePosition(position: string) {
    this.homePosition = position;
  }

  setPixelPosition(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  setTilePosition(tileX: number, tileY: number) {
    this.x = tileX * this.tileWidth;
    this.y = tileY * this.tileHeight;
  }

  getTilePosition(): { x: number; y: number } {
    return {
      x: Math.round(this.x / this.tileWidth),
      y: Math.round(this.y / this.tileHeight),
    };
  }

  walkTo(path: { x: number; y: number }[]) {
    if (path.length <= 1) return;
    this.path = path;
    this.pathIndex = 1;
    this.moveProgress = 0;
  }

  isMoving(): boolean {
    return this.pathIndex < this.path.length;
  }

  updateState(state: AgentState, task: string | null, energy: number) {
    const prevState = this.state;
    this.state = state;
    this.task = task;
    this.energy = energy;
    this.visible = state !== 'offline';

    if (prevState !== state && !this.isMoving()) {
      const anim = STATE_ANIMATION_MAP[state] ?? 'idle_down';
      this.animator.play(anim);
    }
  }

  faceDirection(dir: 'up' | 'down' | 'left' | 'right') {
    const base = this.state === 'idle' ? 'idle' : 'walk';
    const animName = `${base}_${dir}`;
    if (this.spriteSheet.config.animations[animName]) {
      this.animator.play(animName);
    }
  }

  update(
    delta: number,
    pathfinder: Pathfinder,
    locations: Record<string, { x: number; y: number }>,
    typedLocations?: TypedLocation[],
    reservation?: TileReservation,
    excludeNames?: Set<string>,
  ) {
    // NPC auto-behavior: cycle through phases
    if (this.isNpc && !this.isMoving()) {
      this.updateNpcPhase(delta, pathfinder, typedLocations, reservation, excludeNames);
    }

    if (this.isMoving()) {
      this.updateMovement(delta);
    } else if (this.state === 'idle') {
      this.updateIdleBehavior(delta, pathfinder, locations, typedLocations, reservation, excludeNames);
    } else {
      const anim = STATE_ANIMATION_MAP[this.state] ?? 'idle_down';
      if (this.animator.getCurrentAnimation() !== anim) {
        this.animator.play(anim);
      }
    }

    this.animator.update(delta);
  }

  /** NPC phase cycling: idle/wander → working → idle/wander → resting → repeat */
  private updateNpcPhase(
    delta: number,
    pathfinder: Pathfinder,
    typedLocations?: TypedLocation[],
    reservation?: TileReservation,
    excludeNames?: Set<string>,
  ) {
    this.npcPhaseTimer += delta;
    if (this.npcPhaseTimer < this.npcPhaseDuration) return;
    this.npcPhaseTimer = 0;

    const prevPhase = this.npcPhase;

    // Cycle: idle → working → idle → resting → idle → ...
    if (this.npcPhase === 'idle') {
      this.npcPhase = Math.random() < 0.6 ? 'working' : 'resting';
      this.npcPhaseDuration = 10 + Math.random() * 20; // work/rest for 10-30s
    } else {
      this.npcPhase = 'idle';
      this.npcPhaseDuration = 5 + Math.random() * 10; // wander for 5-15s
    }

    // Apply state change
    const newState: AgentState = this.npcPhase === 'working' ? 'working'
      : this.npcPhase === 'resting' ? 'sleeping'
      : 'idle';

    if (newState !== this.state) {
      // Navigate to appropriate anchor
      let reached = false;
      if (typedLocations && typedLocations.length > 0) {
        if (newState === 'working') {
          const home = this.getHomePosition();
          reached = this.goToAnchor(home, typedLocations, pathfinder, reservation)
            || this.goToAnchorType('work', typedLocations, pathfinder, reservation, excludeNames);
        } else if (newState === 'sleeping') {
          reached = this.goToAnchorType('rest', typedLocations, pathfinder, reservation, excludeNames);
        }
      }

      // Only change state if we can actually get there (or it's idle)
      if (newState === 'idle' || reached) {
        this.updateState(newState, null, this.energy);
        // When going idle, immediately start wandering so we don't stand behind our chair
        if (newState === 'idle') {
          this.idleBehaviorTimer = this.idleBehaviorInterval;
        }
      } else {
        // Can't reach destination — stay idle and try again next cycle
        this.npcPhase = 'idle';
        this.npcPhaseDuration = 3 + Math.random() * 5;
      }
    }
  }

  private updateMovement(delta: number) {
    if (this.pathIndex >= this.path.length) return;

    const target = this.path[this.pathIndex];
    const targetX = target.x * this.tileWidth;
    const targetY = target.y * this.tileHeight;

    const dx = targetX - this.x;
    const dy = targetY - this.y;

    // Set walk animation based on direction
    if (Math.abs(dx) > Math.abs(dy)) {
      this.animator.play(dx > 0 ? 'walk_right' : 'walk_left');
    } else {
      this.animator.play(dy > 0 ? 'walk_down' : 'walk_up');
    }

    this.moveProgress += delta * this.moveSpeed;

    if (this.moveProgress >= 1) {
      this.x = targetX;
      this.y = targetY;
      this.moveProgress = 0;
      this.pathIndex++;

      if (this.pathIndex >= this.path.length) {
        this.path = [];
        this.pathIndex = 0;
        const anim = STATE_ANIMATION_MAP[this.state] ?? 'idle_down';
        this.animator.play(anim);
      }
    } else {
      const prevTarget = this.path[this.pathIndex - 1];
      const prevX = prevTarget.x * this.tileWidth;
      const prevY = prevTarget.y * this.tileHeight;
      this.x = prevX + (targetX - prevX) * this.moveProgress;
      this.y = prevY + (targetY - prevY) * this.moveProgress;
    }
  }

  /** Navigate to a specific anchor by name */
  goToAnchor(
    anchorName: string,
    typedLocations: TypedLocation[],
    pathfinder: Pathfinder,
    reservation?: TileReservation,
  ): boolean {
    const loc = typedLocations.find(l => l.name === anchorName);
    if (!loc) return false;
    if (reservation && !reservation.isAvailable(loc.x, loc.y, this.agentId)) return false;

    const tile = this.getTilePosition();

    // Already at the target — claim it and stay
    if (tile.x === loc.x && tile.y === loc.y) {
      if (reservation) {
        reservation.release(this.agentId);
        reservation.reserve(loc.x, loc.y, this.agentId);
      }
      this.currentAnchor = loc.name;
      return true;
    }

    const path = pathfinder.findPath(tile.x, tile.y, loc.x, loc.y);
    if (path.length > 1) {
      if (reservation) {
        reservation.release(this.agentId);
        reservation.reserve(loc.x, loc.y, this.agentId);
      }
      this.currentAnchor = loc.name;
      this.walkTo(path);
      return true;
    }
    return false;
  }

  /** Navigate to a specific anchor by type, respecting reservation */
  goToAnchorType(
    type: AnchorType,
    typedLocations: TypedLocation[],
    pathfinder: Pathfinder,
    reservation?: TileReservation,
    excludeNames?: Set<string>,
  ): boolean {
    const candidates = typedLocations.filter(l =>
      l.type === type && (!excludeNames || !excludeNames.has(l.name))
    );
    if (candidates.length === 0) return false;

    // Shuffle to avoid always picking the same one
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const tile = this.getTilePosition();

    for (const loc of shuffled) {
      if (reservation && !reservation.isAvailable(loc.x, loc.y, this.agentId)) continue;

      // Already at this anchor — claim it and stay
      if (tile.x === loc.x && tile.y === loc.y) {
        if (reservation) {
          reservation.release(this.agentId);
          reservation.reserve(loc.x, loc.y, this.agentId);
        }
        this.currentAnchor = loc.name;
        return true;
      }

      const path = pathfinder.findPath(tile.x, tile.y, loc.x, loc.y);
      if (path.length > 1) {
        if (reservation) {
          reservation.release(this.agentId);
          reservation.reserve(loc.x, loc.y, this.agentId);
        }
        this.currentAnchor = loc.name;
        this.walkTo(path);
        return true;
      }
    }
    return false;
  }

  getCurrentAnchor(): string | null {
    return this.currentAnchor;
  }

  private updateIdleBehavior(
    delta: number,
    pathfinder: Pathfinder,
    locations: Record<string, { x: number; y: number }>,
    typedLocations?: TypedLocation[],
    reservation?: TileReservation,
    excludeNames?: Set<string>,
  ) {
    this.idleBehaviorTimer += delta;
    if (this.idleBehaviorTimer < this.idleBehaviorInterval) return;

    this.idleBehaviorTimer = 0;
    this.idleBehaviorInterval = 5 + Math.random() * 8;

    // Prefer typed locations with smart selection
    if (typedLocations && typedLocations.length > 0) {
      // When idle, prefer wander/social/utility spots (never other people's home anchors)
      const preferredTypes: AnchorType[] = ['wander', 'social', 'utility'];
      // Only consider types that actually have candidates
      const available = preferredTypes.filter(t =>
        typedLocations.some(l => l.type === t && (!excludeNames || !excludeNames.has(l.name)))
      );
      // Shuffle and try each available type until one succeeds
      const shuffled = available.sort(() => Math.random() - 0.5);
      for (const type of shuffled) {
        if (this.goToAnchorType(type, typedLocations, pathfinder, reservation, excludeNames)) return;
      }
    }

    // Fallback to plain locations — respect reservations
    const locationNames = Object.keys(locations).sort(() => Math.random() - 0.5);
    const tile = this.getTilePosition();

    for (const target of locationNames) {
      const loc = locations[target];
      if (reservation && !reservation.isAvailable(loc.x, loc.y, this.agentId)) continue;
      const path = pathfinder.findPath(tile.x, tile.y, loc.x, loc.y);
      if (path.length > 1) {
        if (reservation) {
          reservation.release(this.agentId);
          reservation.reserve(loc.x, loc.y, this.agentId);
        }
        this.walkTo(path);
        return;
      }
    }

    // Last resort: walk to a random walkable tile
    this.walkToRandomTile(pathfinder, reservation);
  }

  /** Pick a random walkable tile and walk there */
  walkToRandomTile(pathfinder: Pathfinder, reservation?: TileReservation) {
    const tile = this.getTilePosition();
    const walkable = pathfinder.getWalkableTiles();
    if (walkable.length === 0) return;

    // Shuffle and try a few random tiles (don't iterate all)
    const attempts = Math.min(10, walkable.length);
    for (let i = 0; i < attempts; i++) {
      const idx = Math.floor(Math.random() * walkable.length);
      const target = walkable[idx];
      // Skip tiles too close (at least 2 tiles away)
      if (Math.abs(target.x - tile.x) + Math.abs(target.y - tile.y) < 2) continue;
      if (reservation && !reservation.isAvailable(target.x, target.y, this.agentId)) continue;
      const path = pathfinder.findPath(tile.x, tile.y, target.x, target.y);
      if (path.length > 1) {
        if (reservation) {
          reservation.release(this.agentId);
          reservation.reserve(target.x, target.y, this.agentId);
        }
        this.walkTo(path);
        return;
      }
    }
  }

  /** Y offset applied when the character is sitting (working/sleeping) */
  getSittingOffset(): number {
    return (this.state === 'working' || this.state === 'sleeping')
      ? this.tileHeight * 1.2
      : 0;
  }

  /** Whether this citizen is anchored (sitting) and should not be pushed by separation */
  isAnchored(): boolean {
    return this.state === 'working' || this.state === 'sleeping';
  }

  /**
   * Apply separation steering: push away from nearby citizens.
   * Call once per frame from the update loop, passing all other citizens.
   */
  applySeparation(others: Citizen[], delta: number) {
    // Don't apply separation to sitting/working citizens
    if (this.isAnchored() || !this.visible) return;

    const minDist = this.tileWidth * 1.5; // separation radius in pixels
    let pushX = 0;
    let pushY = 0;

    for (const other of others) {
      if (other === this || !other.visible) continue;

      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < minDist && dist > 0.01) {
        // Stronger push the closer they are
        const strength = (minDist - dist) / minDist;
        pushX += (dx / dist) * strength;
        pushY += (dy / dist) * strength;
      } else if (dist <= 0.01) {
        // Exactly overlapping — push in a random direction
        const angle = Math.random() * Math.PI * 2;
        pushX += Math.cos(angle) * 0.5;
        pushY += Math.sin(angle) * 0.5;
      }
    }

    // Smooth the separation offset (lerp towards target)
    const speed = 60 * delta; // pixels/sec responsiveness
    this.separationX += pushX * speed;
    this.separationY += pushY * speed;

    // Decay the offset over time so it doesn't accumulate forever
    const decay = 0.9;
    this.separationX *= decay;
    this.separationY *= decay;

    // Clamp to max offset (half a tile)
    const maxOffset = this.tileWidth * 0.5;
    this.separationX = Math.max(-maxOffset, Math.min(maxOffset, this.separationX));
    this.separationY = Math.max(-maxOffset, Math.min(maxOffset, this.separationY));
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.visible) return;

    // Apply separation offset only for non-anchored citizens
    const sepX = this.isAnchored() ? 0 : this.separationX;
    const sepY = this.isAnchored() ? 0 : this.separationY;
    const drawX = this.x + (this.tileWidth - this.frameWidth) / 2 + sepX;
    const drawY = this.y + (this.tileHeight - this.frameHeight) - this.getSittingOffset() + sepY;
    this.animator.draw(ctx, drawX, drawY);
  }

  containsPoint(px: number, py: number): boolean {
    const sepX = this.isAnchored() ? 0 : this.separationX;
    const sepY = this.isAnchored() ? 0 : this.separationY;
    const drawX = this.x + (this.tileWidth - this.frameWidth) / 2 + sepX;
    const drawY = this.y + (this.tileHeight - this.frameHeight) + sepY;
    return (
      px >= drawX &&
      px <= drawX + this.frameWidth &&
      py >= drawY &&
      py <= drawY + this.frameHeight
    );
  }
}

/** Renders citizens that are working/sleeping — drawn BELOW the 'above' props layer (behind chair backs) */
export class CitizenLayerBelow implements RenderLayer {
  readonly order = 12;
  private citizens: Citizen[] = [];

  setCitizens(citizens: Citizen[]) { this.citizens = citizens; }

  render(ctx: CanvasRenderingContext2D, _delta: number) {
    const sitting = this.citizens
      .filter(r => r.visible && (r.state === 'working' || r.state === 'sleeping'))
      .sort((a, b) => a.y - b.y);
    for (const citizen of sitting) {
      citizen.draw(ctx);
    }
  }
}

/** Renders citizens that are idle/moving — drawn ABOVE the 'above' props layer */
export class CitizenLayerAbove implements RenderLayer {
  readonly order = 20;
  private citizens: Citizen[] = [];

  setCitizens(citizens: Citizen[]) { this.citizens = citizens; }

  render(ctx: CanvasRenderingContext2D, _delta: number) {
    const active = this.citizens
      .filter(r => r.visible && r.state !== 'working' && r.state !== 'sleeping')
      .sort((a, b) => a.y - b.y);
    for (const citizen of active) {
      citizen.draw(ctx);
    }
  }
}

/** Combined layer — legacy compat */
export class CitizenLayer implements RenderLayer {
  readonly order = 10;
  private below: CitizenLayerBelow;
  private above: CitizenLayerAbove;

  constructor() {
    this.below = new CitizenLayerBelow();
    this.above = new CitizenLayerAbove();
  }

  setCitizens(citizens: Citizen[]) {
    this.below.setCitizens(citizens);
    this.above.setCitizens(citizens);
  }

  getLayers(): RenderLayer[] {
    return [this.below, this.above];
  }

  render(_ctx: CanvasRenderingContext2D, _delta: number) {
    // Not used directly — use getLayers() instead
  }
}
