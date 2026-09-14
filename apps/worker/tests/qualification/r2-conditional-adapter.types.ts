import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";

/** Compile-time proof that the production Cloudflare binding satisfies the narrow conditional port. */
type R2BindingSupportsConditionalPort = R2Bucket extends R2ConditionalBucketPort
  ? true
  : false;

/** Fails Worker typecheck if the production binding drifts from the adapter contract. */
export const r2BindingSupportsConditionalPort: R2BindingSupportsConditionalPort = true;
