import { readFile } from "node:fs/promises";

/** Fixed Wrangler failure signatures in the order used by preflight and deploy logs. */
const failureClasses = [
	{
		label: "worker_global_scope_error",
		pattern: /Disallowed operation called within global scope/,
	},
	{ label: "wrangler_timeout", pattern: /(?:timed out|timeout)/i },
	{
		label: "wrangler_authentication_error",
		pattern: /(?:authentication|unauthorized|invalid api token)/i,
	},
] as const;
/** Safe fallback label for output that has no known failure signature. */
const unknownFailure = "unknown_wrangler_failure";

/** Return fixed failure labels without exposing Wrangler output. */
export function classifyWranglerFailure(output: string): string[] {
	const ansiEscape = String.fromCharCode(27);
	const ansiSequence = new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g");
	const safeText = output.replace(ansiSequence, "");
	const labels = failureClasses
		.filter(({ pattern }) => pattern.test(safeText))
		.map(({ label }) => label);
	return labels.length > 0 ? labels : [unknownFailure];
}

/** Read a captured file and print only fixed failure labels. */
async function printFailureLabels(path: string): Promise<void> {
	try {
		const output = await readFile(path, "utf8");
		console.log(classifyWranglerFailure(output).join("\n"));
	} catch {
		console.log(unknownFailure);
	}
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path || process.argv.length !== 3) {
		console.log(unknownFailure);
		process.exitCode = 1;
	} else {
		await printFailureLabels(path);
	}
}
