import type { FileFailure } from "@obsidian-ai-bridge/protocol";

/** Carries one canonical policy failure without exposing unsafe details. */
export class FileOperationDenied extends Error {
	/** Stores the safe failure used by application and transport callers. */
	constructor(readonly failure: FileFailure) {
		super(failure.kind);
	}
}
