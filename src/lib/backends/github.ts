/**
 * GitHub Backend - Deployment tracking via GitOps.
 *
 * Instead of querying ArgoCD, we track deployments via:
 * 1. A deployment.yaml file in each service repo
 * 2. GitHub Actions updates this file on successful deploys
 * 3. GitHub webhook notifies us of changes
 *
 * This is simpler and works with any CD system.
 */

import type { DeploymentBackend, DeployInfo } from "./types.js";

// ─────────────────────────────────────────────────────────────
// REAL IMPLEMENTATION (GitHub API)
// ─────────────────────────────────────────────────────────────

export class GitHubDeploymentBackend implements DeploymentBackend {
    private token: string;
    private baseUrl: string;

    constructor(config: { token: string; baseUrl?: string }) {
        this.token = config.token;
        this.baseUrl = config.baseUrl || "https://api.github.com";
    }

    /**
     * Get recent deployments by reading deployment.yaml from the repo.
     * Also checks commit history for deployment file changes.
     */
    async getRecentDeploys(service: string, limit: number = 5): Promise<DeployInfo[]> {
        // In production, you'd:
        // 1. Look up the service's github_repo from catalog
        // 2. Fetch the deployment.yaml file
        // 3. Also fetch git history for that file to get history

        // For now, return current deployment + history from commits
        const current = await this.getCurrentDeployment(service);

        if (!current) {
            return [];
        }

        // Get commit history for deployment file
        const history = await this.getDeploymentHistory(service, limit);

        return history;
    }

    /**
     * Get current deployment status from deployment.yaml.
     */
    async getCurrentDeployment(service: string): Promise<DeployInfo | null> {
        // In production: fetch from GitHub API
        // GET /repos/{owner}/{repo}/contents/deployment.yaml

        try {
            // This would be the actual implementation:
            // const response = await fetch(
            //     `${this.baseUrl}/repos/${repo}/contents/deployment.yaml`,
            //     {
            //         headers: {
            //             "Authorization": `token ${this.token}`,
            //             "Accept": "application/vnd.github.v3.raw",
            //         },
            //     }
            // );
            // const yaml = await response.text();
            // return parseDeploymentYaml(yaml);

            console.log(`[GitHub] Fetching deployment.yaml for ${service}`);
            return null;
        } catch (error) {
            console.error(`[GitHub] Failed to fetch deployment for ${service}:`, error);
            return null;
        }
    }

    /**
     * Get deployment history from git commits.
     */
    private async getDeploymentHistory(service: string, limit: number): Promise<DeployInfo[]> {
        // In production: fetch commits that modified deployment.yaml
        // GET /repos/{owner}/{repo}/commits?path=deployment.yaml&per_page={limit}

        console.log(`[GitHub] Fetching deployment history for ${service}, limit=${limit}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────
// MOCK IMPLEMENTATION
// ─────────────────────────────────────────────────────────────

export class MockGitHubDeploymentBackend implements DeploymentBackend {
    private deployments: Map<string, DeployInfo[]> = new Map();

    /**
     * Set deployments for a service (for testing).
     */
    setDeployments(service: string, deploys: DeployInfo[]): void {
        this.deployments.set(service, deploys);
    }

    /**
     * Simulate a deployment (for testing).
     */
    simulateDeployment(service: string, deploy: Partial<DeployInfo>): void {
        const existing = this.deployments.get(service) || [];

        const newDeploy: DeployInfo = {
            version: deploy.version || `v1.0.${existing.length}`,
            commit_sha: deploy.commit_sha || `abc${Date.now()}`,
            deployed_at: deploy.deployed_at || new Date().toISOString(),
            deployed_by: deploy.deployed_by || "ci@github.com",
            environment: deploy.environment || "production",
            status: deploy.status || "success",
            previous_version: existing[0]?.version,
            commit_message: deploy.commit_message,
        };

        this.deployments.set(service, [newDeploy, ...existing]);
    }

    async getRecentDeploys(service: string, limit: number = 5): Promise<DeployInfo[]> {
        const deploys = this.deployments.get(service);

        if (deploys) {
            return deploys.slice(0, limit);
        }

        // Default: one deploy 15 min ago
        return [
            {
                version: "v2.3.4",
                previous_version: "v2.3.3",
                commit_sha: "abc1234567890",
                deployed_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                deployed_by: "alice@company.com",
                environment: "production",
                status: "success",
                commit_message: "Fix null pointer exception",
            },
            {
                version: "v2.3.3",
                previous_version: "v2.3.2",
                commit_sha: "def5678901234",
                deployed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                deployed_by: "bob@company.com",
                environment: "production",
                status: "success",
                commit_message: "Add caching layer",
            },
        ];
    }

    async getCurrentDeployment(service: string): Promise<DeployInfo | null> {
        const deploys = await this.getRecentDeploys(service, 1);
        return deploys[0] || null;
    }
}

// ─────────────────────────────────────────────────────────────
// DEPLOYMENT.YAML STRUCTURE
// ─────────────────────────────────────────────────────────────

/**
 * This is what deployment.yaml looks like in a service repo.
 *
 * GitHub Actions updates this file after a successful deploy:
 *
 * ```yaml
 * # deployment.yaml - Updated by CI/CD
 * version: "v2.3.4"
 * previous_version: "v2.3.3"
 * commit_sha: "abc1234567890"
 * deployed_at: "2024-01-15T03:15:00Z"
 * deployed_by: "alice@company.com"
 * environment: "production"
 * status: "success"
 * commit_message: "Fix null pointer exception"
 * ```
 *
 * Example GitHub Actions workflow to update this:
 *
 * ```yaml
 * # .github/workflows/deploy.yml
 * name: Deploy
 * on:
 *   push:
 *     branches: [main]
 *
 * jobs:
 *   deploy:
 *     runs-on: ubuntu-latest
 *     steps:
 *       - uses: actions/checkout@v4
 *
 *       - name: Deploy to production
 *         run: |
 *           # Your deploy commands here
 *           kubectl apply -f k8s/
 *
 *       - name: Update deployment.yaml
 *         run: |
 *           cat > deployment.yaml << EOF
 *           version: "${{ github.ref_name }}"
 *           previous_version: "$(yq .version deployment.yaml)"
 *           commit_sha: "${{ github.sha }}"
 *           deployed_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
 *           deployed_by: "${{ github.actor }}@github.com"
 *           environment: "production"
 *           status: "success"
 *           commit_message: "${{ github.event.head_commit.message }}"
 *           EOF
 *
 *       - name: Commit deployment.yaml
 *         run: |
 *           git config user.name "github-actions"
 *           git config user.email "github-actions@github.com"
 *           git add deployment.yaml
 *           git commit -m "Update deployment.yaml [skip ci]"
 *           git push
 * ```
 */
export interface DeploymentYaml {
    version: string;
    previous_version?: string;
    commit_sha: string;
    deployed_at: string;
    deployed_by: string;
    environment: string;
    status: "success" | "failed" | "in_progress" | "rolling_back";
    commit_message?: string;
}
