import { Camera } from './Camera';

export interface RenderLayer {
  order: number;
  render(ctx: CanvasRenderingContext2D, delta: number): void;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: Camera;

  private layers: RenderLayer[] = [];
  private animationId: number | null = null;
  private lastTime = 0;
  private scale: number;

  constructor(container: HTMLElement, width: number, height: number, scale: number) {
    this.scale = scale;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.width = `${width * scale}px`;
    this.canvas.style.height = `${height * scale}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.camera = new Camera();
    container.appendChild(this.canvas);
  }

  addLayer(layer: RenderLayer) {
    this.layers.push(layer);
    this.layers.sort((a, b) => a.order - b.order);
  }

  removeLayer(layer: RenderLayer) {
    this.layers = this.layers.filter(l => l !== layer);
  }

  start() {
    this.lastTime = performance.now();
    const loop = (time: number) => {
      const delta = (time - this.lastTime) / 1000;
      this.lastTime = time;
      this.render(delta);
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private render(delta: number) {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this.camera.update();
    this.camera.apply(ctx);

    for (const layer of this.layers) {
      ctx.save();
      layer.render(ctx, delta);
      ctx.restore();
    }
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width * this.scale}px`;
    this.canvas.style.height = `${height * this.scale}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  getScale(): number {
    return this.scale;
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const canvasX = (screenX - rect.left) / this.scale;
    const canvasY = (screenY - rect.top) / this.scale;
    return this.camera.screenToWorld(canvasX, canvasY);
  }
}
