import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		exclude: ["node_modules/**"],
		include: ["test/**/*.test.ts"],
		restoreMocks: true,
		testTimeout: 15_000,
		unstubGlobals: true,
	},
});
