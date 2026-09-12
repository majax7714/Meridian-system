// Claude API client — replaces callClaudeAPI / queryClaudeChat in background.js

const fetch = require('node-fetch');
const config = require('../../config');

const API_URL = 'https://api.anthropic.com/v1/messages';

async function chat(prompt, maxTokens) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.claude.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.claude.model,
      max_tokens: maxTokens || config.claude.maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * Chat with bar data included in the prompt.
 * bars: { bars15m, bars5m, bars1m, bars1s }
 */
async function chatWithBars(prompt, bars) {
  const barSummary = formatBarsForPrompt(bars);
  const fullPrompt = `${prompt}\n\n${barSummary}`;
  return chat(fullPrompt);
}

function formatBarsForPrompt(bars) {
  const lines = [];
  if (bars['15m'] && bars['15m'].length) {
    lines.push(`15-MINUTE BARS (${bars['15m'].length} bars, newest last):`);
    bars['15m'].slice(-10).forEach(b =>
      lines.push(`  ${b.time || b.timestamp} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`)
    );
  }
  if (bars['5m'] && bars['5m'].length) {
    lines.push(`5-MINUTE BARS (${bars['5m'].length} bars, newest last):`);
    bars['5m'].slice(-20).forEach(b =>
      lines.push(`  ${b.time || b.timestamp} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`)
    );
  }
  if (bars['1m'] && bars['1m'].length) {
    lines.push(`1-MINUTE BARS (${bars['1m'].length} bars, newest last):`);
    bars['1m'].slice(-30).forEach(b =>
      lines.push(`  ${b.time || b.timestamp} O:${b.open} H:${b.high} L:${b.low} C:${b.close} V:${b.volume}`)
    );
  }
  return lines.join('\n');
}

module.exports = { chat, chatWithBars };
