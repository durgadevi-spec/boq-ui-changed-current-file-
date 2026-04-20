const fs = require('fs');
const path = require('path');

const ROUTES_FILE = path.join(__dirname, 'server/routes.ts');
const ROUTES_DIR = path.join(__dirname, 'server/routes');

if (!fs.existsSync(ROUTES_DIR)) {
  fs.mkdirSync(ROUTES_DIR);
}

// domains mapping: string match to folder
const DOMAINS = {
  materials: [
    '/api/materials', 
    '/api/material-templates', 
    '/api/material-rate',
    '/api/materials-pending-approval'
  ],
  projects: [
    '/api/projects',
    '/api/boq-projects'
  ],
  shops: [
    '/api/shops',
    '/api/vendor-categories',
    '/api/vendors',
    '/api/shops-pending-approval'
  ],
  boms: [
    '/api/boq-versions',
    '/api/boq_versions',
    '/api/boq-items',
    '/api/boq-pricing',
    '/api/estimator',
    '/api/bom',
    '/api/final-boq'
  ],
  sketch: [
    '/api/sketch-plans',
    '/api/sketch-plan-items',
    '/api/sketch-templates'
  ]
};

// block format from previous step
const blocksFile = fs.readFileSync('blocks.json', 'utf8');
const blocks = JSON.parse(blocksFile);

let routesLines = fs.readFileSync(ROUTES_FILE, 'utf8').split('\n');
let replacedDomainUse = {};

// We process from bottom to top so indices don't shift when deleting!
const sortedBlocks = blocks.sort((a, b) => b.start - a.start);

const domainSourceMap = {};

for (const block of sortedBlocks) {
  // block.content looks like: app.get("/api/materials", ...
  let match = block.content.match(/^  app\.(get|post|put|delete|patch)\((['"`])(\/api\/[^\/"'?]+)/);
  if (!match) continue;
  
  let endpoint = match[3];
  
  let domainFound = null;
  for (const [domain, prefixes] of Object.entries(DOMAINS)) {
    if (prefixes.some(p => endpoint.startsWith(p))) {
      domainFound = domain;
      break;
    }
  }

  if (domainFound) {
    if (!domainSourceMap[domainFound]) domainSourceMap[domainFound] = [];
    
    // Extract lines
    let snippet = routesLines.slice(block.start - 1, block.end);
    
    // Convert app. to router.
    snippet[0] = snippet[0].replace(/^  app\./, 'router.');
    
    // Remove from original, replace with a marker or app.use if it is the topmost one.
    // Since we go bottom up, the last one we process for a domain is the "topmost".
    routesLines.splice(block.start - 1, block.end - block.start + 1);
    
    // Add to domain source
    domainSourceMap[domainFound].unshift(snippet.join('\n'));
    replacedDomainUse[domainFound] = block.start - 1; // Will keep the minimum (topmost index)
  }
}

// Generate the new router files and prepare to insert app.use
let importsToAdd = [];

for (const [domain, snippets] of Object.entries(domainSourceMap)) {
  const routerFile = path.join(ROUTES_DIR, `${domain}.ts`);
  let content = `import { Router, Request, Response } from "express";\n`;
  content += `import { query } from "../db/client";\n`;
  content += `import { authMiddleware, requireRole } from "../middleware";\n`;
  content += `import { storage } from "../storage";\n`;
  content += `import { randomUUID } from "crypto";\n`;
  content += `import { sendSketchPlanEmail, sendSiteReportEmail, sendProposalStatusEmail } from "../email";\n`;
  content += `import fs from "fs";\n\n`;
  content += `const router = Router();\n\n`;
  
  content += snippets.join('\n\n');
  content += `\n\nexport default router;\n`;
  
  fs.writeFileSync(routerFile, content);
  
  importsToAdd.push(`import ${domain}Router from "./routes/${domain}";`);
  
  // Insert the app.use at the topmost position we deleted from
  let useIdx = replacedDomainUse[domain];
  routesLines.splice(useIdx, 0, `  app.use(${domain}Router);`);
}

// Add imports
const insertImportIdx = routesLines.findIndex(l => l.includes('import authRouter'));
if (insertImportIdx >= 0) {
  routesLines.splice(insertImportIdx + 1, 0, ...importsToAdd);
} else {
  routesLines.unshift(...importsToAdd);
}

fs.writeFileSync(ROUTES_FILE, routesLines.join('\n'));

console.log('Successfully refactored domains: ' + Object.keys(domainSourceMap).join(', '));
