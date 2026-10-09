# Remote synthetic lab — operational authorization boundary

**No Cloudflare operation is authorized by this Worker delivery.**

This first functional delivery provides only the isolated REST Worker and its local
checks. The second, chained experimental-plugin delivery supplies the concrete
owner-approval recipe in this file, including account/session/resource selection,
permissions, hostname, setup, the bounded synthetic run, evidence export and teardown.

Do not inspect an account/session, discover or reuse credentials, create resources,
deploy, connect a vault or export remote data before the owner approves that recipe.
A second account is optional; no Durable Object is selected. Production resources,
personal vaults and real data remain outside this exception; G1–G6 remain OPEN.

The [contract](milestones/m8-remote-synthetic-lab.md) and
[ADR 0022](decisions/0022-isolated-remote-synthetic-lab.md) describe software admission
limits, not operational permission or a provider-enforced billing cap.
