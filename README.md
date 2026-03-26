# LinkedIn Prospection MCP

MCP server for LinkedIn prospection automation — find leads, score (fit+intent+urgency), qualify, personalize messages, run full pipeline, manage sales funnel.

## Installation

```bash
npx linkedin-prospection-mcp
```

Or install globally:

```bash
npm install -g linkedin-prospection-mcp
```

## Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "linkedin-prospection": {
      "command": "npx",
      "args": ["-y", "linkedin-prospection-mcp"],
      "env": {
        "PROSPECTION_DIR": "/path/to/your/prospection/scripts"
      }
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "linkedin-prospection": {
      "command": "npx",
      "args": ["-y", "linkedin-prospection-mcp"],
      "env": {
        "PROSPECTION_DIR": "/path/to/your/prospection/scripts"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `find_leads` | Search LinkedIn for leads matching burnout/stress signals |
| `score_lead` | Score a single lead (fit 0-30 + intent 0-40 + urgency 0-30 = /100) |
| `qualify_leads` | Batch qualify leads with P1-P4 priority classification |
| `personalize_message` | Generate personalized invitation notes and DM sequences |
| `run_pipeline` | Run the full daily prospection pipeline |
| `get_pipeline_status` | Get current pipeline status and daily log |
| `manage_lead` | Update lead status in the pipeline |

## Resources

- `linkedin-prospection://daily-log` — Today's prospection log
- `linkedin-prospection://leads` — All discovered leads

## Prompts

- `daily_prospection` — Guided daily prospection workflow (full or quick mode)

## Scoring Engine

Leads are scored on three axes:

- **Fit (0-30)**: Role match, industry risk, seniority
- **Intent (0-40)**: Burnout keywords, stress signals, help-seeking language
- **Urgency (0-30)**: Recency, crisis indicators, explicit requests

Priority classification:
- **P1-hot** (70+): Immediate outreach
- **P2-warm** (50-69): Nurture sequence
- **P3-nurture** (30-49): Long-term follow-up
- **P4-cold** (<30): Archive

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROSPECTION_DIR` | Path to prospection scripts directory | `./lib/prospection` |

## License

MIT
