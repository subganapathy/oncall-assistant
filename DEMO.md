# On-Call Assistant MCP Server Demo

This MCP server provides 16 tools for on-call incident response and debugging.

## Setup

1. Build the project:
   ```bash
   npm run build
   ```

2. The `.mcp.json` file is already configured. When you start Claude Code in this directory, it will auto-discover the MCP server.

## Testing with Claude Code

Start Claude Code in this directory:
```bash
cd /Users/subramanianganapathy/code/small-step-giant-leap/oncall-assistant
claude
```

Then try these prompts:

### 1. List Available Services
```
Use the list_services tool to show all services in the catalog
```

### 2. Get Service Details
```
Use get_service_catalog for user-service
```

### 3. Check Service Health
```
What's the health status of the user-service? Use get_service_health
```

### 4. Debug a Resource
```
Debug this stuck resource: ord-1234. Use the get_resource tool
```

### 5. Full Incident Diagnosis
Use the diagnose-incident prompt:
```
Use the diagnose-incident prompt for user-service with alert "High Error Rate" in cluster "prod-us-east"
```

## Available Tools (16)

### Catalog Tools
- `get_service_catalog` - Get full catalog entry for a service
- `list_services` - List all services (optionally filter by team)
- `get_dependencies` - Get dependencies for a service
- `get_dependents` - Get services that depend on a service
- `get_escalation_path` - Get team, slack, pager info

### Resource Tools (BYO Interface)
- `get_resource` - Get resource status by ID (main debugging tool)
- `find_resource_owner` - Find which service owns a resource

### Diagnostic Tools
- `get_service_health` - Current health metrics
- `get_recent_deploys` - Recent deployments from GitHub
- `query_logs` - Search logs in OpenSearch
- `get_pod_status` - Kubernetes pod status
- `check_dependency_health` - Check all dependencies

### Advanced Diagnostic Tools
- `scan_log_patterns` - Scan for known error patterns (Java OOM, Go panics, etc.)
- `get_pod_logs` - Get logs directly from K8s pods
- `check_aws_health` - Check AWS Health API for outages
- `check_runtime_metrics` - Verify runtime metrics publishing

## Available Prompts (3)

1. **diagnose-incident** - Full incident diagnosis workflow
2. **verify-deployment** - Post-deployment health verification
3. **debug-stuck-resource** - Debug stuck provisioning

## Mock Data

In mock mode (`BACKEND_MODE=mock`), the server uses these test services:

- **user-service** (team: payments) - User accounts, registration, auth
- **auth-service** (team: identity) - Authentication tokens and sessions
- **order-service** (team: commerce) - Customer orders and fulfillment

Each has configured observability, dependencies, and resource patterns.
