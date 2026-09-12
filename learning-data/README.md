# Learning Data Storage

This directory contains **permanent learning data** that persists across all extension updates, resets, and agent model changes.

## Files

- `time-based.json` - Session patterns, liquidity changes, time-of-day effects
- `macro-events.json` - FOMC, CPI, earnings, economic data impacts  
- `general-knowledge.json` - Psychology, strategy refinements, general observations

## Format

Each file contains:
```json
{
  "category": "time|macro|general",
  "description": "Category description",
  "insights": [
    {
      "id": 1734323400000,
      "timestamp": "2024-12-15T22:30:00Z",
      "summary": "Asia session shows lower liquidity...",
      "usageCount": 5
    }
  ]
}
```

## How It Works

1. **User adds insight** via Learning tab
2. **AI summarizes** the observation
3. **Saved to both:**
   - Chrome storage (temporary, for UI display)
   - JSON file (permanent, survives everything)
4. **On extension load:**
   - Reads JSON files
   - Merges with Chrome storage
   - AI has access to all learning

## Backup & Restore

**Export Learning:**
- Copy these JSON files to backup location
- All your trading knowledge preserved

**Restore Learning:**
- Replace JSON files with backup copies
- Reload extension
- All learning restored!

## Editing Manually

You can edit these JSON files directly to:
- Add learning from other sources
- Remove outdated insights
- Organize knowledge
- Bulk import trading rules

**IMPORTANT:** Keep valid JSON format or extension may fail to load learning.

## Why This Matters

**Without file storage:**
- Learning lost on extension reset
- Lost if Chrome storage cleared
- Gone when switching browsers
- New agent models start empty

**With file storage:**
- Learning NEVER lost
- Survives all resets
- Portable across systems
- Agent always has your wisdom
- Can version control your trading knowledge!

## Integration

The AI automatically loads learning from these files on every:
- Extension initialization
- Page reload
- Agent model switch
- Manual refresh

Your trading intelligence is now **permanent and portable**! 🚀
