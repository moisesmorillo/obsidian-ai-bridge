import { syncDeviceIdSchema, syncVaultIdSchema } from "@protocol/sync.schemas";
import { SYNC_DEMO_BINDING_HEADER } from "@protocol/sync-demo.constants";
import {
  SYNC_REMOTE_TICKET_HEADER,
  SYNC_REMOTE_TICKETS,
} from "@protocol/sync-remote.constants";
import { z } from "zod";

/** Canonical decimal participant-local admission slot; not an operation ID or commit receipt. */
export const syncRemoteTicketSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(3)
  .refine((ticket) => Number(ticket) < SYNC_REMOTE_TICKETS);
/** Required denial-only identities and single-use transport slot for the remote experimental API. */
export const syncRemoteHeadersSchema = z
  .object({
    [SYNC_DEMO_BINDING_HEADER.vaultId]: syncVaultIdSchema,
    [SYNC_DEMO_BINDING_HEADER.origin]: syncDeviceIdSchema,
    [SYNC_REMOTE_TICKET_HEADER]: syncRemoteTicketSchema,
  })
  .strict();
