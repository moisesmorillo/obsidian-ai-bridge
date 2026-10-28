---
id: decision-1
title: >-
  Accept the F2 exit on server and real-client evidence; carry AC-08 plugin
  obligations into OAB-8
date: '2026-10-28T17:24:00Z'
status: accepted
---
## Context

`docs/spec.md` section 14 lists the F2 exit: MCP Inspector, Claude Code and ChatGPT web connect, read and write work, AC-08, and the owner account decision. AC-08 (line 603) has two parts. The server part says the next request to the Durable Object fails `401 revoked` within one request. The device part says the plugin shows `revoked` and keeps its files.

OAB-7.8 closed on 2026-10-28 with real evidence for every server and client item: Access login, Inspector 2.12.0, Claude Code 2.1.311, ChatGPT web, ChatGPT on iPhone, and the same-token revocation at 15:12:42Z. The device part of AC-08 needs the desktop plugin, which OAB-8 (F3) builds. OAB-8 depends on OAB-7. Without a decision the two tasks block each other.

## Decision

The owner accepts the F2 exit on the server and real-client evidence recorded in OAB-7.8. The device part of AC-08 (plugin shows `revoked`, keeps local files, preserves queued work) is not waived. It moves to OAB-8 as an explicit exit obligation of F3. OAB-7 closes. The mobile client strategy is the custom ChatGPT app on the iPhone.

## Consequences

- OAB-7 criterion 2 is checked with this boundary and the task is Done.
- OAB-8 must prove the device part of AC-08 with plugin evidence before F3 exits. OAB-8 still needs explicit owner authorization to start.
- OAB-26 (opaque OAuth identity) and OAB-27 (revoked state in the console) stay Deferred with their triggers.
- Nothing in this decision authorizes a deployment, a Cloudflare resource change, or access to the personal vault.
