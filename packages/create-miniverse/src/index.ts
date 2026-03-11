import * as p from '@clack/prompts';
import pc from 'picocolors';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(__dirname, '..', 'templates');

// --- Banner ---

const y = pc.yellow;
const c = pc.cyan;
const m = pc.magenta;
const g = pc.green;
const r = pc.red;
const b = pc.blue;
const w = pc.white;
const d = pc.dim;

const banner = `
${r('  ███╗   ███╗ ██╗ ███╗   ██╗ ██╗ ')}${b('██╗   ██╗ ███████╗ ██████╗  ███████╗ ███████╗')}
${r('  ████╗ ████║ ██║ ████╗  ██║ ██║ ')}${b('██║   ██║ ██╔════╝ ██╔══██╗ ██╔════╝ ██╔════╝')}
${r('  ██╔████╔██║ ██║ ██╔██╗ ██║ ██║ ')}${b('╚██╗ ██╔╝ █████╗   ██████╔╝ ███████╗ █████╗  ')}
${r('  ██║╚██╔╝██║ ██║ ██║╚██╗██║ ██║ ')}${b(' ╚████╔╝  ██╔══╝   ██╔══██╗ ╚════██║ ██╔══╝  ')}
${r('  ██║ ╚═╝ ██║ ██║ ██║ ╚████║ ██║ ')}${b('  ╚██╔╝   ███████╗ ██║  ██║ ███████║ ███████╗')}
${r('  ╚═╝     ╚═╝ ╚═╝ ╚═╝  ╚═══╝ ╚═╝ ')}${b('   ╚═╝    ╚══════╝ ╚═╝  ╚═╝ ╚══════╝ ╚══════╝')}
${d('  a tiny pixel world for your AI agents')}
`;


// --- Pre-built worlds ---

const WORLDS = [
  { value: 'cozy-startup', label: 'Cozy Startup', hint: 'warm office with exposed brick' },
  { value: 'posh-highrise', label: 'Posh Highrise', hint: 'clean modern office with marble floors' },
  { value: 'jungle-treehouse', label: 'Jungle Treehouse', hint: 'tropical office in the canopy' },
  { value: 'ocean-lab', label: 'Ocean Lab', hint: 'underwater research station' },
  { value: 'gear-supply', label: 'Gear Supply', hint: 'industrial tech workspace' },
];

// --- World setup modes ---

type WorldSetup =
  | { mode: 'prebuilt'; worldId: string }
  | { mode: 'generate-prompt'; prompt: string; citizens: number; worldId: string }
  | { mode: 'generate-image'; imagePath: string; citizens: number; worldId: string };

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

// --- Default character sprites available ---

const SPRITES = ['morty', 'dexter', 'nova', 'rio'];

// --- Main ---

async function main() {
  console.log(banner);

  p.intro(pc.bgGreen(pc.black(' create-miniverse ')));

  // Project name
  const dirArg = process.argv[2];
  const projectName = dirArg ?? await p.text({
    message: 'Project name',
    placeholder: 'my-miniverse',
    defaultValue: 'my-miniverse',
    validate: (v) => {
      if (!v) return 'Project name is required';
      if (existsSync(v)) return `Directory "${v}" already exists`;
    },
  });

  if (p.isCancel(projectName)) { p.cancel('Cancelled.'); process.exit(0); }

  // Agent names
  const agentInput = await p.text({
    message: 'What are your agents called? (comma-separated)',
    placeholder: 'Claude, Sage, Nova, Flux',
    defaultValue: 'Claude, Sage, Nova, Flux',
  });

  if (p.isCancel(agentInput)) { p.cancel('Cancelled.'); process.exit(0); }

  const agents = (agentInput as string).split(',').map(s => s.trim()).filter(Boolean);

  // World setup mode
  const worldMode = await p.select({
    message: 'How do you want to set up your world?',
    options: [
      { value: 'prebuilt', label: 'Pick a pre-built world', hint: 'choose from ready-made environments' },
      { value: 'generate-prompt', label: 'Generate from a description', hint: 'AI creates a world from your prompt (requires FAL_KEY)' },
      { value: 'generate-image', label: 'Generate from a reference image', hint: 'AI creates a world matching an image (requires FAL_KEY)' },
    ],
  });

  if (p.isCancel(worldMode)) { p.cancel('Cancelled.'); process.exit(0); }

  let worldSetup: WorldSetup | undefined;

  if (worldMode === 'prebuilt') {
    const worldId = await p.select({
      message: 'Pick a world',
      options: WORLDS.map(w => ({
        value: w.value,
        label: w.label,
        hint: w.hint,
      })),
    });

    if (p.isCancel(worldId)) { p.cancel('Cancelled.'); process.exit(0); }

    worldSetup = { mode: 'prebuilt', worldId: worldId as string };

  } else if (worldMode === 'generate-prompt' || worldMode === 'generate-image') {
    // Ask for FAL_KEY if not already set
    let falKey = process.env.FAL_KEY ?? '';
    if (!falKey) {
      const keyInput = await p.text({
        message: 'Enter your fal.ai API key (get one at https://fal.ai/dashboard/keys)',
        placeholder: 'fal_...',
        validate: (v) => { if (!v) return 'API key is required for generation — press Ctrl+C to go back'; },
      });

      if (p.isCancel(keyInput)) {
        // Fall back to pre-built world picker
        p.log.info('No worries — picking a pre-built world instead.');
        const worldId = await p.select({
          message: 'Pick a world',
          options: WORLDS.map(w => ({
            value: w.value,
            label: w.label,
            hint: w.hint,
          })),
        });
        if (p.isCancel(worldId)) { p.cancel('Cancelled.'); process.exit(0); }
        worldSetup = { mode: 'prebuilt', worldId: worldId as string };
      } else {
        falKey = keyInput as string;
        process.env.FAL_KEY = falKey;
      }
    }

    // Only proceed with generation prompts if we didn't fall back
    if (!worldSetup) {
      if (worldMode === 'generate-prompt') {
        const description = await p.text({
          message: 'Describe your world',
          placeholder: 'cozy startup office with lots of plants',
          validate: (v) => { if (!v) return 'Description is required'; },
        });

        if (p.isCancel(description)) { p.cancel('Cancelled.'); process.exit(0); }

        const citizens = await p.text({
          message: 'Number of citizens (desks)',
          placeholder: String(agents.length),
          defaultValue: String(agents.length),
          validate: (v) => { if (!v || isNaN(Number(v)) || Number(v) < 1) return 'Enter a positive number'; },
        });

        if (p.isCancel(citizens)) { p.cancel('Cancelled.'); process.exit(0); }

        worldSetup = {
          mode: 'generate-prompt',
          prompt: description as string,
          citizens: Number(citizens),
          worldId: slugify(description as string),
        };
      } else {
        const imagePath = await p.text({
          message: 'Path to reference image',
          placeholder: './office-photo.jpg',
          validate: (v) => {
            if (!v) return 'Image path is required';
            if (!existsSync(v)) return `File not found: ${v}`;
          },
        });

        if (p.isCancel(imagePath)) { p.cancel('Cancelled.'); process.exit(0); }

        const citizens = await p.text({
          message: 'Number of citizens (desks)',
          placeholder: String(agents.length),
          defaultValue: String(agents.length),
          validate: (v) => { if (!v || isNaN(Number(v)) || Number(v) < 1) return 'Enter a positive number'; },
        });

        if (p.isCancel(citizens)) { p.cancel('Cancelled.'); process.exit(0); }

        worldSetup = {
          mode: 'generate-image',
          imagePath: imagePath as string,
          citizens: Number(citizens),
          worldId: `generated-${Date.now()}`,
        };
      }
    }
  }

  const worldId = worldSetup.worldId;

  // Signal mode
  const signalMode = await p.select({
    message: 'How will your agents send updates?',
    options: [
      { value: 'server', label: 'Heartbeat server', hint: 'POST /api/heartbeat — best for AI agents (recommended)' },
      { value: 'mock', label: 'Mock data', hint: 'random state changes — good for testing' },
    ],
  });

  if (p.isCancel(signalMode)) { p.cancel('Cancelled.'); process.exit(0); }

  // --- Scaffold ---

  const projectDir = path.resolve(process.cwd(), projectName as string);
  const s = p.spinner();

  s.start('Creating project...');

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  mkdirSync(path.join(projectDir, 'public', 'universal_assets', 'citizens'), { recursive: true });
  mkdirSync(path.join(projectDir, 'public', 'universal_assets', 'tiles'), { recursive: true });
  mkdirSync(path.join(projectDir, 'public', 'universal_assets', 'props'), { recursive: true });
  mkdirSync(path.join(projectDir, 'public', 'worlds'), { recursive: true });

  // Use file: paths only when MINIVERSE_DEV is set (for local monorepo development)
  const useLocal = !!process.env.MINIVERSE_DEV;
  const monorepoRoot = path.resolve(__dirname, '..', '..', '..');

  const coreDep = useLocal ? `file:${path.join(monorepoRoot, 'packages', 'core')}` : '^0.2.0';
  const serverDep = useLocal ? `file:${path.join(monorepoRoot, 'packages', 'server')}` : '^0.2.0';
  const genDep = useLocal ? `file:${path.join(monorepoRoot, 'packages', 'generate')}` : '^0.2.0';

  // Write package.json
  const pkg = {
    name: projectName,
    private: true,
    type: 'module' as const,
    scripts: {
      dev: signalMode === 'server'
        ? 'concurrently -n vite,server -c cyan,magenta "vite" "miniverse --no-browser"'
        : 'vite',
      build: 'vite build',
      preview: 'vite preview',
      ...(signalMode === 'server' ? { server: 'miniverse' } : {}),
    },
    dependencies: {
      '@miniverse/core': coreDep,
      ...(signalMode === 'server' ? { '@miniverse/server': serverDep } : {}),
    },
    devDependencies: {
      '@miniverse/generate': genDep,
      ...(signalMode === 'server' ? { concurrently: '^9.0.0' } : {}),
      typescript: '^5.4.0',
      vite: '^5.4.0',
    },
  };
  writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // Write tsconfig.json
  writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      jsx: 'preserve',
    },
    include: ['src'],
  }, null, 2) + '\n');

  // Write vite.config.ts
  writeFileSync(path.join(projectDir, 'vite.config.ts'), generateViteConfig(worldId as string));

  // Write index.html
  writeFileSync(path.join(projectDir, 'index.html'), generateIndexHtml(projectName as string, agents));

  // Write src/main.ts
  writeFileSync(path.join(projectDir, 'src', 'main.ts'), generateMainTs(agents, worldId as string, signalMode as string));

  // Write world index
  if (worldSetup.mode === 'prebuilt') {
    const world = WORLDS.find(w => w.value === worldId);
    writeFileSync(
      path.join(projectDir, 'public', 'worlds', 'index.json'),
      JSON.stringify([{ id: world!.value, name: world!.label }], null, 2) + '\n',
    );
  } else {
    const label = worldSetup.mode === 'generate-prompt' ? worldSetup.prompt : 'Generated World';
    writeFileSync(
      path.join(projectDir, 'public', 'worlds', 'index.json'),
      JSON.stringify([{ id: worldId, name: label }], null, 2) + '\n',
    );
  }

  s.stop('Project created');

  // --- Copy or generate world assets ---

  const targetWorldDir = path.join(projectDir, 'public', 'worlds', worldId as string);

  if (worldSetup.mode === 'prebuilt') {
    s.start(`Downloading ${WORLDS.find(w => w.value === worldId)!.label} world...`);

    const demoWorldsDir = path.resolve(__dirname, '..', '..', '..', 'demo', 'public', 'worlds', worldId as string);

    if (existsSync(demoWorldsDir)) {
      copyDirSync(demoWorldsDir, targetWorldDir);
    } else {
      // If running from npm (not monorepo), try templates dir
      const templateWorldDir = path.join(TEMPLATES, 'worlds', worldId as string);
      if (existsSync(templateWorldDir)) {
        copyDirSync(templateWorldDir, targetWorldDir);
      } else {
        mkdirSync(targetWorldDir, { recursive: true });
        writeFileSync(path.join(targetWorldDir, 'world.json'), '{}');
        p.log.warn('World assets not found — you may need to copy them manually or generate a new world.');
      }
    }
  } else {
    // AI world generation
    p.log.info('Generating your world with AI... this may take a minute.');

    const genArgs = worldSetup.mode === 'generate-prompt'
      ? `--prompt "${worldSetup.prompt.replace(/"/g, '\\"')}"`
      : `--image "${worldSetup.imagePath.replace(/"/g, '\\"')}"`;

    const citizens = worldSetup.citizens;

    const localGenBin = path.resolve(__dirname, '..', '..', '..', 'packages', 'generate', 'bin', 'miniverse-generate.js');
    const genBin = useLocal && existsSync(localGenBin)
      ? `node "${localGenBin}"`
      : 'npx -p @miniverse/generate miniverse-generate';
    const cmd = `${genBin} world ${genArgs} --output "${targetWorldDir}" --citizens ${citizens}`;

    try {
      execSync(cmd, { stdio: 'inherit', cwd: projectDir });
      p.log.success('World generated successfully!');
    } catch (err) {
      p.log.warn(pc.yellow('World generation failed — falling back to a pre-built world.'));

      const fallbackId = await p.select({
        message: 'Pick a world instead',
        options: WORLDS.map(w => ({
          value: w.value,
          label: w.label,
          hint: w.hint,
        })),
      });

      if (p.isCancel(fallbackId)) { p.cancel('Cancelled.'); process.exit(0); }

      // Copy pre-built world
      const fbId = fallbackId as string;
      const fbTarget = path.join(projectDir, 'public', 'worlds', fbId);
      const demoWorldsDir = path.resolve(__dirname, '..', '..', '..', 'demo', 'public', 'worlds', fbId);
      if (existsSync(demoWorldsDir)) {
        copyDirSync(demoWorldsDir, fbTarget);
      } else {
        const templateWorldDir = path.join(TEMPLATES, 'worlds', fbId);
        if (existsSync(templateWorldDir)) {
          copyDirSync(templateWorldDir, fbTarget);
        }
      }
      // Update main.ts with fallback world ID
      const mainPath = path.join(projectDir, 'src', 'main.ts');
      const mainContent = readFileSync(mainPath, 'utf-8');
      writeFileSync(mainPath, mainContent.replace(worldSetup.worldId, fbId));
    }
  }

  s.stop('World ready');

  s.start('Copying assets...');

  // Copy universal assets (citizens, tiles, props)
  const demoUniversalDir = path.resolve(__dirname, '..', '..', '..', 'demo', 'public', 'universal_assets');
  const templateUniversalDir = path.join(TEMPLATES, 'universal_assets');
  const targetUniversalDir = path.join(projectDir, 'public', 'universal_assets');

  for (const assetType of ['citizens', 'tiles', 'props']) {
    // Try demo dir first (monorepo), then templates dir (npm)
    const sourceDir = existsSync(path.join(demoUniversalDir, assetType))
      ? path.join(demoUniversalDir, assetType)
      : path.join(templateUniversalDir, assetType);

    if (existsSync(sourceDir)) {
      const targetDir = path.join(targetUniversalDir, assetType);
      for (const file of readdirSync(sourceDir)) {
        if (file.endsWith('.png')) {
          copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
        }
      }
    }
  }

  s.stop('Assets copied');

  // --- Done ---

  const nextSteps = [
    `cd ${projectName}`,
    'npm install',
    'npm run dev',
  ];

  p.note(nextSteps.join('\n'), 'Next steps');

  p.outro(pc.green('Your miniverse is ready! Press E to open the editor.'));
}

// --- Template generators ---

function generateViteConfig(worldId: string): string {
  return `import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

function worldSavePlugin() {
  return {
    name: 'world-save',
    configureServer(server: any) {
      server.middlewares.use('/api/save-world', (req: any, res: any) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const worldId = data.worldId ?? '${worldId}';
            delete data.worldId;

            const safeId = worldId.replace(/[^a-zA-Z0-9_-]/g, '');
            const worldDir = path.resolve(__dirname, 'public/worlds', safeId);
            if (!fs.existsSync(worldDir)) {
              fs.mkdirSync(worldDir, { recursive: true });
            }

            const filePath = path.join(worldDir, 'world.json');
            let existing: Record<string, unknown> = {};
            if (fs.existsSync(filePath)) {
              try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
            }
            const merged = { ...existing, ...data };

            fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\\n');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            console.log('[world-save] Written to', filePath);
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
    },
  };
}

function generatePlugin() {
  return {
    name: 'generate',
    configureServer(server: any) {
      server.middlewares.use('/api/generate', (req: any, res: any) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);

            if (!data.prompt || !data.type) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Missing prompt or type' }));
              return;
            }

            if (data.falKey) process.env.FAL_KEY = data.falKey;
            if (!process.env.FAL_KEY) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'No FAL_KEY. Set it in the Generate tab or as an environment variable.' }));
              return;
            }

            let gen: any;
            try {
              gen = await import('@miniverse/generate');
            } catch {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Install @miniverse/generate: npm i @miniverse/generate' }));
              return;
            }

            const publicDir = path.resolve(__dirname, 'public');
            const slug = data.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
            const worldId = (data.worldId || '').replace(/[^a-zA-Z0-9_-]/g, '');
            const worldDir = worldId ? path.join(publicDir, 'worlds', worldId) : publicDir;

            // Handle base64 reference image
            let refImage: string | undefined;
            if (data.image) {
              const os = await import('os');
              const tmpPath = path.join(os.tmpdir(), 'miniverse_ref_' + Date.now() + '.png');
              fs.writeFileSync(tmpPath, Buffer.from(data.image, 'base64'));
              refImage = tmpPath;
            }

            let resultPath: string;
            let resultId: string;

            if (data.type === 'props') {
              // Count existing props to get next index
              const propsDir = path.join(worldDir, 'world_assets/props');
              fs.mkdirSync(propsDir, { recursive: true });
              const existing = fs.readdirSync(propsDir).filter((f: string) => f.startsWith('prop_'));
              const nextIdx = existing.length;
              resultId = slug || 'prop';
              const filename = 'prop_' + nextIdx + '_' + resultId + '.png';
              const outPath = path.join(propsDir, filename);
              await gen.generateObject({ prompt: data.prompt, refImage, output: outPath });
              resultPath = worldId
                ? '/worlds/' + worldId + '/world_assets/props/' + filename
                : '/world_assets/props/' + filename;
            } else if (data.type === 'texture') {
              resultId = slug || 'texture';
              const filename = resultId + '.png';
              const tilesDir = path.join(worldDir, 'world_assets/tiles');
              fs.mkdirSync(tilesDir, { recursive: true });
              const outPath = path.join(tilesDir, filename);
              await gen.generateTexture({ prompt: data.prompt, refImage, output: outPath, size: 32 });
              resultPath = worldId
                ? '/worlds/' + worldId + '/world_assets/tiles/' + filename
                : '/world_assets/tiles/' + filename;
            } else if (data.type === 'character') {
              resultId = slug || 'character';
              const citizensDir = path.join(publicDir, 'universal_assets/citizens');
              fs.mkdirSync(citizensDir, { recursive: true });

              const walkFile = resultId + '_walk.png';
              const walkPath = path.join(citizensDir, walkFile);
              console.log('[generate] Generating walk sheet...');
              await gen.generateCharacter({ prompt: data.prompt, refImage, type: 'walk', output: walkPath });

              const actionsFile = resultId + '_actions.png';
              const actionsPath = path.join(citizensDir, actionsFile);
              console.log('[generate] Generating actions sheet...');
              await gen.generateCharacter({ prompt: data.prompt, refImage, type: 'action', output: actionsPath });

              resultPath = '/universal_assets/citizens/' + walkFile;
            } else {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invalid type. Use: props, texture, character' }));
              return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: resultPath, id: resultId, type: data.type }));
            console.log('[generate] Created:', resultPath);
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
      });
    },
  };
}

function tilesListPlugin() {
  return {
    name: 'tiles-list',
    configureServer(server: any) {
      server.middlewares.use('/api/tiles', (req: any, res: any) => {
        const url = new URL(req.url, 'http://localhost');
        const worldId = (url.searchParams.get('worldId') || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const tilesDir = worldId
          ? path.resolve(__dirname, 'public/worlds', worldId, 'world_assets/tiles')
          : path.resolve(__dirname, 'public/universal_assets/tiles');
        let names: string[] = [];
        if (fs.existsSync(tilesDir)) {
          names = fs.readdirSync(tilesDir)
            .filter((f: string) => f.endsWith('.png') && f !== 'office.png')
            .map((f: string) => f.replace('.png', ''));
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(names));
      });
    },
  };
}

function citizensListPlugin() {
  return {
    name: 'citizens-list',
    configureServer(server: any) {
      server.middlewares.use('/api/citizens', (_req: any, res: any) => {
        const citizensDir = path.resolve(__dirname, 'public/universal_assets/citizens');
        let names: string[] = [];
        if (fs.existsSync(citizensDir)) {
          names = fs.readdirSync(citizensDir)
            .filter((f: string) => f.endsWith('_walk.png'))
            .map((f: string) => f.replace('_walk.png', ''));
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(names));
      });
    },
  };
}

export default defineConfig({
  plugins: [worldSavePlugin(), generatePlugin(), tilesListPlugin(), citizensListPlugin()],
});
`;
}

function generateIndexHtml(projectName: string, agents: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${projectName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #eee;
      font-family: 'Courier New', monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      gap: 16px;
    }
    h1 { font-size: 20px; color: #e94560; letter-spacing: 4px; text-transform: uppercase; }
    .subtitle { font-size: 12px; color: #666; margin-bottom: 8px; }
    #miniverse-container {
      border: 2px solid #333;
      border-radius: 4px;
      overflow: hidden;
      background: #0f0f23;
      display: inline-block;
      line-height: 0;
      transition: border-color 0.15s, border-radius 0.15s;
    }
    #editor-wrapper #miniverse-container {
      border-color: #00ff88;
      border-radius: 4px 0 0 4px;
    }
    #tooltip {
      position: fixed;
      background: rgba(0,0,0,0.85);
      border: 1px solid #e94560;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 11px;
      pointer-events: none;
      display: none;
      z-index: 100;
      max-width: 200px;
    }
    #tooltip .name { color: #e94560; font-weight: bold; }
    #tooltip .state { color: #aaa; }
    #tooltip .task { color: #66aaff; }
    .status-bar {
      display: flex; gap: 16px; font-size: 11px; color: #555;
    }
    .status-bar .agent { display: flex; align-items: center; gap: 4px; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: #555; }
    .status-dot.working { background: #4ade80; }
    .status-dot.idle { background: #fbbf24; }
    .status-dot.sleeping { background: #818cf8; }
    .status-dot.thinking { background: #f472b6; }
    .status-dot.error { background: #ef4444; }
    .status-dot.speaking { background: #22d3ee; }
    .hint { font-size: 10px; color: #444; }
    kbd { display: inline-block; padding: 1px 5px; border: 1px solid #555; border-radius: 3px; background: #2a2a3e; color: #ccc; font-family: inherit; font-size: 11px; line-height: 1.4; }
  </style>
</head>
<body>
  <h1>${projectName}</h1>
  <p class="subtitle">Press <kbd>E</kbd> to toggle editor · powered by miniverse</p>
  <div id="miniverse-container"></div>
  <div class="status-bar" id="status-bar"></div>
  <div id="tooltip">
    <div class="name"></div>
    <div class="state"></div>
    <div class="task"></div>
  </div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;
}

function generateMainTs(agents: string[], worldId: string, signalMode: string): string {
  const agentIds = agents.map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const signalConfig = signalMode === 'server'
    ? `    signal: {
      type: 'websocket',
      url: 'ws://localhost:4321/ws',
    },`
    : `    signal: {
      type: 'mock',
      mockData: () => [${agentIds.map((id, i) => `
        { id: '${id}', name: '${agents[i]}', state: (['working', 'idle', 'thinking'] as const)[Math.floor(Math.random() * 3)], task: null, energy: Math.random() },`).join('')}
      ],
      interval: 3000,
    },`;

  // For server mode, auto-discover agents; for mock mode, hardcode them
  let spriteAssignments: string;
  let citizenConfigs: string;

  if (signalMode === 'server') {
    spriteAssignments = `    ...Object.fromEntries(serverAgents.map((a: any, i: number) =>
      [a.agent, charSprites(availableSprites[i % availableSprites.length])]
    ))`;
    citizenConfigs = `      ...serverAgents.map((a: any, i: number) => ({
        agentId: a.agent,
        name: a.name || a.agent,
        sprite: a.agent,
        position: workAnchors[i] ?? sceneData?.wanderPoints?.[i]?.name ?? 'wander_' + i,
      }))`;
  } else {
    spriteAssignments = agentIds.map((id, i) => {
      const sprite = SPRITES[i % SPRITES.length];
      return `    '${id}': charSprites('${sprite}'),`;
    }).join('\n');
    citizenConfigs = agentIds.map((id, i) => {
      const name = agents[i];
      return `      { agentId: '${id}', name: '${name}', sprite: '${id}', position: workAnchors[${i}] ?? sceneData?.wanderPoints?.[${i}]?.name ?? 'wander_0' },`;
    }).join('\n');
  }

  return `import { Miniverse, PropSystem, Editor, createStandardSpriteConfig } from '@miniverse/core';
import type { SceneConfig, SpriteSheetConfig, CitizenDef } from '@miniverse/core';

const WORLD_ID = '${worldId}';
const basePath = \`/worlds/\${WORLD_ID}\`;

function charSprites(name: string): SpriteSheetConfig {
  return {
    sheets: {
      walk: \`/universal_assets/citizens/\${name}_walk.png\`,
      actions: \`/universal_assets/citizens/\${name}_actions.png\`,
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

function buildSceneConfig(cols: number, rows: number, floor: string[][] | undefined, tiles: Record<string, string> | undefined): SceneConfig {
  const safeFloor: string[][] = floor ?? Array.from({ length: rows }, () => Array(cols).fill(''));
  const walkable: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    walkable[r] = [];
    for (let c = 0; c < cols; c++) walkable[r][c] = (safeFloor[r]?.[c] ?? '') !== '';
  }

  const resolvedTiles: Record<string, string> = { ...(tiles ?? {}) };
  for (const [key, src] of Object.entries(resolvedTiles)) {
    if (/^(blob:|data:|https?:\\/\\/)/.test(src)) continue;
    const clean = src.startsWith('/') ? src.slice(1) : src;
    resolvedTiles[key] = \`\${basePath}/\${clean}\`;
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

  const sceneData = await fetch(\`\${basePath}/world.json\`).then(r => r.json()).catch(() => null);

  // Collect work anchor names from props for citizen placement
  const workAnchors: string[] = (sceneData?.props ?? [])
    .flatMap((f: any) => (f.anchors ?? []).filter((a: any) => a.type === 'work').map((a: any) => a.name));

  const gridCols = sceneData?.gridCols ?? 16;
  const gridRows = sceneData?.gridRows ?? 12;
  const sceneConfig = buildSceneConfig(gridCols, gridRows, sceneData?.floor, sceneData?.tiles);
  const tileSize = 32;
${signalMode === 'server' ? `
  // Auto-discover agents from server and available sprites
  const availableSprites: string[] = await fetch('/api/citizens').then(r => r.json()).catch(() => ['morty', 'dexter', 'nova', 'rio']);
  const serverAgents: { agent: string; name: string }[] = await fetch('http://localhost:4321/api/agents')
    .then(r => r.json())
    .then((d: any) => d.agents ?? [])
    .catch(() => []);
` : ''}
  const spriteSheets: Record<string, SpriteSheetConfig> = {
${spriteAssignments}
  };

  const mv = new Miniverse({
    container,
    world: WORLD_ID,
    scene: 'main',
${signalConfig}
    citizens: [
${citizenConfigs}
    ],
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
      const clean = src.startsWith('/') ? src : '/' + src;
      return props.loadSprite(id, \`\${basePath}\${clean}\`);
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
    tooltip.querySelector('.state')!.textContent = \`State: \${d.state}\`;
    tooltip.querySelector('.task')!.textContent = d.task ? \`Task: \${d.task}\` : 'No active task';
    setTimeout(() => { tooltip.style.display = 'none'; }, 3000);
  });

  container.addEventListener('mousemove', (e) => {
    tooltip.style.left = e.clientX + 12 + 'px';
    tooltip.style.top = e.clientY + 12 + 'px';
  });
}

main().catch(console.error);
`;
}

// --- Helpers ---

function copyDirSync(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

main().catch(console.error);
