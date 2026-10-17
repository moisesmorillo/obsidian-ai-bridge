import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocumentation } from "@tooling/documentation";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const requestedPaths = process.argv.slice(2);
const paths = requestedPaths.length
	? requestedPaths
	: execFileSync(
			"git",
			[
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
				"--",
				"*.ts",
			],
			{ cwd: repositoryRoot, encoding: "utf8" },
		)
			.split("\0")
			.filter(Boolean);

for (const path of new Set(paths)) {
	const absolute = resolve(repositoryRoot, path);
	try {
		const findings = checkDocumentation(
			relative(repositoryRoot, absolute),
			await readFile(absolute, "utf8"),
		);
		for (const finding of findings) {
			console.log(
				`${finding.path}:${finding.line} [${finding.rule}] ${finding.declaration}: ${finding.message}`,
			);
		}
		if (findings.length) process.exitCode = 1;
	} catch (error) {
		console.error(
			`Unable to read or inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
