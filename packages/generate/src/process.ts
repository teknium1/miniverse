/**
 * Sprite sheet processing — clean up AI-generated images into
 * properly aligned sprite sheets and individual furniture pieces.
 *
 * Character sprites: 256x256 (4x4 grid of 64x64 frames)
 * Furniture: individual PNGs per piece
 */

import sharp from 'sharp';

const FRAME_SIZE = 64;
const GRID = 4;

/**
 * Process a raw character sprite sheet into a clean 256x256 grid.
 * 1. Remove background via flood fill from edges
 * 2. Trim to content bounds
 * 3. Divide into 4x4 grid
 * 4. Scale each frame to 64x64 (fill height, center width)
 * 5. Assemble into 256x256
 */
export async function processCharacterSheet(input: Buffer, options?: { scaleFromRows?: number[] }): Promise<Buffer> {
  const cleaned = await floodFillRemoveBg(input);
  const trimmed = await sharp(cleaned).trim().png().toBuffer();
  const meta = await sharp(trimmed).metadata();

  const cellW = Math.floor(meta.width! / GRID);
  const cellH = Math.floor(meta.height! / GRID);

  // First pass: extract and trim all cells to find median height
  const cells: { buffer: Buffer; width: number; height: number; col: number; row: number }[] = [];

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const left = col * cellW;
      const top = row * cellH;
      const extractW = Math.min(cellW, meta.width! - left);
      const extractH = Math.min(cellH, meta.height! - top);

      let cell = await sharp(trimmed)
        .extract({ left, top, width: extractW, height: extractH })
        .png()
        .toBuffer();

      try {
        cell = await sharp(cell).trim().png().toBuffer();
      } catch {
        // empty cell
      }

      const cellMeta = await sharp(cell).metadata();
      cells.push({
        buffer: cell,
        width: cellMeta.width ?? 0,
        height: cellMeta.height ?? 0,
        col, row,
      });
    }
  }

  // Compute uniform scale from specific rows (default: all) so sitting poses stay shorter
  const scaleRows = options?.scaleFromRows;
  const heightsForScale = cells
    .filter(c => c.height > 4 && (scaleRows ? scaleRows.includes(c.row) : true))
    .map(c => c.height)
    .sort((a, b) => a - b);
  const medianHeight = heightsForScale[Math.floor(heightsForScale.length / 2)] || FRAME_SIZE;
  const TARGET_HEIGHT = 54; // leave some padding in the 64px frame
  const uniformScale = TARGET_HEIGHT / medianHeight;

  // Second pass: scale all cells with the same factor
  const frames: { buffer: Buffer; col: number; row: number; offsetX: number; offsetY: number }[] = [];

  for (const cell of cells) {
    if (cell.height < 4) {
      frames.push({
        buffer: await sharp({
          create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).png().toBuffer(),
        col: cell.col, row: cell.row, offsetX: 0, offsetY: 0,
      });
      continue;
    }

    const scaledW = Math.max(1, Math.round(cell.width * uniformScale));
    const scaledH = Math.max(1, Math.round(cell.height * uniformScale));

    let resized = await sharp(cell.buffer)
      .resize(scaledW, scaledH, { kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();

    let offsetX = 0;
    const offsetY = Math.max(0, FRAME_SIZE - scaledH); // bottom-align within frame

    if (scaledW > FRAME_SIZE) {
      const cropLeft = Math.floor((scaledW - FRAME_SIZE) / 2);
      resized = await sharp(resized)
        .extract({ left: cropLeft, top: 0, width: FRAME_SIZE, height: Math.min(scaledH, FRAME_SIZE) })
        .png()
        .toBuffer();
    } else {
      offsetX = Math.floor((FRAME_SIZE - scaledW) / 2);
    }

    frames.push({ buffer: resized, col: cell.col, row: cell.row, offsetX, offsetY });
  }

  // Composite onto 256x256 sheet
  const composites = frames.map(f => ({
    input: f.buffer,
    left: f.col * FRAME_SIZE + f.offsetX,
    top: f.row * FRAME_SIZE + f.offsetY,
  }));

  return sharp({
    create: {
      width: GRID * FRAME_SIZE,
      height: GRID * FRAME_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * Extract individual furniture pieces from a raw image.
 * Uses flood fill bg removal + connected component detection.
 * Returns array of { buffer, width, height } for each piece.
 */
export async function processFurnitureSheet(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number }[]> {
  const cleaned = await floodFillRemoveBg(input);
  const { data, info } = await sharp(cleaned)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;
  const pixels = Buffer.from(data);

  // Find connected components
  const labels = new Int32Array(w * h).fill(-1);
  let nextLabel = 0;
  const components: { minX: number; minY: number; maxX: number; maxY: number }[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (pixels[idx * 4 + 3] === 0 || labels[idx] >= 0) continue;

      const label = nextLabel++;
      let minX = x, minY = y, maxX = x, maxY = y;
      const queue = [idx];
      labels[idx] = label;

      while (queue.length > 0) {
        const ci = queue.pop()!;
        const cx = ci % w, cy = Math.floor(ci / w);
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (pixels[ni * 4 + 3] > 0 && labels[ni] < 0) {
            labels[ni] = label;
            queue.push(ni);
          }
        }
      }

      components.push({ minX, minY, maxX, maxY });
    }
  }

  // Filter noise, sort by position
  const significant = components
    .filter(c => (c.maxX - c.minX) * (c.maxY - c.minY) > 500)
    .sort((a, b) => {
      const rowA = Math.floor(a.minY / 150);
      const rowB = Math.floor(b.minY / 150);
      if (rowA !== rowB) return rowA - rowB;
      return a.minX - b.minX;
    });

  // Extract each piece
  const pieces: { buffer: Buffer; width: number; height: number }[] = [];
  for (const c of significant) {
    const cw = c.maxX - c.minX + 1;
    const ch = c.maxY - c.minY + 1;
    const buffer = await sharp(cleaned)
      .extract({ left: c.minX, top: c.minY, width: cw, height: ch })
      .png()
      .toBuffer();
    pieces.push({ buffer, width: cw, height: ch });
  }

  return pieces;
}

/**
 * Process a raw texture into a clean 32x32 seamless tile.
 * 1. Crop to center square
 * 2. Resize to 32x32 with nearest-neighbor
 */
export async function processTexture(input: Buffer, size = 32): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const w = meta.width!, h = meta.height!;

  // Crop inner 60% to avoid any border/frame artifacts from generation
  const side = Math.min(w, h);
  const cropSize = Math.floor(side * 0.6);
  const left = Math.floor((w - cropSize) / 2);
  const top = Math.floor((h - cropSize) / 2);

  return sharp(input)
    .extract({ left, top, width: cropSize, height: cropSize })
    .resize(size, size, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
}

/**
 * Assemble individual tile PNGs into a tileset atlas.
 * Layout: single row of tiles, each `size`x`size`.
 * Columns param controls how many tiles per row (default 16).
 */
export async function assembleTileset(
  tiles: Buffer[],
  size = 32,
  columns = 16,
): Promise<Buffer> {
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * size;
  const height = rows * size;

  const composites = await Promise.all(
    tiles.map(async (buf, i) => ({
      input: await sharp(buf)
        .resize(size, size, { kernel: sharp.kernel.nearest })
        .png()
        .toBuffer(),
      left: (i % columns) * size,
      top: Math.floor(i / columns) * size,
    })),
  );

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * Flood fill from image edges to remove white background.
 * Preserves white pixels inside objects (e.g. whiteboard surface).
 */
async function floodFillRemoveBg(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;
  const pixels = Buffer.from(data);

  const isWhite = (i: number) => pixels[i] >= 250 && pixels[i+1] >= 250 && pixels[i+2] >= 250;
  const visited = new Uint8Array(w * h);
  const bgMask = new Uint8Array(w * h);

  // Seed BFS from all edge pixels that are white
  const queue: number[] = [];
  const seed = (x: number, y: number) => {
    const idx = y * w + x;
    if (isWhite(idx * 4) && !visited[idx]) {
      visited[idx] = 1;
      bgMask[idx] = 1;
      queue.push(idx);
    }
  };

  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % w, y = Math.floor(idx / w);
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (!visited[ni] && isWhite(ni * 4)) {
        visited[ni] = 1;
        bgMask[ni] = 1;
        queue.push(ni);
      }
    }
  }

  for (let i = 0; i < w * h; i++) {
    if (bgMask[i]) pixels[i * 4 + 3] = 0;
  }

  return sharp(pixels, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}
