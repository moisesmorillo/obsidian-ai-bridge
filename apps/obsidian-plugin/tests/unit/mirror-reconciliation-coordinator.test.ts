import type {
  MirrorBootstrapProgressObserver,
  MirrorBootstrapResult,
} from "@obsidian-ai-bridge/core";
import {
  MirrorReconciliationCoordinator,
  type MirrorReconciliationRequest,
  type MirrorReconciliationSynchronizer,
} from "@obsidian-plugin/runtime/mirror-reconciliation-coordinator";
import { describe, expect, it, vi } from "vitest";

const COMPLETE_RESULT: MirrorBootstrapResult = {
  kind: "complete",
  eligiblePaths: [],
  inventory: { kind: "complete", paths: [], pagesRead: 1 },
  unassociatedRemotePaths: [],
};

describe("MirrorReconciliationCoordinator", () => {
  it("rejects an already stale request without beginning bootstrap", async () => {
    const bootstrap = vi.fn(async () => COMPLETE_RESULT);
    const coordinator = new MirrorReconciliationCoordinator();
    const stale = {
      ...request({ bootstrap }, 1, vi.fn(), vi.fn()),
      isCurrent: () => false,
    };

    await expect(coordinator.reconcile(stale)).resolves.toEqual({
      kind: "stale",
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("suppresses delayed progress and settlement for a retired identity", async () => {
    const pending = Promise.withResolvers<MirrorBootstrapResult>();
    let observer: MirrorBootstrapProgressObserver | undefined;
    let current = true;
    const admitted = vi.fn();
    const settled = vi.fn();
    const coordinator = new MirrorReconciliationCoordinator();
    const reconciliation = coordinator.reconcile(
      request(
        {
          bootstrap: (candidate) => {
            observer = candidate;
            return pending.promise;
          },
        },
        1,
        admitted,
        settled,
        () => current,
      ),
    );

    current = false;
    observer?.onPositiveAdmission();
    pending.resolve(COMPLETE_RESULT);
    await expect(reconciliation).resolves.toEqual({ kind: "stale" });
    expect(admitted).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("forwards positive admission before reporting inventory settles", async () => {
    const pending = Promise.withResolvers<MirrorBootstrapResult>();
    const synchronizer: MirrorReconciliationSynchronizer = {
      bootstrap: vi.fn((observer?: MirrorBootstrapProgressObserver) => {
        observer?.onPositiveAdmission();
        return pending.promise;
      }),
    };
    const admitted = vi.fn();
    const settled = vi.fn();
    const coordinator = new MirrorReconciliationCoordinator();
    const reconciliation = coordinator.reconcile(
      request(synchronizer, 1, admitted, settled),
    );

    expect(admitted).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    pending.resolve(COMPLETE_RESULT);
    await expect(reconciliation).resolves.toEqual({ kind: "complete" });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("settles inherited work then performs one fresh scan for a replacement epoch", async () => {
    const first = Promise.withResolvers<MirrorBootstrapResult>();
    const second = Promise.withResolvers<MirrorBootstrapResult>();
    const completions = [first, second];
    const bootstrap = vi.fn(() => {
      const completion = completions.shift();
      if (completion === undefined)
        throw new Error("Unexpected reconciliation.");
      return completion.promise;
    });
    const synchronizer: MirrorReconciliationSynchronizer = { bootstrap };
    const coordinator = new MirrorReconciliationCoordinator();
    const oldReconciliation = coordinator.reconcile(
      request(synchronizer, 1, vi.fn(), vi.fn()),
    );
    const replacementReconciliation = coordinator.reconcile(
      request(synchronizer, 2, vi.fn(), vi.fn()),
    );
    expect(bootstrap).toHaveBeenCalledOnce();

    first.resolve(COMPLETE_RESULT);
    await expect(oldReconciliation).resolves.toEqual({ kind: "complete" });
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(2));
    second.resolve(COMPLETE_RESULT);
    await expect(replacementReconciliation).resolves.toEqual({
      kind: "complete",
    });
  });

  it("deduplicates duplicate readiness in one identity", async () => {
    const pending = Promise.withResolvers<MirrorBootstrapResult>();
    const bootstrap = vi.fn(() => pending.promise);
    const synchronizer: MirrorReconciliationSynchronizer = { bootstrap };
    const coordinator = new MirrorReconciliationCoordinator();
    const current = request(synchronizer, 1, vi.fn(), vi.fn());
    const first = coordinator.reconcile(current);
    const duplicate = coordinator.reconcile(current);
    expect(bootstrap).toHaveBeenCalledOnce();
    pending.resolve(COMPLETE_RESULT);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { kind: "complete" },
      { kind: "complete" },
    ]);
    await expect(coordinator.reconcile(current)).resolves.toEqual({
      kind: "complete",
    });
    expect(bootstrap).toHaveBeenCalledOnce();
  });
});

function request(
  synchronizer: MirrorReconciliationSynchronizer,
  attachmentEpoch: number,
  onPositiveAdmission: () => void,
  onSettled: () => void,
  isCurrent: () => boolean = () => true,
): MirrorReconciliationRequest {
  return {
    attachmentEpoch,
    configurationGeneration: 1,
    connectionId: 1,
    synchronizer,
    force: false,
    isCurrent,
    onPositiveAdmission,
    onSettled,
  };
}
