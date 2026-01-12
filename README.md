# On-Call Assistant

AI-powered on-call assistant that automatically diagnoses incidents using Claude and MCP.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SLACK                                    │
│  Alert fires → Bot detects → Agent diagnoses → Posts response  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    AGENT LAYER                                  │
│                                                                 │
│  Slack Handler → Agent SDK → Claude → MCP Tools → Diagnosis   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MCP SERVER                                   │
│                                                                 │
│  Tools:                                                         │
│  • get_service_catalog    • get_service_health                 │
│  • get_dependencies       • get_recent_deploys                 │
│  • get_escalation_path    • query_logs                         │
│  • check_dependency_health • get_pod_status                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DATA LAYER                                   │
│                                                                 │
│  PostgreSQL (Catalog) ← REST API ← GitHub Actions/ArgoCD       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Start the database

```bash
docker-compose up -d postgres
```

### 2. Run migrations and seed data

```bash
npm install
npm run db:migrate
npm run db:seed
```

### 3. Start the API server

```bash
npm run dev:api
```

### 4. Test with Claude CLI

Register the MCP server in your Claude config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "oncall-assistant": {
      "command": "npx",
      "args": ["tsx", "/path/to/oncall-assistant/src/index.ts"],
      "env": {
        "PGHOST": "localhost",
        "PGPORT": "5432",
        "PGDATABASE": "oncall",
        "PGUSER": "oncall",
        "PGPASSWORD": "oncall"
      }
    }
  }
}
```

Then in Claude:

```
> Check health of user-service
> What services depend on auth-service?
> Diagnose: user-service has high error rate
```

## Project Structure

```
oncall-assistant/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── api/
│   │   └── server.ts         # REST API for catalog management
│   ├── handlers/
│   │   └── slack.ts          # Slack bot + Agent SDK integration
│   ├── tools/
│   │   ├── catalog.ts        # Catalog query tools
│   │   └── diagnostics.ts    # Health/logs/deploy tools
│   └── lib/
│       ├── types.ts          # TypeScript interfaces
│       └── db.ts             # Database utilities
├── scripts/
│   ├── migrate.ts            # Database migrations
│   └── seed.ts               # Test data seeding
├── test/
│   ├── setup.ts              # Test configuration
│   └── unit/                 # Unit tests
├── docker-compose.yml        # Local development services
└── package.json
```

## Available Tools (MCP)

| Tool | Description |
|------|-------------|
| `get_service_catalog` | Get full catalog entry for a service |
| `list_services` | List all services (optionally by team) |
| `get_dependencies` | Get what a service depends on |
| `get_dependents` | Get what depends on a service |
| `get_escalation_path` | Get pager alias and slack channel |
| `get_service_health` | Get current metrics (error rate, latency) |
| `get_recent_deploys` | Get recent deployments from ArgoCD |
| `query_logs` | Search logs in OpenSearch |
| `get_pod_status` | Get Kubernetes pod status |
| `check_dependency_health` | Check health of all dependencies |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/services` | List all services |
| GET | `/api/services/:name` | Get service by name |
| POST | `/api/services` | Create service |
| PATCH | `/api/services/:name` | Update service |
| DELETE | `/api/services/:name` | Delete service |
| POST | `/api/deployments` | Record deployment |
| GET | `/api/deployments/:service` | Get deployments |
| POST | `/webhooks/argocd` | ArgoCD webhook |
| POST | `/webhooks/github` | GitHub webhook |

## Usage Examples

### Add a service via API

```bash
curl -X POST http://localhost:3000/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "name": "payment-service",
    "team": "payments",
    "slack_channel": "#payments-oncall",
    "pager_alias": "payments-escalation",
    "observability": {
      "grafana_uid": "payment-service-prod",
      "opensearch_index": "prod-payment-*"
    },
    "dependencies": [
      {"name": "user-service", "type": "internal", "critical": true},
      {"name": "stripe", "type": "external", "critical": true}
    ]
  }'
```

### Update dependencies via GitHub Actions

```yaml
# .github/workflows/update-catalog.yml
name: Update Service Catalog
on:
  push:
    paths:
      - 'k8s/manifests/**'

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Update catalog
        run: |
          curl -X PATCH "${{ secrets.CATALOG_API_URL }}/api/services/my-service" \
            -H "X-API-Key: ${{ secrets.CATALOG_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{"dependencies": [...]}'
```

### Use with Claude CLI

```bash
# Start a conversation with the MCP server
claude

# Ask about services
> What team owns user-service?
> Is user-service healthy right now?
> Were there any recent deploys to user-service?
> What would break if auth-service went down?
```

## Development

### Run tests

```bash
npm test                    # Unit tests
npm run test:watch          # Watch mode
npm run test:integration    # Integration tests
```

### Type checking

```bash
npm run typecheck
```

### Build for production

```bash
npm run build
```

## Extending

### Add a new tool

1. Create the tool function in `src/tools/`:

```typescript
// src/tools/mytool.ts
export const myToolSchema = {
    service: z.string().describe("Service name"),
};

export async function myTool(input: { service: string }): Promise<string> {
    // Implementation
    return JSON.stringify({ result: "..." });
}
```

2. Register it in `src/index.ts`:

```typescript
import { myTool, myToolSchema } from "./tools/mytool.js";

server.tool(
    "my_tool",
    "Description of what this tool does",
    myToolSchema,
    async (input) => ({
        content: [{ type: "text", text: await myTool(input) }],
    })
);
```

### Connect real backends

Replace the mock implementations in `src/tools/diagnostics.ts`:

```typescript
// Instead of mock data, call real Prometheus:
export async function getServiceHealth(input: { service: string }) {
    const promQL = `sum(rate(http_requests_total{service="${input.service}"}[5m]))`;
    const result = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promQL)}`);
    // ... process result
}
```

## License

MIT
