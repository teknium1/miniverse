import { Miniverse } from 'miniverse';
import type { AgentState, AgentStatus, SceneConfig, SpriteSheetConfig } from 'miniverse';
import { FurnitureSystem } from './furniture';
import { Editor } from './editor';

const STATES: AgentState[] = ['working', 'idle', 'thinking', 'sleeping', 'speaking', 'error', 'waiting'];
const TASKS = [
  'Reviewing PR #42',
  'Fixing auth bug',
  'Writing tests',
  'Code review',
  'Deploying v2.1',
  'Refactoring API',
  'Updating docs',
  null,
];

const agentStates: Record<string, { state: AgentState; task: string | null; energy: number }> = {
  morty: { state: 'working', task: 'Reviewing PR #42', energy: 0.8 },
  dexter: { state: 'idle', task: null, energy: 0.5 },
  nova: { state: 'thinking', task: 'Designing UI mockups', energy: 0.9 },
  rio: { state: 'working', task: 'Writing tests', energy: 0.7 },
};

function mockAgentData(): AgentStatus[] {
  return Object.entries(agentStates).map(([id, data]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    state: data.state,
    task: data.task,
    energy: data.energy,
  }));
}

// Build the scene config
function buildSceneConfig(cols = 16, rows = 12, savedFloor?: number[][]): SceneConfig {

  const floor: number[][] = [];
  const walkable: boolean[][] = [];

  for (let r = 0; r < rows; r++) {
    floor[r] = [];
    walkable[r] = [];
    for (let c = 0; c < cols; c++) {
      // Use saved floor data if available, otherwise default walls on edges
      if (savedFloor && savedFloor[r] && savedFloor[r][c] !== undefined) {
        floor[r][c] = savedFloor[r][c];
      } else if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        floor[r][c] = 1;
      } else {
        floor[r][c] = 0;
      }
      walkable[r][c] = floor[r][c] >= 0 && !(r === 0 || r === rows - 1 || c === 0 || c === cols - 1);
    }
  }

  // Furniture blocked tiles are applied dynamically via updateWalkability()

  return {
    name: 'main',
    tileWidth: 32,
    tileHeight: 32,
    layers: [floor],
    walkable,
    locations: {
      desk_1: { x: 3, y: 3, label: 'Desk 1' },
      desk_2: { x: 8, y: 3, label: 'Desk 2' },
      coffee_machine: { x: 13, y: 2, label: 'Coffee' },
      couch: { x: 12, y: 7, label: 'Couch' },
      whiteboard: { x: 8, y: 1, label: 'Board' },
      intercom: { x: 1, y: 1, label: 'Intercom' },
      center: { x: 7, y: 6, label: 'Center' },
      lounge: { x: 5, y: 8, label: 'Lounge' },
    },
    tilesets: [{
      image: '/tilesets/office.png',
      tileWidth: 32,
      tileHeight: 32,
      columns: 16,
    }],
  };
}

async function main() {
  const container = document.getElementById('miniverse-container')!;
  const tooltip = document.getElementById('tooltip')!;
  const statusBar = document.getElementById('status-bar')!;

  // Build sprite config for each character: walk sheet + action sheet
  function charSprites(name: string): SpriteSheetConfig {
    return {
      sheets: {
        walk: `/sprites/${name}_walk.png`,
        actions: `/sprites/${name}_actions.png`,
      },
      animations: {
        // Walk sheet (rows: down, up, left, right)
        idle_down: { sheet: 'walk', row: 0, frames: 2, speed: 0.5 },
        idle_up: { sheet: 'walk', row: 1, frames: 2, speed: 0.5 },
        walk_down: { sheet: 'walk', row: 0, frames: 4, speed: 0.15 },
        walk_up: { sheet: 'walk', row: 1, frames: 4, speed: 0.15 },
        walk_left: { sheet: 'walk', row: 2, frames: 4, speed: 0.15 },
        walk_right: { sheet: 'walk', row: 3, frames: 4, speed: 0.15 },
        // Action sheet (rows: working, sleeping, talking, idle)
        working: { sheet: 'actions', row: 0, frames: 4, speed: 0.3 },
        sleeping: { sheet: 'actions', row: 1, frames: 2, speed: 0.8 },
        talking: { sheet: 'actions', row: 2, frames: 4, speed: 0.15 },
      },
      frameWidth: 64,
      frameHeight: 64,
    };
  }

  const spriteSheets: Record<string, SpriteSheetConfig> = {
    morty: charSprites('morty'),
    dexter: charSprites('dexter'),
    nova: charSprites('nova'),
    rio: charSprites('rio'),
  };

  // Load scene data (furniture + characters + wander points + grid size)
  const sceneData = await fetch('/scene.json').then(r => r.json()).catch(() => null);

  const gridCols = sceneData?.gridCols ?? 16;
  const gridRows = sceneData?.gridRows ?? 12;
  const sceneConfig = buildSceneConfig(gridCols, gridRows, sceneData?.floor);

  const tileSize = 32;

  const mv = new Miniverse({
    container,
    world: 'pixel-office',
    scene: 'main',
    signal: {
      type: 'mock',
      mockData: mockAgentData,
      interval: 2000,
    },
    residents: [
      { agentId: 'morty', name: 'Morty', sprite: 'morty', position: sceneData?.characters?.morty ?? 'desk_0_0' },
      { agentId: 'dexter', name: 'Dexter', sprite: 'dexter', position: sceneData?.characters?.dexter ?? 'desk_1_0' },
      { agentId: 'nova', name: 'Nova', sprite: 'nova', position: sceneData?.characters?.nova ?? 'whiteboard_2_0' },
      { agentId: 'rio', name: 'Rio', sprite: 'rio', position: sceneData?.characters?.rio ?? 'couch_5_0' },
    ],
    scale: 2,
    width: gridCols * tileSize,
    height: gridRows * tileSize,
    sceneConfig,
    spriteSheets,
    objects: [],
  });

  // Click handler for tooltip
  mv.on('resident:click', (data: unknown) => {
    const d = data as { name: string; state: string; task: string | null; energy: number };
    tooltip.style.display = 'block';
    tooltip.querySelector('.name')!.textContent = d.name;
    tooltip.querySelector('.state')!.textContent = `State: ${d.state}`;
    tooltip.querySelector('.task')!.textContent = d.task ? `Task: ${d.task}` : 'No active task';

    // Position near mouse, hide after 3s
    setTimeout(() => { tooltip.style.display = 'none'; }, 3000);
  });

  container.addEventListener('mousemove', (e) => {
    tooltip.style.left = e.clientX + 12 + 'px';
    tooltip.style.top = e.clientY + 12 + 'px';
  });

  // Update status bar
  setInterval(() => {
    statusBar.innerHTML = Object.entries(agentStates)
      .map(([id, data]) => {
        const name = id.charAt(0).toUpperCase() + id.slice(1);
        return `<div class="agent"><span class="status-dot ${data.state}"></span>${name}: ${data.state}</div>`;
      })
      .join('');
  }, 500);

  // --- Furniture system (load before start so anchors exist for initial placement) ---
  const furniture = new FurnitureSystem(32, 2);

  await Promise.all([
    furniture.loadSprite('desk', '/sprites/piece_0.png'),
    furniture.loadSprite('chair', '/sprites/chair_back.png'),
    furniture.loadSprite('couch', '/sprites/piece_2.png'),
    furniture.loadSprite('coffee_machine', '/sprites/piece_3.png'),
    furniture.loadSprite('bookshelf', '/sprites/piece_4.png'),
    furniture.loadSprite('water_cooler', '/sprites/piece_5.png'),
    furniture.loadSprite('plant', '/sprites/piece_6.png'),
    furniture.loadSprite('whiteboard', '/sprites/piece_8.png'),
    furniture.loadSprite('lamp', '/sprites/piece_9.png'),
  ]);

  furniture.setLayout(sceneData?.furniture ?? []);
  if (sceneData?.wanderPoints) {
    furniture.setWanderPoints(sceneData.wanderPoints);
  }

  // Let furniture system check deadspace tiles
  furniture.setDeadspaceCheck((col, row) => {
    const floor = mv.getFloorLayer();
    return floor?.[row]?.[col] < 0;
  });

  // Set typed locations + walkability BEFORE start so residents can find their anchors
  const syncFurniture = () => {
    mv.setTypedLocations(furniture.getLocations());
    mv.updateWalkability(furniture.getBlockedTiles());
  };
  syncFurniture();
  furniture.onSave(syncFurniture);

  await mv.start();

  // Render layers
  mv.addLayer({ order: 5, render: (ctx) => furniture.renderBelow(ctx) });
  mv.addLayer({ order: 15, render: (ctx) => furniture.renderAbove(ctx) });

  // --- Editor (tabbed: furniture | characters | behavior) ---
  const editor = new Editor(mv.getCanvas(), furniture, mv);
  editor.loadCharacterAssignments(sceneData?.characters);
  mv.addLayer({ order: 50, render: (ctx) => {
    editor.renderOverlay(ctx);
    if (editor.isActive()) syncFurniture();
  } });

  // Expose controls to window
  (window as unknown as Record<string, unknown>).triggerIntercom = () => {
    mv.triggerEvent('intercom', { message: 'Hey team, status update?' });
  };

  (window as unknown as Record<string, unknown>).cycleState = (agentId: string) => {
    const agent = agentStates[agentId];
    if (!agent) return;
    const currentIdx = STATES.indexOf(agent.state);
    agent.state = STATES[(currentIdx + 1) % STATES.length];
    agent.task = TASKS[Math.floor(Math.random() * TASKS.length)];
    agent.energy = Math.random();
  };
}

main().catch(console.error);
