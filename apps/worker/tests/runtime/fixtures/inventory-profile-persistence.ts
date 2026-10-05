import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Seal is valid only after native runtime disposal; it binds retained evidence and exact emulator bytes. */
const pairSchema = z
  .object({ version: z.literal(1), digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
/** Completed/pause artifacts whose exact bytes jointly identify a resumable local run. */
const PAIR_MEMBERS = [
  "checkpoint.json",
  "worker.mjs",
  "trace.jsonl",
  "r2-state",
];
/** Recursively hashes bounded run artifacts in canonical filename order, refusing links or special files.
 * @param path Private artifact root or file; absence is never equivalent to an empty directory.
 * @returns Exact content/name digest; filesystem uncertainty throws rather than repairing state.
 */
function artifactDigest(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    throw new RangeError("Persistence pair contains a symbolic link.");
  const hash = createHash("sha256");
  if (stat.isFile())
    return hash.update("file").update(readFileSync(path)).digest("hex");
  if (!stat.isDirectory())
    throw new RangeError("Persistence pair contains a special file.");
  hash.update("directory");
  for (const name of readdirSync(path).sort())
    hash.update(JSON.stringify([name, artifactDigest(join(path, name))]));
  return hash.digest("hex");
}
/** Computes the aggregate pair identity after all native writes have settled.
 * @param directory Locked local output directory containing every required member.
 * @returns Hash binding checkpoint, compiled fixture, trace and emulator state together.
 */
function pairDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const name of PAIR_MEMBERS)
    hash.update(JSON.stringify([name, artifactDigest(join(directory, name))]));
  return hash.digest("hex");
}
/** Rejects unsealed, deleted or replaced persistence before retained artifacts may be rebuilt.
 * @param directory Locked output directory; a fresh directory may contain only its run lock.
 * @returns Whether a complete sealed run is available for validated resumption.
 */
export function verifyProfilePair(directory: string): boolean {
  const sealPath = join(directory, "pair.json");
  if (!existsSync(sealPath)) {
    if (readdirSync(directory).some((name) => name !== "run.lock"))
      throw new RangeError(
        "Persistence pair is incomplete; retain artifacts and use a fresh directory.",
      );
    return false;
  }
  try {
    const seal = pairSchema.parse(JSON.parse(readFileSync(sealPath, "utf8")));
    if (seal.digest !== pairDigest(directory))
      throw new RangeError("Mismatched retained bytes.");
  } catch {
    throw new RangeError(
      "Persistence pair is missing, replaced or inconsistent; retained artifacts were not changed.",
    );
  }
  return true;
}
/** Publishes restart authority only after a successful emulator disposal, never during live SQLite writes.
 * @param directory Locked directory whose native runtime has fully settled.
 */
export function sealProfilePair(directory: string): void {
  const temporary = join(directory, "pair.json.tmp");
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, digest: pairDigest(directory) }),
  );
  renameSync(temporary, join(directory, "pair.json"));
}
