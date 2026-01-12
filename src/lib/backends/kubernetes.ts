/**
 * Kubernetes backend - REAL implementation.
 *
 * Uses kubectl or Kubernetes API to query pod status.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { KubernetesBackend, PodsResult, PodInfo, PodLogsOptions, PodLogsResult } from "./types.js";

const execAsync = promisify(exec);

export class KubectlBackend implements KubernetesBackend {
    private context?: string;
    private kubeconfig?: string;

    constructor(config: {
        context?: string;
        kubeconfig?: string;
    } = {}) {
        this.context = config.context;
        this.kubeconfig = config.kubeconfig;
    }

    async getPods(service: string, namespace: string): Promise<PodsResult> {
        const contextFlag = this.context ? `--context=${this.context}` : "";
        const kubeconfigFlag = this.kubeconfig ? `--kubeconfig=${this.kubeconfig}` : "";

        const cmd = `kubectl ${contextFlag} ${kubeconfigFlag} get pods -n ${namespace} -l app=${service} -o json`;

        try {
            const { stdout } = await execAsync(cmd);
            const data = JSON.parse(stdout);

            const pods: PodInfo[] = data.items.map((pod: KubernetesPod) => {
                const status = pod.status.phase;
                const containerStatuses = pod.status.containerStatuses || [];
                const restarts = containerStatuses.reduce(
                    (sum: number, c: ContainerStatus) => sum + c.restartCount,
                    0
                );
                const ready = containerStatuses.filter((c: ContainerStatus) => c.ready).length;
                const total = containerStatuses.length;

                // Calculate age
                const createdAt = new Date(pod.metadata.creationTimestamp);
                const age = this.formatAge(Date.now() - createdAt.getTime());

                return {
                    name: pod.metadata.name,
                    status,
                    restarts,
                    ready: `${ready}/${total}`,
                    age,
                    node: pod.spec.nodeName || "pending",
                };
            });

            return { pods };
        } catch (error) {
            console.error(`kubectl failed:`, error);
            return { pods: [] };
        }
    }

    async getPodLogs(
        pod: string,
        namespace: string,
        cluster: string,
        options: PodLogsOptions = {}
    ): Promise<PodLogsResult> {
        const {
            container,
            tail = 100,
            since,
            previous = false,
        } = options;

        // Build kubectl command
        // Use cluster name as context (assumption: context name matches cluster name)
        const contextFlag = `--context=${cluster}`;
        const kubeconfigFlag = this.kubeconfig ? `--kubeconfig=${this.kubeconfig}` : "";
        const containerFlag = container ? `-c ${container}` : "";
        const tailFlag = `--tail=${tail}`;
        const sinceFlag = since ? `--since=${since}` : "";
        const previousFlag = previous ? "--previous" : "";

        const cmd = [
            "kubectl",
            contextFlag,
            kubeconfigFlag,
            "logs",
            pod,
            `-n ${namespace}`,
            containerFlag,
            tailFlag,
            sinceFlag,
            previousFlag,
        ].filter(Boolean).join(" ");

        try {
            const { stdout } = await execAsync(cmd, {
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer for logs
            });

            return {
                pod,
                container,
                logs: stdout,
                truncated: stdout.split("\n").length >= tail,
                from_previous: previous,
            };
        } catch (error) {
            const err = error as { stderr?: string; message?: string };

            // If --previous failed, the container might not have crashed
            // Try without --previous
            if (previous && err.stderr?.includes("previous terminated container")) {
                return this.getPodLogs(pod, namespace, cluster, { ...options, previous: false });
            }

            return {
                pod,
                container,
                logs: "",
                truncated: false,
                from_previous: previous,
                error: err.stderr || err.message || "Failed to get pod logs",
            };
        }
    }

    private formatAge(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d`;
        if (hours > 0) return `${hours}h`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }
}

// Kubernetes API types (minimal)
interface KubernetesPod {
    metadata: {
        name: string;
        creationTimestamp: string;
    };
    spec: {
        nodeName?: string;
    };
    status: {
        phase: string;
        containerStatuses?: ContainerStatus[];
    };
}

interface ContainerStatus {
    ready: boolean;
    restartCount: number;
}


/**
 * Alternative: Use Kubernetes API directly (no kubectl dependency).
 *
 * Note: For multi-cluster support, you need separate KubernetesApiBackend
 * instances per cluster, or a proxy that routes based on cluster name.
 */
export class KubernetesApiBackend implements KubernetesBackend {
    private clusterConfigs: Map<string, { url: string; token: string }>;
    private defaultUrl: string;
    private defaultToken: string;

    constructor(config: {
        url: string;
        token: string;
        // Optional: additional clusters for multi-cluster support
        clusters?: Record<string, { url: string; token: string }>;
    }) {
        this.defaultUrl = config.url.replace(/\/$/, "");
        this.defaultToken = config.token;
        this.clusterConfigs = new Map();

        // Register additional clusters if provided
        if (config.clusters) {
            for (const [name, cfg] of Object.entries(config.clusters)) {
                this.clusterConfigs.set(name, {
                    url: cfg.url.replace(/\/$/, ""),
                    token: cfg.token,
                });
            }
        }
    }

    private getClusterConfig(cluster?: string): { url: string; token: string } {
        if (cluster && this.clusterConfigs.has(cluster)) {
            return this.clusterConfigs.get(cluster)!;
        }
        return { url: this.defaultUrl, token: this.defaultToken };
    }

    async getPods(service: string, namespace: string): Promise<PodsResult> {
        const { url: baseUrl, token } = this.getClusterConfig();
        const url = `${baseUrl}/api/v1/namespaces/${namespace}/pods?labelSelector=app=${service}`;

        const response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/json",
            },
        });

        if (!response.ok) {
            console.error(`Kubernetes API failed: ${response.status}`);
            return { pods: [] };
        }

        const data = await response.json();

        const pods: PodInfo[] = data.items.map((pod: KubernetesPod) => {
            const containerStatuses = pod.status.containerStatuses || [];
            const restarts = containerStatuses.reduce((sum: number, c: ContainerStatus) => sum + c.restartCount, 0);
            const ready = containerStatuses.filter((c: ContainerStatus) => c.ready).length;

            const createdAt = new Date(pod.metadata.creationTimestamp);
            const ageMs = Date.now() - createdAt.getTime();
            const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));

            return {
                name: pod.metadata.name,
                status: pod.status.phase,
                restarts,
                ready: `${ready}/${containerStatuses.length}`,
                age: days > 0 ? `${days}d` : `${Math.floor(ageMs / (60 * 60 * 1000))}h`,
                node: pod.spec.nodeName || "pending",
            };
        });

        return { pods };
    }

    async getPodLogs(
        pod: string,
        namespace: string,
        cluster: string,
        options: PodLogsOptions = {}
    ): Promise<PodLogsResult> {
        const {
            container,
            tail = 100,
            since,
            previous = false,
        } = options;

        const { url: baseUrl, token } = this.getClusterConfig(cluster);

        // Build query params
        const params = new URLSearchParams();
        if (container) params.set("container", container);
        params.set("tailLines", String(tail));
        if (since) {
            // Convert duration like "5m" to seconds
            const seconds = this.parseDurationToSeconds(since);
            if (seconds > 0) params.set("sinceSeconds", String(seconds));
        }
        if (previous) params.set("previous", "true");

        const url = `${baseUrl}/api/v1/namespaces/${namespace}/pods/${pod}/log?${params.toString()}`;

        try {
            const response = await fetch(url, {
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Accept": "text/plain",
                },
            });

            if (!response.ok) {
                const errorText = await response.text();

                // If previous container doesn't exist, retry without --previous
                if (previous && errorText.includes("previous terminated container")) {
                    return this.getPodLogs(pod, namespace, cluster, { ...options, previous: false });
                }

                return {
                    pod,
                    container,
                    logs: "",
                    truncated: false,
                    from_previous: previous,
                    error: `API error ${response.status}: ${errorText}`,
                };
            }

            const logs = await response.text();

            return {
                pod,
                container,
                logs,
                truncated: logs.split("\n").length >= tail,
                from_previous: previous,
            };
        } catch (error) {
            return {
                pod,
                container,
                logs: "",
                truncated: false,
                from_previous: previous,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }

    private parseDurationToSeconds(duration: string): number {
        const match = duration.match(/^(\d+)([smhd])$/);
        if (!match) return 0;

        const value = parseInt(match[1], 10);
        const unit = match[2];

        switch (unit) {
            case "s": return value;
            case "m": return value * 60;
            case "h": return value * 3600;
            case "d": return value * 86400;
            default: return 0;
        }
    }
}
