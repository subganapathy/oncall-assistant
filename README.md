# On-Call Assistant

An MCP server that gives Claude the tools to debug your services.

## What You Get

Ask Claude things like:
- "Debug ord-1234" → finds owner, checks health, queries logs, diagnoses
- "Why is user-service slow?" → checks metrics, deploys, dependencies
- "What broke?" → correlates alerts with recent changes

The AI figures out which tools to use. You just describe the problem.

## How You Use It

- **Interactive**: Ask Claude "Debug ord-1234" via Claude Code → Claude calls tools → you get a diagnosis
- **Automated**: Slack bot watches alert channels → auto-diagnoses when alerts fire → posts to thread

## Core Concepts

**Service** = A microservice in your infrastructure (order-service, user-service, auth-service)

**Service Catalog** = A database of all your services with metadata:
- Who owns it (team, Slack channel, pager)
- What it depends on (other services, databases)
- Where to find logs and metrics (Grafana, OpenSearch, Prometheus)
- What resources it manages

**Resource** = Something a service is the system of record for (ord-1234, usr-5678). When you say "debug ord-1234", the AI looks up which service is authoritative for `ord-*` resources, then investigates that service.

The AI uses the service catalog to understand your infrastructure. Without it, Claude has no idea what "order-service" is or where to look for logs.

## How Services Get Registered

Every service team adds a `service.yaml` to their repo:

```
github.com/acme/order-service/
├── src/
├── deploy/
└── service.yaml    ← defines this service in the catalog
```

When merged to main, a GitHub webhook syncs it to the catalog. No manual registration needed.

## Production Setup

### 1. Deploy the Assistant

Deploy oncall-assistant to your infrastructure with env vars pointing to your backends:

```bash
ANTHROPIC_API_KEY=sk-ant-...     # For Claude API calls
DATABASE_URL=postgres://...      # Service catalog
PROMETHEUS_URL=https://...       # Metrics
OPENSEARCH_URL=https://...       # Logs
KUBERNETES_API_URL=https://...   # K8s
GITHUB_TOKEN=...                 # Deploy history + webhook
```

### 2. Set Up GitHub Webhook

Set up a GitHub App (or org-level webhook) that fires on push to main.

**One-time setup (platform team):**
1. Create GitHub App or org webhook
2. Point at `https://oncall-assistant.internal/webhooks/github`

**Per-service setup (each service team):**
1. Create `service.yaml` in their repo root (see format below)
2. Merge to main
3. Done - service appears in catalog automatically

This is the key step for service teams. Without `service.yaml`, the on-call assistant doesn't know about their service.

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

## Quick Start (Try It Locally)

Want to try it before deploying? Run with mock data:

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

## How Resource Debugging Works

When you say "Debug ord-1234":
1. AI finds which service owns `ord-*` pattern → order-service
2. AI calls `handler_url` to get live status → PENDING, error: "DB timeout"
3. AI checks order-service's dependencies, logs, pods
4. AI diagnoses the issue

**Important**: Only list resources your service is the system of record for. If order-service reads from user-service, don't list `usr-*` in order-service's resources.

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

## What's Not Done

This is a working prototype. Here's what's missing for production use:

**Cost Optimization**
- No model routing - always uses the same model regardless of query complexity
- No caching of tool results - repeated queries hit backends every time
- No batching of similar requests
- Simple queries ("who owns order-service?") use the same resources as complex diagnosis

**Reliability**
- No retry logic with exponential backoff for backend calls
- No circuit breakers for failing backends
- No rate limiting on the webhook endpoint
- No dead letter queue for failed webhook processing

**Observability**
- No metrics on tool usage, latency, or error rates
- No tracing of the agent loop
- No cost tracking per diagnosis

**Security**
- Basic API key auth only - no OAuth, JWT, or RBAC
- No audit logging of who ran what diagnosis
- handler_url calls don't verify SSL certificates in dev mode

**Scale**
- Single Postgres instance for catalog
- No connection pooling for handler_url calls
- Webhook handler is synchronous (blocks on GitHub API + DB)

These are solvable problems. The architecture supports them - they just aren't implemented yet.

## License

MIT
