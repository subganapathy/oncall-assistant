# On-Call Assistant

An MCP server that gives Claude the tools to debug your services.

## What You Get

Ask Claude things like:
- "Debug ord-1234" → finds owner, checks health, queries logs, diagnoses
- "Why is user-service slow?" → checks metrics, deploys, dependencies
- "What broke?" → correlates alerts with recent changes

The AI figures out which tools to use. You just describe the problem.

## Two Interfaces

| Interface | How It Works |
|-----------|--------------|
| **Claude CLI** | Engineer types "Debug ord-1234" → Claude calls tools → diagnosis |
| **Slack Bot** | Alert fires → bot auto-diagnoses → posts to thread |

Both share the same backend: service catalog, resource handlers, observability.

## Quick Start (Try It Out)

```bash
git clone https://github.com/subganapathy/oncall-assistant
cd oncall-assistant
npm install
npm run build

# Start mock resource API
npx tsx scripts/mock-resource-api.ts

# In another terminal, add to ~/.claude.json:
{
  "mcpServers": {
    "oncall-assistant": {
      "command": "node",
      "args": ["/path/to/oncall-assistant/dist/index.js"],
      "env": { "BACKEND_MODE": "mock" }
    }
  }
}

# Then
claude
> Debug ord-1234
```

## Production Setup

### 1. Deploy the Service

Deploy oncall-assistant to your infrastructure with env vars pointing to your backends:

```bash
DATABASE_URL=postgres://...      # Service catalog
PROMETHEUS_URL=https://...       # Metrics
OPENSEARCH_URL=https://...       # Logs
KUBERNETES_API_URL=https://...   # K8s
GITHUB_TOKEN=...                 # Deploy history
```

### 2. Register Services via GitHub App

Set up a GitHub App (or org-level webhook) that fires on push to main. When a team adds `service.yaml` to their repo, the webhook syncs it to the catalog.

**One-time setup (platform team):**
1. Create GitHub App or org webhook
2. Point at `https://oncall-assistant.internal/webhooks/github`

**Per-service setup (service team):**
1. Add `service.yaml` to repo root
2. Merge to main
3. Done - service appears in catalog

### 3. Connect Slack

Create a Slack app with:
- Bot token scopes: `chat:write`, `channels:history`, `commands`
- Slash command: `/diagnose`
- Event subscription for messages

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
```

Invite the bot to alert channels. It will:
- Auto-respond to messages containing "FIRING" or "alert"
- Support `/diagnose service-name` from anywhere

### 4. Claude CLI (Remote)

Engineers can use Claude CLI without local setup:

```json
{
  "mcpServers": {
    "oncall-assistant": {
      "url": "https://oncall-assistant.company.com/mcp",
      "headers": { "Authorization": "Bearer ${ONCALL_TOKEN}" }
    }
  }
}
```

## The service.yaml Format

Each service defines its catalog entry:

```yaml
name: order-service
team: commerce
slack_channel: "#commerce-oncall"
pager_alias: commerce-escalation
description: "System of record for customer orders"

dependencies:
  - name: user-service
    type: internal
    critical: true
  - name: postgres-orders
    type: database
    aws_hosted: true          # RDS - check AWS Health during incidents
  - name: redis-cache
    type: database
    aws_hosted: false         # Self-hosted

# Resources this service is the system of record for.
# Only include resources that this service creates/owns.
# Do NOT include resources you just read/use from other services.
resources:
  - pattern: "ord-*"
    type: order
    description: "Customer order"
    handler_url: "https://order-service.internal/api/resources/${id}"

observability:
  grafana_uid: order-service-prod
  opensearch_index: prod-order-*
  prometheus_job: order-service
```

## Understanding Resources vs Services

This is important:

- **Service** = the code that runs (order-service, user-service)
- **Resource** = the things a service creates/owns (ord-1234, usr-5678)

When you say "Debug ord-1234":
1. AI finds which service owns `ord-*` pattern → order-service
2. AI calls `handler_url` to get live status → PENDING, error: "DB timeout"
3. AI checks order-service's dependencies, logs, pods
4. AI diagnoses the issue

**Only list resources your service is the system of record for.** If order-service reads from user-service, don't list `usr-*` in order-service's resources.

## The BYO Resource Interface

The killer feature: teams expose a simple REST endpoint, and the AI can debug any resource.

**Step 1: Expose your resource API**

```
GET /api/resources/ord-1234
{
  "id": "ord-1234",
  "status": "PENDING",
  "created_at": "2024-01-10T10:00:00Z",
  "customer_id": "cust-789",
  "namespace": "orders-us-east",
  "cluster": "prod-us-east-1",
  "error": "Database connection timeout after 30s"
}
```

Return whatever is useful for debugging. The AI will interpret it.

**Step 2: Add handler_url to service.yaml**

```yaml
resources:
  - pattern: "ord-*"
    type: order
    handler_url: "https://order-service.internal/api/resources/${id}"
```

That's it. No code changes to oncall-assistant needed.

## Available Tools

The AI has these tools and decides which to use:

| Tool | What It Does |
|------|--------------|
| `get_service_catalog` | Full service info (team, deps, observability) |
| `list_services` | All services, optionally by team |
| `get_dependencies` | What a service depends on |
| `get_dependents` | What depends on a service |
| `get_escalation_path` | Slack channel, pager alias |
| `get_resource` | **BYO interface** - resource status + owner context |
| `find_resource_owner` | Quick lookup: who owns this resource? |
| `get_service_health` | Error rate, latency, availability |
| `get_recent_deploys` | Recent deployments (correlate with issues) |
| `query_logs` | Search logs for errors |
| `get_pod_status` | Kubernetes pod health |
| `check_dependency_health` | Are upstream services healthy? |
| `scan_log_patterns` | Find known error patterns (OOM, panics) |
| `get_pod_logs` | Direct pod logs (for crashes) |
| `check_aws_health` | AWS outages affecting your dependencies |
| `check_runtime_metrics` | JVM/Go runtime metrics |

## Testing

### Mock Mode

```bash
# Start mock resource API
npx tsx scripts/mock-resource-api.ts

# Available test resources:
#   - ord-1234 (PENDING, DB timeout error)
#   - usr-1234 (ACTIVE)
#   - tok-abc123 (VALID)
#   - sess-xyz789 (ACTIVE)
```

### E2E Agent Test

Test the full agentic loop (Claude calling tools iteratively):

```bash
ANTHROPIC_API_KEY=... npx tsx scripts/test-e2e-agent.ts ord-1234
```

Output:
```
--- Iteration 1 ---
  [Tool] get_resource({"resource_id":"ord-1234"})

--- Iteration 2 ---
  [Tool] get_dependencies({"service":"order-service"})

--- Iteration 3 ---
  Stop reason: end_turn

## Diagnosis for ord-1234
- Status: PENDING (stuck for 30+ minutes)
- Error: Database connection timeout
- Root Cause: Database connectivity problems
- Action: Check database health, verify connection pool
```

## Development

```bash
npm test          # run tests
npm run build     # compile typescript
npm run dev       # watch mode
```

## License

MIT
