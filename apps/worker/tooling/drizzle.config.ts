import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/infrastructure/sqlite/schema-model.ts",
	out: "./drizzle",
});
