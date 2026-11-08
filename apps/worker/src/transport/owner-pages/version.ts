import workerPackage from "../../../package.json" with { type: "json" };

/** Worker package version embedded in the build without a runtime file read. */
export const WORKER_VERSION: string = workerPackage.version;
