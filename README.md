# On-Call Assistant

An MCP server that gives Claude the tools to debug your services.

## What You Get

Ask Claude things like:
- "Debug ord-1234" → finds owner, checks health, queries logs, diagnoses
- "Why is user-service slow?" → checks metrics, deploys, dependencies
- "What broke?" → correlates alerts with recent changes

The AI figures out which tools to use. You just describe the problem.

## Setup (5 minutes)

### 1. Install

```bash
git clone https://github.com/subganapathy/oncall-assistant
cd oncall-assistant
npm install
npm run build
```

### 2. Add to Claude

Add to your `~/.claude.json` under `projects`:

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "oncall-assistant": {
          "command": "node",
          "args": ["/path/to/oncall-assistant/dist/index.js"],
          "env": {
            "BACKEND_MODE": "mock"
          }
        }
      }
    }
  }
}
```

Or create `.mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "oncall-assistant": {
      "command": "node",
      "args": ["/path/to/oncall-assistant/dist/index.js"],
      "env": {
        "BACKEND_MODE": "mock"
      }
    }
  }
}
```

### 3. Use It

```bash
claude  # start Claude in your project directory
```

Then:
```
> Debug ord-1234
> Is user-service healthy?
> What depends on auth-service?
```

## Adding Your Services

### Option 1: Service Catalog (in database)

Each service needs an entry with:
- **name** - service identifier
- **team** - owning team
- **slack_channel** - where to escalate
- **dependencies** - what it depends on
- **resources** - what resource patterns it owns (for BYO interface)

```json
{
  "name": "order-service",
  "team": "commerce",
  "slack_channel": "#commerce-oncall",
  "pager_alias": "commerce-escalation",
  "description": "System of record for customer orders",
  "dependencies": [
    { "name": "user-service", "type": "internal", "critical": true },
    { "name": "postgres-orders", "type": "database", "critical": true }
  ],
  "resources": [
    {
      "pattern": "ord-*",
      "type": "order",
      "description": "Customer order. Common issues: stuck in PENDING when inventory is slow."
    }
  ],
  "observability": {
    "grafana_uid": "order-service-prod",
    "opensearch_index": "prod-order-*",
    "prometheus_job": "order-service"
  }
}
```

### Option 2: Mock Mode (for testing)

Set `BACKEND_MODE=mock` and edit `src/lib/db.ts` to add your services to `MOCK_SERVICES`.

## The BYO Resource Interface

The killer feature: when someone asks "debug ord-1234", the AI needs to know:
1. Which service owns `ord-*` resources?
2. What's the current status of this specific resource?

### How It Works

**Step 1: Declare ownership in catalog**

Your service's catalog entry declares what resource patterns it owns:

```json
{
  "name": "order-service",
  "resources": [
    {
      "pattern": "ord-*",
      "type": "order",
      "description": "Customer order. Lifecycle: PENDING → PROCESSING → SHIPPED"
    }
  ]
}
```

**Step 2: (Optional) Register a handler for live status**

For real-time resource status, register a handler:

```typescript
import { resourceRegistry } from './lib/resources.js';

resourceRegistry.register('ord-*', async (id) => {
  // Query your database/API for live status
  const order = await db.query('SELECT * FROM orders WHERE id = $1', [id]);

  return {
    id,
    status: order.status,           // PENDING, PROCESSING, SHIPPED, etc.
    created_at: order.created_at,
    updated_at: order.updated_at,
    // Include anything useful for debugging
    customer_id: order.customer_id,
    items: order.items,
    // AI will use these to find the workload
    namespace: `orders-${order.region}`,
    cluster: `prod-${order.region}`,
  };
});
```

**What happens when you debug a resource:**

1. AI calls `get_resource("ord-1234")`
2. Registry finds handler for `ord-*` pattern
3. Handler returns live status + context
4. AI uses this to query logs, check pods, etc.

**Without a handler:** Falls back to catalog info (ownership, description) but can't get live status.

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

## Connecting Real Backends

For production, set these environment variables:

```bash
# Database (service catalog)
DATABASE_URL=postgres://user:pass@host:5432/oncall

# Metrics
PROMETHEUS_URL=https://prometheus.internal

# Logs
OPENSEARCH_URL=https://opensearch.internal
OPENSEARCH_USERNAME=...
OPENSEARCH_PASSWORD=...

# Kubernetes
KUBERNETES_API_URL=https://kubernetes.internal
KUBERNETES_TOKEN=...

# GitHub (for deploy history)
GITHUB_TOKEN=...

# AWS (for health events)
AWS_REGION=us-east-1
```

Then remove `BACKEND_MODE=mock` from your config.

## Example Session

```
You: Debug ord-1234

Claude: [calls get_resource, get_service_catalog, query_logs, get_recent_deploys, get_pod_status]

I found the issue with ord-1234:

**Owner:** order-service (commerce team)
**Status:** PENDING (stuck for 45 minutes)

**Root Cause:** Database connection failures started 15 minutes ago, correlating with deploy v2.3.4.

**Evidence:**
- Logs show "connection refused" errors
- Pod order-service-xyz has 2 restarts
- Deploy v2.3.4 ("Fix null pointer") was 15 min ago

**Recommendation:**
1. Check connection pool settings in v2.3.4
2. Consider rollback to v2.3.3
3. Contact #commerce-oncall if issues persist
```

## Development

```bash
npm test          # run tests
npm run build     # compile typescript
npm run dev       # watch mode
```

## License

MIT
