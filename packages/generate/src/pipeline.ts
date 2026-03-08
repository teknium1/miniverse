/**
 * End-to-end generation pipeline:
 * prompt enrichment → fal.ai generate → bg removal → sprite processing
 */

import { buildPrompt, type SheetType } from './prompt.js';
import { generate, downloadImage } from './fal.js';
import { removeBg, removeBgUrl } from './background.js';
import { processCharacterSheet, processFurnitureSheet, processTexture, assembleTileset } from './process.js';
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

export interface GenerateCharacterOptions {
  /** Character description, e.g. "young female, pink hair, yellow cardigan" */
  prompt: string;
  /** Optional reference image URL or local path */
  refImage?: string;
  /** 'walk' or 'action' sheet */
  type?: 'walk' | 'action';
  /** Output file path (PNG). If omitted, returns buffer only. */
  output?: string;
  /** Skip background removal (if image already has transparent bg) */
  skipBgRemoval?: boolean;
}

export interface GenerateCharacterResult {
  /** Clean 256x256 sprite sheet buffer */
  buffer: Buffer;
  /** Output path if written to disk */
  outputPath?: string;
}

export async function generateCharacter(options: GenerateCharacterOptions): Promise<GenerateCharacterResult> {
  const sheetType: SheetType = options.type ?? 'walk';

  // Step 1: Enrich prompt
  const fullPrompt = buildPrompt(options.prompt, sheetType);
  console.log('Generating sprite sheet...');

  // Step 2: Generate via fal.ai
  const { imageUrl } = await generate({
    prompt: fullPrompt,
    refImage: options.refImage,
  });
  // Step 3: Background removal (pass URL directly, no extra download/upload)
  let downloadUrl = imageUrl;
  if (!options.skipBgRemoval) {
    console.log('Removing background...');
    downloadUrl = await removeBgUrl(imageUrl);
  }

  // Step 4: Download
  console.log('Downloading...');
  const imageBuffer = await downloadImage(downloadUrl);

  // Step 5: Process into clean sprite sheet
  // For action sheets, scale from standing rows (2=talking, 3=idle) so sitting poses stay shorter
  console.log('Processing sprite sheet...');
  const processOpts = sheetType === 'action' ? { scaleFromRows: [2, 3] } : undefined;
  const result = await processCharacterSheet(imageBuffer, processOpts);

  // Write to disk if output path given
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, result);
    console.log(`Saved: ${options.output}`);
    return { buffer: result, outputPath: options.output };
  }

  return { buffer: result };
}

export interface GenerateFurnitureOptions {
  /** Furniture description, e.g. "cozy cafe furniture set" */
  prompt: string;
  /** Optional reference image */
  refImage?: string;
  /** Output directory for individual piece PNGs */
  output?: string;
  /** Skip background removal */
  skipBgRemoval?: boolean;
}

export interface GenerateFurnitureResult {
  /** Individual furniture piece buffers */
  pieces: { buffer: Buffer; width: number; height: number }[];
  /** Output paths if written to disk */
  outputPaths?: string[];
}

export async function generateFurniture(options: GenerateFurnitureOptions): Promise<GenerateFurnitureResult> {
  // Step 1: Enrich prompt
  const fullPrompt = buildPrompt(options.prompt, 'furniture');
  console.log('Generating furniture...');

  // Step 2: Generate via fal.ai
  const { imageUrl } = await generate({
    prompt: fullPrompt,
    refImage: options.refImage,
  });
  // Step 3: Background removal (pass URL directly)
  let downloadUrl = imageUrl;
  if (!options.skipBgRemoval) {
    console.log('Removing background...');
    downloadUrl = await removeBgUrl(imageUrl);
  }

  // Step 4: Download
  console.log('Downloading...');
  const imageBuffer = await downloadImage(downloadUrl);

  // Step 5: Extract individual pieces
  console.log('Extracting furniture pieces...');
  const pieces = await processFurnitureSheet(imageBuffer);
  console.log(`Found ${pieces.length} pieces`);

  // Write to disk if output dir given
  if (options.output) {
    mkdirSync(options.output, { recursive: true });
    const outputPaths: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const p = path.join(options.output, `piece_${i}.png`);
      writeFileSync(p, pieces[i].buffer);
      outputPaths.push(p);
      console.log(`  piece_${i}: ${pieces[i].width}x${pieces[i].height}`);
    }
    return { pieces, outputPaths };
  }

  return { pieces };
}

export interface GenerateObjectOptions {
  /** Object description, e.g. "office desk with monitor and keyboard" */
  prompt: string;
  /** Optional reference image */
  refImage?: string;
  /** Output file path (PNG) */
  output?: string;
  /** Skip background removal */
  skipBgRemoval?: boolean;
}

export interface GenerateObjectResult {
  /** Trimmed object PNG buffer */
  buffer: Buffer;
  width: number;
  height: number;
  /** Output path if written to disk */
  outputPath?: string;
}

export async function generateObject(options: GenerateObjectOptions): Promise<GenerateObjectResult> {
  const fullPrompt = buildPrompt(options.prompt, 'object');
  console.log('Generating object...');

  const { imageUrl } = await generate({
    prompt: fullPrompt,
    refImage: options.refImage,
  });

  let downloadUrl = imageUrl;
  if (!options.skipBgRemoval) {
    console.log('Removing background...');
    downloadUrl = await removeBgUrl(imageUrl);
  }

  console.log('Downloading...');
  const imageBuffer = await downloadImage(downloadUrl);

  // Trim to content bounds
  console.log('Trimming...');
  const trimmed = await sharp(imageBuffer).trim().toBuffer({ resolveWithObject: true });

  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, trimmed.data);
    console.log(`Saved: ${options.output} (${trimmed.info.width}x${trimmed.info.height})`);
    return { buffer: trimmed.data, width: trimmed.info.width, height: trimmed.info.height, outputPath: options.output };
  }

  return { buffer: trimmed.data, width: trimmed.info.width, height: trimmed.info.height };
}

export interface GenerateTextureOptions {
  /** Texture description, e.g. "wooden floor planks" or "stone wall bricks" */
  prompt: string;
  /** Optional reference image */
  refImage?: string;
  /** Output file path (PNG) */
  output?: string;
  /** Tile size in pixels (default 32) */
  size?: number;
}

export interface GenerateTextureResult {
  /** Clean tile PNG buffer */
  buffer: Buffer;
  /** Output path if written to disk */
  outputPath?: string;
}

export async function generateTexture(options: GenerateTextureOptions): Promise<GenerateTextureResult> {
  const fullPrompt = buildPrompt(options.prompt, 'texture');
  console.log('Generating texture...');

  const { imageUrl } = await generate({
    prompt: fullPrompt,
    refImage: options.refImage,
  });

  // No bg removal — textures are opaque
  console.log('Downloading...');
  const imageBuffer = await downloadImage(imageUrl);

  console.log('Processing tile...');
  const result = await processTexture(imageBuffer, options.size ?? 32);

  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, result);
    console.log(`Saved: ${options.output}`);
    return { buffer: result, outputPath: options.output };
  }

  return { buffer: result };
}

export interface AssembleTilesetOptions {
  /** Ordered list of tile PNG paths */
  tiles: string[];
  /** Output file path */
  output: string;
  /** Tile size in pixels (default 32) */
  size?: number;
  /** Columns per row (default 16) */
  columns?: number;
}

export interface AssembleTilesetResult {
  buffer: Buffer;
  outputPath: string;
  tileCount: number;
  columns: number;
}

export async function buildTileset(options: AssembleTilesetOptions): Promise<AssembleTilesetResult> {
  const size = options.size ?? 32;
  const columns = options.columns ?? 16;

  console.log(`Assembling ${options.tiles.length} tiles into tileset...`);
  const tileBuffers = await Promise.all(
    options.tiles.map(t => sharp(t).png().toBuffer()),
  );

  const result = await assembleTileset(tileBuffers, size, columns);

  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, result);
  console.log(`Saved: ${options.output} (${options.tiles.length} tiles, ${columns} columns)`);

  return { buffer: result, outputPath: options.output, tileCount: options.tiles.length, columns };
}

/**
 * Process an existing image (already downloaded) through the pipeline.
 * Useful when you already have the raw image from fal.ai.
 */
export async function processExistingImage(
  imagePath: string,
  type: 'character' | 'furniture',
  output: string,
  options?: { skipBgRemoval?: boolean },
): Promise<void> {
  let buffer = await sharp(imagePath).png().toBuffer();

  if (!options?.skipBgRemoval) {
    console.log('Removing background...');
    buffer = await removeBg(buffer);
  }

  if (type === 'character') {
    console.log('Processing character sheet...');
    const result = await processCharacterSheet(buffer);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, result);
    console.log(`Saved: ${output}`);
  } else {
    console.log('Extracting furniture pieces...');
    const pieces = await processFurnitureSheet(buffer);
    mkdirSync(output, { recursive: true });
    for (let i = 0; i < pieces.length; i++) {
      const p = path.join(output, `piece_${i}.png`);
      writeFileSync(p, pieces[i].buffer);
      console.log(`  piece_${i}: ${pieces[i].width}x${pieces[i].height}`);
    }
  }
}
