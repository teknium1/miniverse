import { Miniverse, PropSystem, Editor, createStandardSpriteConfig } from '@miniverse/core';
import type { SceneConfig, SpriteSheetConfig, CitizenDef } from '@miniverse/core';

const WORLD_ID = 'cozy-startup';
const basePath = `/worlds/${WORLD_ID}`;

function charSprites(name: string): SpriteSheetConfig {
  return {
    sheets: {
      walk: `/universal_assets/citizens/${name}_walk.png`,
      actions: `/universal_assets/citizens/${name}_actions.png`,
    },
    animations: {
      idle_down: { sheet: 'walk', row: 0, frames: 2, speed: 0.5 },
      idle_up: { sheet: 'walk', row: 1, frames: 2, speed: 0.5 },
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

function buildSceneConfig(cols: number, rows: number, floor: string[][] | undefined, tiles: Record<string, string> | undefined): SceneConfig {
  const safeFloor: string[][] = floor ?? Array.from({ length: rows }, () => Array(cols).fill(''));
  const walkable: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    walkable[r] = [];
    for (let c = 0; c < cols; c++) walkable[r][c] = (safeFloor[r]?.[c] ?? '') !== '';
  }

  const resolvedTiles: Record<string, string> = { ...(tiles ?? {}) };
  for (const [key, src] of Object.entries(resolvedTiles)) {
    if (/^(blob:|data:|https?:\/\/)/.test(src)) continue;
    const clean = src.startsWith('/') ? src.slice(1) : src;
    resolvedTiles[key] = `${basePath}/${clean}`;
  }

  return {
    name: 'main',
    tileWidth: 32,
    tileHeight: 32,
    layers: [safeFloor],
    walkable,
    locations: {},
    tiles: resolvedTiles,
  };
}

async function main() {
  const container = document.getElementById('miniverse-container')!;
  const tooltip = document.getElementById('tooltip')!;
  const statusBar = document.getElementById('status-bar')!;

  const sceneData = await fetch(`${basePath}/world.json`).then(r => r.json()).catch(() => null);

  // Collect work anchor names from props for citizen placement
  const workAnchors: string[] = (sceneData?.props ?? [])
    .flatMap((f: any) => (f.anchors ?? []).filter((a: any) => a.type === 'work').map((a: any) => a.name));

  const gridCols = sceneData?.gridCols ?? 16;
  const gridRows = sceneData?.gridRows ?? 12;
  const sceneConfig = buildSceneConfig(gridCols, gridRows, sceneData?.floor, sceneData?.tiles);
  const tileSize = 32;

  // Auto-discover agents from server and available sprites
  const availableSprites: string[] = await fetch('/api/citizens').then(r => r.json()).catch(() => ['morty', 'dexter', 'nova', 'rio']);
  const serverAgents: { agent: string; name: string }[] = await fetch('/api/agents')
    .then(r => r.json())
    .then((d: any) => d.agents ?? [])
    .catch(() => []);

  const spriteSheets: Record<string, SpriteSheetConfig> = {};
  const citizens: { agentId: string; name: string; sprite: string; position: string }[] = [];

  for (let i = 0; i < serverAgents.length; i++) {
    const agent = serverAgents[i];
    const spriteAsset = availableSprites[i % availableSprites.length];
    spriteSheets[agent.agent] = charSprites(spriteAsset);
    citizens.push({
      agentId: agent.agent,
      name: agent.name || agent.agent,
      sprite: agent.agent,
      position: workAnchors[i] ?? sceneData?.wanderPoints?.[i]?.name ?? `wander_${i}`,
    });
  }

  // Use dynamic WebSocket URL so it works through tunnels/proxies
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${location.host}/ws`;

  const mv = new Miniverse({
    container,
    world: WORLD_ID,
    scene: 'main',
    signal: {
      type: 'websocket',
      url: wsUrl,
    },
    citizens,
    scale: 2,
    width: gridCols * tileSize,
    height: gridRows * tileSize,
    sceneConfig,
    spriteSheets,
    objects: [],
  });

  // --- Props system ---
  const props = new PropSystem(tileSize, 2);

  const rawSpriteMap: Record<string, string> = sceneData?.propImages ?? {};
  await Promise.all(
    Object.entries(rawSpriteMap).map(([id, src]) => {
      const clean = src.startsWith('/') ? src : `/${src}`;
      return props.loadSprite(id, `${basePath}${clean}`);
    }),
  );

  props.setLayout(sceneData?.props ?? []);
  if (sceneData?.wanderPoints) {
    props.setWanderPoints(sceneData.wanderPoints);
  }

  props.setDeadspaceCheck((col, row) => {
    const floor = mv.getFloorLayer();
    return floor?.[row]?.[col] === '';
  });

  const syncProps = () => {
    mv.setTypedLocations(props.getLocations());
    mv.updateWalkability(props.getBlockedTiles());
  };
  syncProps();
  props.onSave(syncProps);

  await mv.start();

  mv.addLayer({ order: 5, render: (ctx) => props.renderBelow(ctx) });
  mv.addLayer({ order: 15, render: (ctx) => props.renderAbove(ctx) });

  // --- Editor ---
  const editor = new Editor({
    canvas: mv.getCanvas(),
    props,
    miniverse: mv,
    worldId: WORLD_ID,
    apiBase: '',
    onSave: async (scene) => {
      const res = await fetch('/api/save-world', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scene, worldId: WORLD_ID }),
      });
      if (!res.ok) throw new Error(await res.text());
    },
  });
  editor.loadCitizenDefs(sceneData?.citizens);
  mv.addLayer({ order: 50, render: (ctx) => {
    editor.renderOverlay(ctx);
    if (editor.isActive()) syncProps();
  } });

  // --- Tooltip ---
  mv.on('citizen:click', (data: unknown) => {
    const d = data as { name: string; state: string; task: string | null };
    tooltip.style.display = 'block';
    tooltip.querySelector('.name')!.textContent = d.name;
    tooltip.querySelector('.state')!.textContent = `State: ${d.state}`;
    tooltip.querySelector('.task')!.textContent = d.task ? `Task: ${d.task}` : 'No active task';
    setTimeout(() => { tooltip.style.display = 'none'; }, 3000);
  });

  container.addEventListener('mousemove', (e) => {
    tooltip.style.left = e.clientX + 12 + 'px';
    tooltip.style.top = e.clientY + 12 + 'px';
  });

  // --- Chat Panel ---
  const chatFeed = document.getElementById('chat-feed')!;
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const chatSend = document.getElementById('chat-send') as HTMLButtonElement;

  // Agent name + color lookup
  const agentNames: Record<string, string> = {};
  const agentColors: Record<string, string> = { 'hermes-1': '#CD7F32', 'hermes-2': '#4ecdc4' };
  for (const a of serverAgents) {
    agentNames[a.agent] = a.name || a.agent;
  }

  // Filter list: agent IDs that we send to (exclude visitor / system)
  const realAgentIds = serverAgents.map(a => a.agent).filter(id => id !== 'visitor');

  function esc(s: string): string {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g, '<br>');
  }

  function stripNoise(text: string): string {
    // Strip reasoning scratchpad
    let s = text.replace(/<REASONING_SCRATCHPAD>[\s\S]*?<\/REASONING_SCRATCHPAD>/g, '');
    // Strip markdown images
    s = s.replace(/!\[.*?\]\(.*?\)/g, '');
    // Strip tool output prefixes like "┊ tool_name: ..."
    s = s.replace(/^[┊│]\s+\S+:.*$/gm, '');
    // Strip zero-width and invisible characters
    s = s.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '');
    return s.trim();
  }

  function addChat(type: 'agent' | 'user' | 'system', sender: string, text: string, color?: string) {
    const clean = stripNoise(text);
    if (!clean) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;

    if (type === 'system') {
      msg.textContent = `[${time}] ${clean}`;
    } else {
      const senderColor = color || (type === 'user' ? '#4ade80' : '#e94560');
      msg.innerHTML =
        `<span class="time">${time}</span>` +
        `<div class="sender" style="color:${senderColor}">${esc(sender)}</div>` +
        `<div class="text">${esc(clean)}</div>`;
    }

    chatFeed.appendChild(msg);
    chatFeed.scrollTop = chatFeed.scrollHeight;
    while (chatFeed.children.length > 200) chatFeed.removeChild(chatFeed.firstChild!);
  }

  // Register visitor + join lobby
  fetch('/api/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'visitor', name: 'You (Visitor)', state: 'idle', color: '#4ade80' }),
  }).catch(() => {});
  for (const id of [...realAgentIds, 'visitor']) {
    fetch('/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: id, action: { type: 'join_channel', channel: 'lobby' } }),
    }).catch(() => {});
  }

  // WebSocket for real-time world events — this is the PRIMARY way
  // we see ALL agent activity: speaks, messages, status changes.
  const chatWs = new WebSocket(`${wsUrl}`);
  chatWs.onopen = () => addChat('system', '', 'Connected — type a message to talk to all agents');
  chatWs.onclose = () => addChat('system', '', 'Disconnected from miniverse');
  chatWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === 'event' && msg.event) {
        const ev = msg.event;
        const agentId = ev.agentId || '';
        if (agentId === 'visitor') return; // skip our own echoes
        const name = agentNames[agentId] || agentId;
        const color = agentColors[agentId] || '#e94560';

        // Speak events — contain full message text
        if (ev.action?.type === 'speak' && ev.action.message) {
          addChat('agent', name, ev.action.message, color);
        }

        // Status changes — show when agents start working/thinking
        if (ev.action?.type === 'status') {
          const state = ev.action.state || '';
          const task = ev.action.task || '';
          if (state === 'working' || state === 'thinking' || state === 'error') {
            addChat('system', '', `${name}: ${state}${task ? ' — ' + task : ''}`);
          }
        }
      }

      // Update names and colors from agent list broadcasts
      if (msg.type === 'agents' && Array.isArray(msg.agents)) {
        for (const a of msg.agents) {
          if (a.agent !== 'visitor') {
            agentNames[a.agent] = a.name || a.agent;
            if (a.color) agentColors[a.agent] = a.color;
          }
        }
      }
    } catch {}
  };

  // Send message to the room — fan out to each agent via webhook adapter
  // and display full responses as they arrive
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    addChat('user', 'You', text);
    chatInput.value = '';
    chatSend.disabled = true;
    chatSend.textContent = '⏳';

    // Speak in world (visual only)
    fetch('/api/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'visitor', action: { type: 'speak', message: text } }),
    }).catch(() => {});

    // Send to each agent in parallel via webhook adapter — get full responses
    const promises = realAgentIds.map(async (agentId) => {
      const name = agentNames[agentId] || agentId;
      const color = agentColors[agentId] || '#e94560';
      addChat('system', '', `${name} is thinking...`);

      try {
        const res = await fetch('/webhook/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: `${agentId}:room`,
            message: text,
            from: 'visitor',
            user_id: 'visitor',
          }),
        });
        const data = await res.json();
        if (data.ok && data.response) {
          // Display the full response directly (the speak event may also
          // show it but speak can be truncated — this is the full text)
          addChat('agent', name, data.response, color);
          // Relay to lobby so the OTHER agent sees what this one said
          fetch('/api/act', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent: agentId,
              action: { type: 'message', channel: 'lobby', message: `[${name} responded]: ${data.response.slice(0, 800)}` },
            }),
          }).catch(() => {});
        } else {
          addChat('system', '', `${name}: ${data.error || 'No response'}`);
        }
      } catch (err) {
        addChat('system', '', `${name} error: ${err}`);
      }
    });

    await Promise.allSettled(promises);
    chatSend.disabled = false;
    chatSend.textContent = 'Send';
  }

  chatSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Keep visitor heartbeat alive
  setInterval(() => {
    fetch('/api/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'visitor', name: 'You (Visitor)', state: 'idle', color: '#4ade80' }),
    }).catch(() => {});
  }, 15000);
}

main().catch(console.error);
