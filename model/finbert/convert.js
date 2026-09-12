#!/usr/bin/env node
// One-time ONNX conversion for FinBERT TRC2.
// Calls Python optimum-cli — run this once, then model/finbert/onnx/model.onnx is permanent.
//
// Usage: node model/finbert/convert.js

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const MODEL_DIR = path.join(__dirname);
const ONNX_DIR  = path.join(__dirname, 'onnx');
const ONNX_FILE = path.join(ONNX_DIR, 'model.onnx');

if (fs.existsSync(ONNX_FILE)) {
  console.log(`✅  ONNX model already exists at ${ONNX_FILE}`);
  console.log('    Delete it and rerun to reconvert.');
  process.exit(0);
}

console.log('Converting FinBERT TRC2 → ONNX...');
console.log(`  Source: ${MODEL_DIR}`);
console.log(`  Output: ${ONNX_DIR}`);

try {
  // Check optimum-cli is available
  execSync('optimum-cli --version', { stdio: 'pipe' });
} catch {
  console.error(
    '\n❌  optimum-cli not found.\n' +
    '    Run: pip3 install "optimum[onnxruntime]" transformers torch\n'
  );
  process.exit(1);
}

try {
  execSync(
    `optimum-cli export onnx \
      --model "${MODEL_DIR}" \
      --task text-classification \
      --opset 14 \
      "${ONNX_DIR}"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error('\n❌  Conversion failed:', e.message);
  process.exit(1);
}

if (!fs.existsSync(ONNX_FILE)) {
  console.error('\n❌  Conversion appeared to succeed but model.onnx not found.');
  console.log('    Files in onnx/:', fs.readdirSync(ONNX_DIR));
  process.exit(1);
}

const sizeMB = (fs.statSync(ONNX_FILE).size / 1e6).toFixed(1);
console.log(`\n✅  ONNX model written: ${ONNX_FILE} (${sizeMB} MB)`);
console.log('\nYou can now delete model/finbert/pytorch_model.bin to save 418 MB.');
console.log('The ONNX model is all that is needed at runtime.\n');
