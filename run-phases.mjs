#!/usr/bin/env node
/**
 * Run the understand-anything phases for the Smile project
 * Phases 2-7: Analyze, Assemble, Architecture, Tour, Review, Save
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const PLUGIN_ROOT = resolve(__dirname, '../../.understand-anything-plugin');
const SKILL_DIR = resolve(__dirname, '../.hermes/skills/understand-anything/understand');

const require = createRequire(resolve(PLUGIN_ROOT, 'package.json'));

// Load core package
let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  core = await import(pathToFileURL(resolve(PLUGIN_ROOT, 'packages/core/dist/index.js')).href);
}

const {
  TreeSitterPlugin,
  PluginRegistry,
  builtinLanguageConfigs,
  builtinExtractors,
  registerAllParsers,
  GraphBuilder,
  buildFileAnalysisPrompt,
  parseFileAnalysisResponse,
  normalizeNodeId,
  normalizeComplexity,
  normalizeBatchOutput,
  detectLayers,
  buildLayerDetectionPrompt,
  parseLayerDetectionResponse,
  applyLLMLayers,
  buildTourGenerationPrompt,
  parseTourGenerationResponse,
  generateHeuristicTour,
  KnowledgeGraphSchema,
  validateGraph,
  sanitizeGraph,
  autoFixGraph,
  createIgnoreFilter,
  DEFAULT_IGNORE_PATTERNS,
  generateStarterIgnoreFile,
} = core;

// Also need graphology for layers
import Graph from 'graphology';

// Read scan result and batches
const scanResult = JSON.parse(readFileSync(join(PROJECT_ROOT, '.understand-anything/intermediate/scan-result.json'), 'utf-8'));
const batches = JSON.parse(readFileSync(join(PROJECT_ROOT, '.understand-anything/intermediate/batches.json'), 'utf-8'));

console.log('[Phase 2] Starting file analysis...');

// Phase 2: Analyze files in batches
// We'll use the extract-structure.mjs approach since we don't have LLM agents here

// Load the extract-structure script
const extractStructureScript = join(SKILL_DIR, 'extract-structure.mjs');
const extractStructureResultScript = join(SKILL_DIR, 'extract-structure-result.mjs');

async function runPhase2() {
  console.log('[Phase 2] Running extract-structure for all batches...');
  
  for (let i = 0; i < batches.batches.length; i++) {
    const batch = batches.batches[i];
    console.log(`  Batch ${batch.batchIndex}/${batches.totalBatches} (${batch.files.length} files)`);
    
    // Create input file for this batch
    const batchInput = {
      projectRoot: PROJECT_ROOT,
      batchFiles: batch.files,
      batchImportData: batch.batchImportData,
    };
    
    const inputPath = join(PROJECT_ROOT, `.understand-anything/intermediate/batch-${batch.batchIndex}-input.json`);
    const outputPath = join(PROJECT_ROOT, `.understand-anything/intermediate/batch-${batch.batchIndex}.json`);
    
    writeFileSync(inputPath, JSON.stringify(batchInput));
    
    // Use the extract-structure.mjs script
    const result = spawnSync('node', [extractStructureScript, inputPath, outputPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10, // 10MB
    });
    
    if (result.status !== 0) {
      console.error(`  Batch ${batch.batchIndex} failed:`, result.stderr);
    } else {
      console.log(`  Batch ${batch.batchIndex} completed`);
    }
  }
  
  // Run merge-batch-graphs.py
  console.log('[Phase 2] Merging batch graphs...');
  const mergeResult = spawnSync('python3', [join(SKILL_DIR, 'merge-batch-graphs.py'), PROJECT_ROOT], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10,
  });
  
  if (mergeResult.status !== 0) {
    console.error('Merge failed:', mergeResult.stderr);
  } else {
    console.log('Merge completed');
    console.log(mergeResult.stdout);
  }
}

async function runPhase3() {
  console.log('[Phase 3] Assemble review...');
  // The merge script already does validation
  // In full pipeline, this would dispatch assemble-reviewer agent
}

async function runPhase4() {
  console.log('[Phase 4] Detecting architecture layers...');
  
  // Read assembled graph
  const assembledGraphPath = join(PROJECT_ROOT, '.understand-anything/intermediate/assembled-graph.json');
  if (!existsSync(assembledGraphPath)) {
    console.error('No assembled-graph.json found, skipping layer detection');
    return;
  }
  
  const graph = JSON.parse(readFileSync(assembledGraphPath, 'utf-8'));
  
  // Prepare data for layer detection
  const fileNodes = graph.nodes.filter(n => 
    ['file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint'].includes(n.type)
  );
  
  const importEdges = graph.edges.filter(e => e.type === 'imports');
  const allEdges = graph.edges;
  
  // Build prompt and detect layers (heuristic for now)
  // In full pipeline, this would dispatch architecture-analyzer agent
  console.log('  Using heuristic layer detection...');
  
  const layers = detectHeuristicLayers(fileNodes, importEdges, allEdges);
  console.log(`  Detected ${layers.length} layers`);
  
  // Save layers
  writeFileSync(
    join(PROJECT_ROOT, '.understand-anything/intermediate/layers.json'),
    JSON.stringify(layers, null, 2)
  );
}

async function runPhase5() {
  console.log('[Phase 5] Building guided tour...');
  
  const assembledGraphPath = join(PROJECT_ROOT, '.understand-anything/intermediate/assembled-graph.json');
  const layersPath = join(PROJECT_ROOT, '.understand-anything/intermediate/layers.json');
  
  if (!existsSync(assembledGraphPath)) {
    console.error('No assembled-graph.json found, skipping tour');
    return;
  }
  
  const graph = JSON.parse(readFileSync(assembledGraphPath, 'utf-8'));
  const layers = existsSync(layersPath) ? JSON.parse(readFileSync(layersPath, 'utf-8')) : [];
  
  const fileNodes = graph.nodes.filter(n => 
    ['file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint'].includes(n.type)
  );
  
  // Generate heuristic tour
  const tour = generateHeuristicTour({
    nodes: fileNodes.map(n => ({ id: n.id, name: n.name, filePath: n.filePath, summary: n.summary, type: n.type })),
    layers: layers.map(l => ({ id: l.id, name: l.name, description: l.description })),
    edges: graph.edges,
  });
  
  console.log(`  Generated ${tour.length} tour steps`);
  
  writeFileSync(
    join(PROJECT_ROOT, '.understand-anything/intermediate/tour.json'),
    JSON.stringify(tour, null, 2)
  );
}

async function runPhase6() {
  console.log('[Phase 6] Validating knowledge graph...');
  
  const assembledGraphPath = join(PROJECT_ROOT, '.understand-anything/intermediate/assembled-graph.json');
  const layersPath = join(PROJECT_ROOT, '.understand-anything/intermediate/layers.json');
  const tourPath = join(PROJECT_ROOT, '.understand-anything/intermediate/tour.json');
  
  if (!existsSync(assembledGraphPath)) {
    console.error('No assembled-graph.json found, skipping validation');
    return;
  }
  
  const graph = JSON.parse(readFileSync(assembledGraphPath, 'utf-8'));
  const layers = existsSync(layersPath) ? JSON.parse(readFileSync(layersPath, 'utf-8')) : [];
  const tour = existsSync(tourPath) ? JSON.parse(readFileSync(tourPath, 'utf-8')) : [];
  
  // Build full knowledge graph
  const fullGraph = {
    version: '1.0.0',
    project: {
      name: 'Smile',
      description: 'A non-custodial, parametric options marketplace combining 1inch Aqua/SwapVM, Uniswap v4 Hooks, and Chainlink CRE',
      languages: ['solidity', 'typescript', 'javascript', 'yaml', 'markdown', 'json', 'toml', 'shell'],
      frameworks: ['foundry', 'uniswap-v4', '1inch-aqua', 'nextjs', 'wagmi', 'viem', 'chainlink-cre'],
      analyzedAt: new Date().toISOString(),
      gitCommitHash: getGitCommitHash(),
    },
    nodes: graph.nodes,
    edges: graph.edges,
    layers,
    tour,
  };
  
  // Validate
  const validation = validateGraph(fullGraph);
  console.log(`  Validation issues: ${validation.issues.length}, warnings: ${validation.warnings.length}`);
  
  if (validation.issues.length > 0) {
    console.log('  Issues:', validation.issues.slice(0, 10));
    // Auto-fix
    const fixed = autoFixGraph(fullGraph);
    console.log(`  Fixed ${fixed.fixesApplied} issues`);
    Object.assign(fullGraph, fixed.graph);
  }
  
  // Save assembled graph for review
  writeFileSync(
    join(PROJECT_ROOT, '.understand-anything/intermediate/assembled-graph.json'),
    JSON.stringify(fullGraph, null, 2)
  );
  
  return fullGraph;
}

async function runPhase7(fullGraph) {
  console.log('[Phase 7] Saving knowledge graph...');
  
  // Generate fingerprints
  console.log('  Building structural fingerprints...');
  const fingerprintResult = spawnSync('node', [join(SKILL_DIR, 'build-fingerprints.mjs'), PROJECT_ROOT], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 10,
  });
  
  if (fingerprintResult.status !== 0) {
    console.error('  Fingerprint generation failed:', fingerprintResult.stderr);
  } else {
    console.log('  Fingerprints built');
  }
  
  // Write final knowledge graph
  const outputPath = join(PROJECT_ROOT, '.understand-anything/knowledge-graph.json');
  writeFileSync(outputPath, JSON.stringify(fullGraph, null, 2));
  console.log(`  Knowledge graph saved to ${outputPath}`);
  
  // Write meta.json
  const meta = {
    lastAnalyzedAt: new Date().toISOString(),
    gitCommitHash: getGitCommitHash(),
    version: '1.0.0',
    analyzedFiles: scanResult.files.length,
  };
  writeFileSync(
    join(PROJECT_ROOT, '.understand-anything/meta.json'),
    JSON.stringify(meta, null, 2)
  );
  
  // Cleanup intermediate files (move to trash)
  const trashDir = join(PROJECT_ROOT, `.understand-anything/.trash-${Date.now()}`);
  mkdirSync(trashDir, { recursive: true });
  
  const intermediateDir = join(PROJECT_ROOT, '.understand-anything/intermediate');
  const tmpDir = join(PROJECT_ROOT, '.understand-anything/tmp');
  
  if (existsSync(intermediateDir)) {
    for (const file of readdirSync(intermediateDir)) {
      if (file !== 'scan-result.json') {
        // Move to trash (using rename)
        const src = join(intermediateDir, file);
        const dst = join(trashDir, file);
        try { require('node:fs').renameSync(src, dst); } catch {}
      }
    }
  }
  if (existsSync(tmpDir)) {
    const tmpTrash = join(trashDir, 'tmp');
    try { require('node:fs').renameSync(tmpDir, tmpTrash); } catch {}
  }
  
  console.log('[Phase 7] Complete!');
  console.log(`  Nodes: ${fullGraph.nodes.length}`);
  console.log(`  Edges: ${fullGraph.edges.length}`);
  console.log(`  Layers: ${fullGraph.layers.length}`);
  console.log(`  Tour steps: ${fullGraph.tour.length}`);
}

function getGitCommitHash() {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    return result.stdout.trim();
  } catch {
    return 'unknown';
  }
}

// Heuristic layer detection based on file paths and imports
function detectHeuristicLayers(fileNodes, importEdges, allEdges) {
  const layers = [];
  const layerMap = new Map();
  
  // Define layer rules based on path patterns
  const layerRules = [
    { name: 'contracts', patterns: ['src/', 'lib/', 'test/'], desc: 'Solidity smart contracts' },
    { name: 'swapvm', patterns: ['lib/swap-vm/'], desc: '1inch SwapVM core and instructions' },
    { name: 'aqua', patterns: ['lib/aqua/'], desc: '1inch Aqua protocol contracts' },
    { name: 'forge-std', patterns: ['lib/forge-std/'], desc: 'Forge standard library' },
    { name: 'frontend', patterns: ['frontend/'], desc: 'Next.js frontend application' },
    { name: 'cre-workflow', patterns: ['cre-workflow/'], desc: 'Chainlink CRE settlement workflow' },
    { name: 'docs', patterns: ['docs/'], desc: 'Documentation' },
    { name: 'config', patterns: ['.github/', 'foundry.toml', 'package.json', 'remappings.txt', 'skills-lock.json'], desc: 'Configuration files' },
  ];
  
  // Assign nodes to layers
  for (const node of fileNodes) {
    const path = node.filePath || '';
    let assigned = false;
    
    for (const rule of layerRules) {
      for (const pattern of rule.patterns) {
        if (path.startsWith(pattern)) {
          const layerId = `layer:${rule.name}`;
          if (!layerMap.has(layerId)) {
            layerMap.set(layerId, {
              id: layerId,
              name: rule.name,
              description: rule.desc,
              nodeIds: [],
            });
          }
          layerMap.get(layerId).nodeIds.push(node.id);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
    
    if (!assigned) {
      const layerId = 'layer:other';
      if (!layerMap.has(layerId)) {
        layerMap.set(layerId, {
          id: layerId,
          name: 'other',
          description: 'Miscellaneous files',
          nodeIds: [],
        });
      }
      layerMap.get(layerId).nodeIds.push(node.id);
    }
  }
  
  return Array.from(layerMap.values());
}

// Main
async function main() {
  console.log('=== Running Understand Anything Phases 2-7 ===\n');
  
  await runPhase2();
  await runPhase3();
  await runPhase4();
  await runPhase5();
  const fullGraph = await runPhase6();
  if (fullGraph) {
    await runPhase7(fullGraph);
  }
  
  console.log('\n=== All phases complete ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});