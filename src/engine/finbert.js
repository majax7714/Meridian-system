// FinBERT Inference — TRC2 variant (BertForSequenceClassification)
// Thomson Reuters Corpus 2 fine-tune: positive / negative / neutral
//
// Runs fully in-process via onnxruntime-node. No Python at runtime.
// Model path: model/finbert/onnx/model.onnx
// Vocab path:  model/finbert/vocab.txt
//
// Usage:
//   const { classify, classifyBatch } = require('./finbert');
//   const r = await classify('Federal Reserve raises rates 50bps');
//   // { sentiment: 'negative', confidence: 0.87, positive: 0.05, negative: 0.87, neutral: 0.08 }

'use strict';

const fs   = require('fs');
const path = require('path');

const MODEL_DIR  = path.join(__dirname, '../../model/finbert');
const ONNX_PATH  = path.join(MODEL_DIR, 'onnx/model.onnx');
const VOCAB_PATH = path.join(MODEL_DIR, 'vocab.txt');

const MAX_SEQ_LEN = 128;   // 512 is model max; 128 is enough for headlines, 4x faster

// Label order matches config.json id2label: 0=positive 1=negative 2=neutral
const LABELS = ['positive', 'negative', 'neutral'];

// ─── Singleton session ─────────────────────────────────────────────────────────

let _session = null;
let _vocab   = null;
let _ort     = null;

async function getSession() {
  if (_session) return _session;

  if (!fs.existsSync(ONNX_PATH)) {
    throw new Error(
      `[FinBERT] ONNX model not found at ${ONNX_PATH}.\n` +
      `Run: node model/finbert/convert.js  to generate it.`
    );
  }

  _ort     = require('onnxruntime-node');
  _session = await _ort.InferenceSession.create(ONNX_PATH, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  });
  console.log('[FinBERT] ✅ ONNX session loaded');
  return _session;
}

// ─── Vocabulary ────────────────────────────────────────────────────────────────

function getVocab() {
  if (_vocab) return _vocab;
  const lines = fs.readFileSync(VOCAB_PATH, 'utf8').split('\n');
  _vocab = new Map();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].trim();
    if (tok) _vocab.set(tok, i);
  }
  return _vocab;
}

// ─── BERT WordPiece Tokenizer ─────────────────────────────────────────────────

// Basic tokenize: lowercase → split on whitespace and punctuation, keep ## prefixes intact.
// Matches bert-base-uncased do_lower_case=true behaviour.
function basicTokenize(text) {
  return text.toLowerCase()
    .replace(/[^\w\s'-]/g, ' $& ')  // pad punctuation except apostrophe/hyphen
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordpieceTokenize(word, vocab) {
  if (vocab.has(word)) return [word];

  const tokens = [];
  let start = 0;
  let isBad  = false;

  while (start < word.length) {
    let end = word.length;
    let curSubStr = null;

    while (start < end) {
      let subStr = word.slice(start, end);
      if (start > 0) subStr = '##' + subStr;
      if (vocab.has(subStr)) { curSubStr = subStr; break; }
      end--;
    }

    if (curSubStr == null) { isBad = true; break; }
    tokens.push(curSubStr);
    start = end;
  }

  return isBad ? ['[UNK]'] : tokens;
}

function tokenize(text, vocab) {
  const clsId = vocab.get('[CLS]');
  const sepId = vocab.get('[SEP]');
  const padId = vocab.get('[PAD]') ?? 0;
  const unkId = vocab.get('[UNK]') ?? 100;

  const words  = basicTokenize(text);
  const tokens = ['[CLS]'];

  for (const word of words) {
    const pieces = wordpieceTokenize(word, vocab);
    for (const p of pieces) {
      if (tokens.length >= MAX_SEQ_LEN - 1) break;  // leave room for [SEP]
      tokens.push(p);
    }
    if (tokens.length >= MAX_SEQ_LEN - 1) break;
  }
  tokens.push('[SEP]');

  // Convert to ids
  const inputIds    = tokens.map(t => vocab.get(t) ?? unkId);
  const attnMask    = new Array(inputIds.length).fill(1);
  const tokenTypeIds = new Array(inputIds.length).fill(0);

  // Pad to MAX_SEQ_LEN
  while (inputIds.length < MAX_SEQ_LEN) {
    inputIds.push(padId);
    attnMask.push(0);
    tokenTypeIds.push(0);
  }

  return { inputIds, attnMask, tokenTypeIds, seqLen: MAX_SEQ_LEN };
}

// ─── Softmax ──────────────────────────────────────────────────────────────────

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(x => x / sum);
}

// ─── Inference ────────────────────────────────────────────────────────────────

/**
 * Classify a single text string.
 *
 * @param {string} text
 * @returns {Promise<{ sentiment: 'positive'|'negative'|'neutral',
 *                     confidence: number,
 *                     positive: number, negative: number, neutral: number }>}
 */
async function classify(text) {
  const vocab   = getVocab();
  const session = await getSession();
  const ort     = _ort;

  const { inputIds, attnMask, tokenTypeIds, seqLen } = tokenize(text, vocab);

  // onnxruntime-node requires BigInt64Array for int64 inputs
  const toInt64 = arr => BigInt64Array.from(arr.map(BigInt));

  const feeds = {
    input_ids:      new ort.Tensor('int64', toInt64(inputIds),     [1, seqLen]),
    attention_mask: new ort.Tensor('int64', toInt64(attnMask),     [1, seqLen]),
    token_type_ids: new ort.Tensor('int64', toInt64(tokenTypeIds), [1, seqLen])
  };

  const output  = await session.run(feeds);
  const logits  = Array.from(output.logits.data);   // [pos, neg, neutral]
  const probs   = softmax(logits);

  const maxIdx  = probs.indexOf(Math.max(...probs));

  return {
    sentiment:  LABELS[maxIdx],
    confidence: parseFloat(probs[maxIdx].toFixed(4)),
    positive:   parseFloat(probs[0].toFixed(4)),
    negative:   parseFloat(probs[1].toFixed(4)),
    neutral:    parseFloat(probs[2].toFixed(4))
  };
}

/**
 * Classify multiple texts. Runs sequentially (BERT inference is already fast).
 *
 * @param {string[]} texts
 * @returns {Promise<Array<ReturnType<classify>>>}
 */
async function classifyBatch(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await classify(text));
  }
  return results;
}

/**
 * Pre-warm the ONNX session (call once at startup to avoid cold-start latency).
 */
async function warmup() {
  try {
    await classify('market open');
    console.log('[FinBERT] ✅ Warmup complete');
  } catch (e) {
    console.warn('[FinBERT] Warmup skipped:', e.message);
  }
}

module.exports = { classify, classifyBatch, warmup };
