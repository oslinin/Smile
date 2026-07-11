#!/usr/bin/env node
/**
 * Convert extract-structure results to graph nodes/edges format
 * for merge-batch-graphs.py
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = '/home/ubuntu/projects/Smile';
const INTERMEDIATE_DIR = join(PROJECT_ROOT, '.understand-anything/intermediate');

function convertBatch(batchIndex) {
  const batchOutputPath = join(INTERMEDIATE_DIR, `batch-${batchIndex}.json`);
  const convertedPath = join(INTERMEDIATE_DIR, `batch-${batchIndex}-converted.json`);
  
  if (!existsSync(batchOutputPath)) {
    console.log(`Batch ${batchIndex}: No output file found`);
    return;
  }
  
  const batchOutput = JSON.parse(readFileSync(batchOutputPath, 'utf-8'));
  
  if (!batchOutput.results || !Array.isArray(batchOutput.results)) {
    console.log(`Batch ${batchIndex}: No results array`);
    return;
  }
  
  const nodes = [];
  const edges = [];
  const nodeIdSet = new Set();
  
  for (const result of batchOutput.results) {
    const filePath = result.path;
    const nodeId = `file:${filePath}`;
    
    // Create file node
    const fileNode = {
      id: nodeId,
      type: 'file',
      name: filePath.split('/').pop() || filePath,
      filePath: filePath,
      summary: `${result.language} file (${result.fileCategory}) - ${result.totalLines} lines`,
      tags: [result.language, result.fileCategory],
      complexity: 'simple',
    };
    
    if (!nodeIdSet.has(nodeId)) {
      nodes.push(fileNode);
      nodeIdSet.add(nodeId);
    }
    
    // Add functions as child nodes
    if (result.functions && Array.isArray(result.functions)) {
      for (const fn of result.functions) {
        const fnId = `function:${filePath}:${fn.name}`;
        if (!nodeIdSet.has(fnId)) {
          nodes.push({
            id: fnId,
            type: 'function',
            name: fn.name,
            filePath: filePath,
            summary: `Function ${fn.name} at lines ${fn.startLine}-${fn.endLine}`,
            tags: ['function'],
            complexity: 'simple',
          });
          nodeIdSet.add(fnId);
        }
        edges.push({
          source: nodeId,
          target: fnId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add classes as child nodes
    if (result.classes && Array.isArray(result.classes)) {
      for (const cls of result.classes) {
        const clsId = `class:${filePath}:${cls.name}`;
        if (!nodeIdSet.has(clsId)) {
          nodes.push({
            id: clsId,
            type: 'class',
            name: cls.name,
            filePath: filePath,
            summary: `Class ${cls.name} at lines ${cls.startLine}-${cls.endLine}`,
            tags: ['class'],
            complexity: 'simple',
          });
          nodeIdSet.add(clsId);
        }
        edges.push({
          source: nodeId,
          target: clsId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
        
        // Add methods
        if (cls.methods && Array.isArray(cls.methods)) {
          for (const method of cls.methods) {
            const methodId = `function:${filePath}:${cls.name}.${method}`;
            if (!nodeIdSet.has(methodId)) {
              nodes.push({
                id: methodId,
                type: 'function',
                name: `${cls.name}.${method}`,
                filePath: filePath,
                summary: `Method ${method} of class ${cls.name}`,
                tags: ['method', 'function'],
                complexity: 'simple',
              });
              nodeIdSet.add(methodId);
            }
            edges.push({
              source: clsId,
              target: methodId,
              type: 'contains',
              direction: 'directed',
              weight: 1.0,
            });
          }
        }
      }
    }
    
    // Add exports
    if (result.exports && Array.isArray(result.exports)) {
      for (const exp of result.exports) {
        const expId = `function:${filePath}:${exp.name}`;
        if (!nodeIdSet.has(expId)) {
          nodes.push({
            id: expId,
            type: 'function',
            name: exp.name,
            filePath: filePath,
            summary: `Exported ${exp.isDefault ? 'default ' : ''}function ${exp.name}`,
            tags: ['export', 'function'],
            complexity: 'simple',
          });
          nodeIdSet.add(expId);
        }
        edges.push({
          source: nodeId,
          target: expId,
          type: 'exports',
          direction: 'directed',
          weight: 0.8,
        });
      }
    }
    
    // Add sections (for non-code files)
    if (result.sections && Array.isArray(result.sections)) {
      for (const section of result.sections) {
        const secId = `concept:${filePath}:${section.heading}`;
        if (!nodeIdSet.has(secId)) {
          nodes.push({
            id: secId,
            type: 'concept',
            name: section.heading,
            filePath: filePath,
            summary: `Section: ${section.heading} (level ${section.level}) at line ${section.line}`,
            tags: ['section', `level-${section.level}`],
            complexity: 'simple',
          });
          nodeIdSet.add(secId);
        }
        edges.push({
          source: nodeId,
          target: secId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add definitions (types, interfaces, etc.)
    if (result.definitions && Array.isArray(result.definitions)) {
      for (const def of result.definitions) {
        const defId = `class:${filePath}:${def.name}`;
        if (!nodeIdSet.has(defId)) {
          nodes.push({
            id: defId,
            type: 'class',
            name: def.name,
            filePath: filePath,
            summary: `${def.kind} ${def.name} at lines ${def.startLine}-${def.endLine}`,
            tags: ['definition', def.kind],
            complexity: 'simple',
          });
          nodeIdSet.add(defId);
        }
        edges.push({
          source: nodeId,
          target: defId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add services (Docker, K8s)
    if (result.services && Array.isArray(result.services)) {
      for (const svc of result.services) {
        const svcId = `service:${filePath}:${svc.name}`;
        if (!nodeIdSet.has(svcId)) {
          nodes.push({
            id: svcId,
            type: 'service',
            name: svc.name,
            filePath: filePath,
            summary: `Service ${svc.name} (${svc.image || 'no image'})`,
            tags: ['service'],
            complexity: 'simple',
          });
          nodeIdSet.add(svcId);
        }
        edges.push({
          source: nodeId,
          target: svcId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add endpoints
    if (result.endpoints && Array.isArray(result.endpoints)) {
      for (const ep of result.endpoints) {
        const epId = `endpoint:${filePath}:${ep.method} ${ep.path}`;
        if (!nodeIdSet.has(epId)) {
          nodes.push({
            id: epId,
            type: 'endpoint',
            name: `${ep.method} ${ep.path}`,
            filePath: filePath,
            summary: `API endpoint ${ep.method} ${ep.path} at lines ${ep.startLine}-${ep.endLine}`,
            tags: ['endpoint', ep.method.toLowerCase()],
            complexity: 'simple',
          });
          nodeIdSet.add(epId);
        }
        edges.push({
          source: nodeId,
          target: epId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add steps (CI/CD)
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const stepId = `step:${filePath}:${step.name}`;
        if (!nodeIdSet.has(stepId)) {
          nodes.push({
            id: stepId,
            type: 'step',
            name: step.name,
            filePath: filePath,
            summary: `Pipeline step ${step.name} at lines ${step.startLine}-${step.endLine}`,
            tags: ['step'],
            complexity: 'simple',
          });
          nodeIdSet.add(stepId);
        }
        edges.push({
          source: nodeId,
          target: stepId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add resources (Terraform, etc.)
    if (result.resources && Array.isArray(result.resources)) {
      for (const res of result.resources) {
        const resId = `resource:${filePath}:${res.name}`;
        if (!nodeIdSet.has(resId)) {
          nodes.push({
            id: resId,
            type: 'resource',
            name: res.name,
            filePath: filePath,
            summary: `Resource ${res.kind} ${res.name} at lines ${res.startLine}-${res.endLine}`,
            tags: ['resource', res.kind],
            complexity: 'simple',
          });
          nodeIdSet.add(resId);
        }
        edges.push({
          source: nodeId,
          target: resId,
          type: 'contains',
          direction: 'directed',
          weight: 1.0,
        });
      }
    }
    
    // Add imports edges from metrics.importCount
    // We'll add generic import edges - the actual targets will be resolved by merge script
    if (result.metrics && result.metrics.importCount > 0) {
      // The merge script uses importMap to resolve actual import targets
      // We just mark that this file has imports
    }
  }
  
  // Deduplicate edges
  const edgeSet = new Set();
  const uniqueEdges = [];
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      uniqueEdges.push(edge);
    }
  }
  
  const output = {
    scriptCompleted: true,
    filesAnalyzed: batchOutput.filesAnalyzed,
    filesSkipped: batchOutput.filesSkipped,
    nodes: nodes,
    edges: uniqueEdges,
  };
  
  writeFileSync(convertedPath, JSON.stringify(output, null, 2));
  console.log(`Batch ${batchIndex}: Converted ${nodes.length} nodes, ${uniqueEdges.length} edges -> ${convertedPath}`);
}

// Convert all batches
for (let i = 1; i <= 12; i++) {
  convertBatch(i);
}

console.log('\nDone! Now run merge-batch-graphs.py');