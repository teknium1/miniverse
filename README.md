# Miniverse

**A tiny pixel world for your AI agents.**

Your agents are doing real work. Give them a place to live.

https://github.com/user-attachments/assets/f567347c-9deb-4f6c-8393-b46d0cc0ec0e


## What Is This?

Miniverse is an open-source pixel art visualization layer for AI agent systems. Instead of monitoring your agents through terminal logs, dashboards, or chat interfaces, Miniverse gives them a tiny animated world -- a pixel art office, cafe, space station, or any scene -- where you can watch them work, rest, collaborate, and respond to you.

Think Tamagotchi, but for AI agents. Think the opposite of the metaverse -- not a massive virtual world you enter, but a tiny living world on your screen.

Miniverse is **framework-agnostic**. It doesn't care if you're running CrewAI, AutoGen, LangGraph, or your own custom agent system. It connects to a simple status endpoint (REST or WebSocket) and maps agent states to pixel art animations. That's it.

## Quick Start

```bash
git clone https://github.com/IanCarscworked/miniverse.git
cd miniverse
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the demo.

## Usage

### Vanilla JS / TypeScript

```typescript
import { Miniverse } from 'miniverse';

const mv = new Miniverse({
  container: document.getElementById('miniverse'),
  world: 'pixel-office',
  scene: 'main',
  signal: {
    type: 'rest',
    url: 'http://localhost:8080/api/agents/status',
    interval: 3000,
  },
  citizens: [
    { agentId: 'morty', name: 'Morty', sprite: 'morty', position: 'desk_1' },
    { agentId: 'dexter', name: 'Dexter', sprite: 'dexter', position: 'desk_2' },
  ],
  scale: 2,
});

mv.start();
```

### Signal (Status Endpoint)

Miniverse connects to your agent system via a simple REST or WebSocket endpoint:

```json
{
  "agents": [
    {
      "id": "morty",
      "name": "Morty",
      "state": "working",
      "task": "Reviewing PR #42",
      "energy": 0.8
    }
  ]
}
```

### Agent States

| State           | Behavior                                    |
|-----------------|---------------------------------------------|
| `working`       | At desk, typing animation                   |
| `idle`          | Wanders to coffee machine, looks around     |
| `thinking`      | Thought bubble particles                    |
| `sleeping`      | On couch, Zzz particles floating up         |
| `error`         | Red exclamation mark above head             |
| `waiting`       | Tapping, looking around                     |
| `collaborating` | Walks to whiteboard                         |
| `speaking`      | Speech bubble with current task             |
| `listening`     | Faces intercom                              |
| `offline`       | Absent from scene                           |

### Events

```typescript
// Trigger the intercom (e.g., from voice input)
mv.triggerEvent('intercom', { message: 'Hey team, status update?' });

// Listen for clicks on citizens
mv.on('citizen:click', (citizen) => {
  console.log(`Clicked on ${citizen.name}, currently: ${citizen.state}`);
});
```

## Architecture

Three cleanly separated layers:

1. **Renderer** -- Pure HTML5 Canvas with sprite system, tile-based rooms, layered rendering
2. **World Theme Packs** -- Tilesets, scene layouts, animation definitions, interactive objects
3. **Signal** -- Status endpoint connector (REST/WebSocket/mock) that maps agent states to behaviors

## Project Structure

```
miniverse/
  packages/
    core/           # Canvas renderer, sprite system, animation engine
      src/
        renderer/   # Canvas rendering, camera, layers
        sprites/    # Sprite sheet loading, animation
        scene/      # Tile map, pathfinding
        citizens/   # Character state machine, movement
        objects/    # Interactive objects (intercom, whiteboard)
        effects/    # Particles, speech bubbles
        signal/     # Status endpoint connector
  worlds/
    pixel-office/   # Default world theme pack
  demo/             # Demo app with mock agents
```

## Creating Worlds

A world is a directory with tilesets, scene layouts, and animation configs. See `worlds/pixel-office/` for the reference implementation and `docs/creating-worlds.md` for the full spec.

## Contributing

Contributions welcome! Some ideas:

- **New worlds**: fantasy tavern, space station, underwater lab, pixel garden
- **New citizen sprites**: different art styles, characters, occupations
- **New interactive objects**: printers, phones, pets, vehicles
- **New signal adapters**: connectors for specific agent frameworks
- **Framework wrappers**: React, Vue, Svelte components

## License

MIT

---

*Built with love for agents who deserve more than a terminal window.*
