import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Run tests in Node environment
        environment: "node",

        // Test file patterns
        include: ["test/**/*.test.ts"],

        // Exclude integration tests by default (run with npm run test:integration)
        exclude: ["test/integration/**"],

        // Global test timeout
        testTimeout: 10000,

        // Setup file (runs before tests)
        setupFiles: ["./test/setup.ts"],

        // Coverage settings
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.test.ts", "src/index.ts"],
        },
    },
});
