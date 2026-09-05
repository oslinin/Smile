import { detectLayers, generateHeuristicTour, validateGraph, autoFixGraph } from '/home/ubuntu/.understand-anything-plugin/packages/core/dist/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const graph = JSON.parse(readFileSync('/home/ubuntu/projects/Smile/.understand-anything/intermediate/assembled-graph.json', 'utf-8'));

// Build a proper KnowledgeGraph object
const knowledgeGraph = {
  version: '1.0.0',
  project: {
    name: 'Smile',
    description: 'A non-custodial, parametric options marketplace',
    languages: ['solidity', 'typescript', 'javascript', 'yaml', 'markdown', 'json', 'toml', 'shell'],
    frameworks: ['foundry', 'uniswap-v4', '1inch-aqua', 'nextjs', 'wagmi', 'viem', 'chainlink-cre'],
    analyzedAt: new Date().toISOString(),
    gitCommitHash: 'unknown'
  },
  nodes: graph.nodes,
  edges: graph.edges,
  layers: [],
  tour: []
};

console.log('Nodes:', knowledgeGraph.nodes.length);

// Detect layers - pass the full knowledge graph
const layers = detectLayers(knowledgeGraph);
console.log('Layers detected:', layers.length);
for (const layer of layers) {
  console.log('  ', layer.id, layer.name, '(', layer.nodeIds.length, 'nodes )');
}

// Add layers to the graph for tour generation
knowledgeGraph.layers = layers;

// Generate tour - pass the full knowledge graph
const tour = generateHeuristicTour(knowledgeGraph);
console.log('Tour steps:', tour.length);

// Add to full graph
const fullGraph = {
  ...knowledgeGraph,
  layers,
  tour
};

// Validate and fix
const validation = validateGraph(fullGraph);
console.log('Validation:', validation);

if (validation?.issues?.length > 0) {
  const fixed = autoFixGraph(fullGraph);
  console.log('Fixed', fixed.fixesApplied, 'issues');
  Object.assign(fullGraph, fixed.graph);
}

// Save
writeFileSync('/home/ubuntu/projects/Smile/.understand-anything/intermediate/layers.json', JSON.stringify(layers, null, 2));
writeFileSync('/home/ubuntu/projects/Smile/.understand-anything/intermediate/tour.json', JSON.stringify(tour, null, 2));
writeFileSync('/home/ubuntu/projects/Smile/.understand-anything/knowledge-graph.json', JSON.stringify(fullGraph, null, 2));

console.log('\nSaved: layers.json, tour.json, knowledge-graph.json');