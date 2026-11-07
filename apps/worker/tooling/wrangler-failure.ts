import { readFile } from "node:fs/promises";

/** Fixed Wrangler failure signatures in the order used by preflight and deploy logs. */
const failureClasses = [
	{
		label: "Disallowed operation called within global scope",
		pattern: /Disallowed operation called within global scope/,
	},
	{
		label: "Authentication error",
		pattern:
			/(?:authentication error|authentication failed|unauthorized|invalid api token)/i,
	},
	{
		label: "No such compatibility flag",
		pattern: /No such compatibility flag/i,
	},
	{
		label: "Script startup exceeded",
		pattern: /Script startup exceeded/i,
	},
	{ label: "wrangler_timeout", pattern: /(?:timed out|timeout|ETIMEDOUT)/i },
] as const;
/** Safe fallback label for output that has no known failure signature. */
const unknownFailure = "unknown_wrangler_failure";

/** Union of the fixed class names that may appear in preflight or deploy logs. */
type WranglerFailureLabel =
	| (typeof failureClasses)[number]["label"]
	| typeof unknownFailure;

/** Return fixed failure labels without exposing Wrangler output. */
export function classifyWranglerFailure(
	output: string,
): WranglerFailureLabel[] {
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
