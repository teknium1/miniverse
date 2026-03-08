import { Pathfinder } from './Pathfinder';
import type { RenderLayer } from '../renderer/Renderer';

export interface TilesetConfig {
  image: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
}

export interface NamedLocation {
  x: number;
  y: number;
  label: string;
}

export interface SceneConfig {
  name: string;
  tileWidth: number;
  tileHeight: number;
  layers: number[][][];
  walkable: boolean[][];
  locations: Record<string, NamedLocation>;
  tilesets: TilesetConfig[];
}

export class Scene implements RenderLayer {
  readonly order = 0;
  readonly config: SceneConfig;
  readonly pathfinder: Pathfinder;
  private tileImages: HTMLImageElement[] = [];
  private loaded = false;

  constructor(config: SceneConfig) {
    this.config = config;
    this.pathfinder = new Pathfinder(config.walkable);
  }

  async load(basePath: string): Promise<void> {
    const promises = this.config.tilesets.map((ts) => {
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load tileset: ${ts.image}`));
        const isAbsolute = /^(\/|blob:|data:|https?:\/\/)/.test(ts.image);
        img.src = isAbsolute ? ts.image : `${basePath}/${ts.image}`;
      });
    });

    this.tileImages = await Promise.all(promises);
    this.loaded = true;
  }

  getLocation(name: string): NamedLocation | undefined {
    return this.config.locations[name];
  }

  render(ctx: CanvasRenderingContext2D, _delta: number) {
    if (!this.loaded) return;

    const { tileWidth, tileHeight, layers } = this.config;

    for (const layer of layers) {
      for (let row = 0; row < layer.length; row++) {
        for (let col = 0; col < layer[row].length; col++) {
          const tileId = layer[row][col];
          if (tileId < 0) {
            ctx.fillStyle = '#2a2a2e';
            ctx.fillRect(col * tileWidth, row * tileHeight, tileWidth, tileHeight);
            continue;
          }

          const tsIndex = 0;
          const ts = this.config.tilesets[tsIndex];
          const img = this.tileImages[tsIndex];
          if (!ts || !img) continue;

          const sx = (tileId % ts.columns) * ts.tileWidth;
          const sy = Math.floor(tileId / ts.columns) * ts.tileHeight;

          ctx.drawImage(
            img,
            sx, sy, ts.tileWidth, ts.tileHeight,
            col * tileWidth, row * tileHeight, tileWidth, tileHeight,
          );
        }
      }
    }
  }
}
