import { checkDocumentation } from "#tools/tsdoc/check-tsdoc";

/**
 * Writes deterministic editor-friendly diagnostics to the process output streams.
 *
 * @param root - Repository whose production declarations must be documented.
 * @returns Zero for a clean inventory, or one when documentation is missing.
 * @throws When source discovery or the compiler project cannot be loaded.
 */
export function runDocumentationCheck(root: string): number {
  const result = checkDocumentation(root);
  for (const diagnostic of result.diagnostics) {
    process.stderr.write(
      `${diagnostic.file}:${diagnostic.line}: missing TSDoc for ${diagnostic.kind} ${diagnostic.name}\n`,
    );
  }
  process.stdout.write(
    `TSDoc presence: ${result.diagnostics.length} violations across ${result.files} production files.\n`,
  );
  return result.diagnostics.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = runDocumentationCheck(process.cwd());
