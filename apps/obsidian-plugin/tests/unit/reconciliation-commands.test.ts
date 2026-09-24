import {
  createMirrorOperationId,
  createRecoverySnapshotId,
  HISTORY_DECISION_KIND,
  normalizeNotePath,
  RECONCILIATION_ACTION,
  RECONCILIATION_CLASSIFICATION,
} from "@obsidian-ai-bridge/core";
import {
  RECONCILIATION_COMMANDS,
  ReconciliationCommands,
} from "@obsidian-plugin/commands/reconciliation-commands";
import { ObservationGapReviewModal } from "@obsidian-plugin/reconciliation/observation-gap-review-modal";
import { ReconciliationReviewModal } from "@obsidian-plugin/reconciliation/reconciliation-review-modal";
import type { ReconciliationUiOwner } from "@obsidian-plugin/reconciliation/reconciliation-ui.types";
import { RecoverySelectionModal } from "@obsidian-plugin/reconciliation/recovery-selection-modal";
import { resetHost } from "@obsidian-plugin-tests/support/obsidian-runtime";
import { App, type Command, type Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

/**
 * @param value - Candidate produced by a validating core constructor.
 * @returns The validated fixture value.
 */
function required<Value>(value: Value | undefined): Value {
  if (value === undefined)
    throw new Error("Invalid reconciliation UI fixture.");
  return value;
}

function owner(): ReconciliationUiOwner {
  return {
    listReconciliationCandidates: vi.fn<
      ReconciliationUiOwner["listReconciliationCandidates"]
    >(async () => ({ kind: "available", candidates: [] })),
    listObservationGaps: vi.fn<ReconciliationUiOwner["listObservationGaps"]>(
      () => ({ kind: "available", candidates: [] }),
    ),
    createObservationGapReview: vi.fn<
      ReconciliationUiOwner["createObservationGapReview"]
    >(async () => ({ kind: "unavailable" })),
    closeObservationGapReview:
      vi.fn<ReconciliationUiOwner["closeObservationGapReview"]>(),
    submitObservationGapReview: vi.fn<
      ReconciliationUiOwner["submitObservationGapReview"]
    >(async () => ({ kind: "unavailable" })),
    listRecoverySelections: vi.fn<
      ReconciliationUiOwner["listRecoverySelections"]
    >(async () => ({ kind: "available", recoveries: [] })),
    createReconciliationReview: vi.fn<
      ReconciliationUiOwner["createReconciliationReview"]
    >(async () => null),
    reconciliationPreview: vi.fn<
      ReconciliationUiOwner["reconciliationPreview"]
    >(() => null),
    closeReconciliationReview:
      vi.fn<ReconciliationUiOwner["closeReconciliationReview"]>(),
    submitReconciliation: vi.fn<ReconciliationUiOwner["submitReconciliation"]>(
      async () => ({ kind: "unavailable" }),
    ),
  };
}

function host() {
  const commands: Command[] = [];
  return {
    commands,
    plugin: {
      app: new App(),
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
        return command;
      }),
    } satisfies Pick<Plugin, "addCommand" | "app">,
  };
}

beforeEach(() => {
  resetHost();
  vi.restoreAllMocks();
});

describe("ReconciliationCommands", () => {
  it("registers stable commands without querying or mutating the runtime", () => {
    const application = owner();
    const fixture = host();

    new ReconciliationCommands(
      fixture.plugin,
      application,
      "33333333-3333-4333-8333-333333333333",
    ).register();

    expect(fixture.commands.map(({ id, name }) => ({ id, name }))).toEqual([
      RECONCILIATION_COMMANDS.review,
      RECONCILIATION_COMMANDS.restore,
      RECONCILIATION_COMMANDS.observationGaps,
    ]);
    expect(application.listReconciliationCandidates).not.toHaveBeenCalled();
    expect(application.listRecoverySelections).not.toHaveBeenCalled();
    expect(application.listObservationGaps).not.toHaveBeenCalled();
    expect(application.createReconciliationReview).not.toHaveBeenCalled();
    expect(application.submitReconciliation).not.toHaveBeenCalled();
    expect(application.createObservationGapReview).not.toHaveBeenCalled();
    expect(application.submitObservationGapReview).not.toHaveBeenCalled();
  });

  it("opens only sanitized review and recovery projections after explicit commands", async () => {
    const application = owner();
    const fixture = host();
    const reviewOpen = vi
      .spyOn(ReconciliationReviewModal.prototype, "open")
      .mockImplementation(() => undefined);
    const recoveryOpen = vi
      .spyOn(RecoverySelectionModal.prototype, "open")
      .mockImplementation(() => undefined);
    const gapOpen = vi
      .spyOn(ObservationGapReviewModal.prototype, "open")
      .mockImplementation(() => undefined);
    const commands = new ReconciliationCommands(
      fixture.plugin,
      application,
      "33333333-3333-4333-8333-333333333333",
    );
    commands.register();

    fixture.commands[0]?.callback?.();
    fixture.commands[1]?.callback?.();
    fixture.commands[2]?.callback?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.listReconciliationCandidates).toHaveBeenCalledOnce();
    expect(application.listRecoverySelections).toHaveBeenCalledOnce();
    expect(application.listObservationGaps).toHaveBeenCalledOnce();
    expect(reviewOpen).toHaveBeenCalledOnce();
    expect(recoveryOpen).toHaveBeenCalledOnce();
    expect(gapOpen).toHaveBeenCalledOnce();
  });

  it("owns one candidate selection and invalidates its unsubmitted review on close", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/a.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(path).toBeDefined();
    expect(reviewId).toBeDefined();
    if (path === undefined || reviewId === undefined) return;
    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.bothChanged,
      allowedActions: [RECONCILIATION_ACTION.defer],
      historyCandidates: [],
    });
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    modal.close();

    expect(application.createReconciliationReview).toHaveBeenCalledOnce();
    expect(application.closeReconciliationReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      reviewId,
    );
    expect(modal.contentEl.children).toEqual([]);
  });

  it("renders every supplied review action and submits a text-only decision", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/actions.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    if (path === undefined || reviewId === undefined) return;
    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.bothChanged,
      allowedActions: [
        RECONCILIATION_ACTION.keepBoth,
        RECONCILIATION_ACTION.forkLegacy,
        RECONCILIATION_ACTION.resolveHistory,
        RECONCILIATION_ACTION.defer,
      ],
      historyCandidates: [path],
    });
    vi.mocked(application.reconciliationPreview).mockReturnValueOnce(
      "<literal preview>",
    );
    vi.mocked(application.submitReconciliation).mockResolvedValueOnce({
      kind: "completed",
    });
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
      true,
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const buttons = modal.contentEl.querySelectorAll("button");
    expect(buttons).toHaveLength(9);
    buttons[0]?.click();
    buttons[8]?.click();
    buttons[8]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.reconciliationPreview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      reviewId,
      "local",
    );
    expect(application.submitReconciliation).toHaveBeenCalledOnce();
    expect(application.submitReconciliation).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      reviewId,
      { kind: RECONCILIATION_ACTION.defer },
      undefined,
    );
    modal.close();
    expect(application.closeReconciliationReview).not.toHaveBeenCalled();
  });

  it("submits only a bounded history candidate instead of a durable canonical path", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/history-source.md");
    const candidate = normalizeNotePath("notes/history-destination.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    if (
      path === undefined ||
      candidate === undefined ||
      reviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
      allowedActions: [RECONCILIATION_ACTION.resolveHistory],
      historyCandidates: [candidate],
    });
    vi.mocked(application.submitReconciliation).mockResolvedValueOnce({
      kind: "admitted",
    });
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    modal.contentEl.querySelectorAll("button")[4]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.submitReconciliation).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      reviewId,
      {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: {
          kind: HISTORY_DECISION_KIND.executeCleanupPlan,
          selectedCandidatePath: candidate,
        },
      },
      undefined,
    );
    const submitted = vi.mocked(application.submitReconciliation).mock
      .calls[0]?.[2];
    expect(submitted).not.toHaveProperty("decision.canonicalPath");
  });

  it("resamples a literal destination and closes a refused destination review", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/actions.md");
    const destination = normalizeNotePath("notes/copy.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    const destinationReviewId = createMirrorOperationId(
      "55555555-5555-4555-8555-555555555555",
    );
    if (
      path === undefined ||
      destination === undefined ||
      reviewId === undefined ||
      destinationReviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.createReconciliationReview)
      .mockResolvedValueOnce({
        reviewId,
        targetPath: path,
        destinationPath: null,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        allowedActions: [RECONCILIATION_ACTION.keepBoth],
        historyCandidates: [],
      })
      .mockResolvedValueOnce({
        reviewId: destinationReviewId,
        targetPath: path,
        destinationPath: destination,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        allowedActions: [RECONCILIATION_ACTION.keepBoth],
        historyCandidates: [],
      });
    vi.mocked(application.submitReconciliation).mockResolvedValueOnce({
      kind: "stale",
    });
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const destinationInput = modal.contentEl.querySelectorAll("input")[0];
    if (destinationInput === undefined) return;
    destinationInput.value = destination;
    modal.contentEl.querySelectorAll("button")[2]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.createReconciliationReview).toHaveBeenCalledTimes(2);
    expect(application.submitReconciliation).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      destinationReviewId,
      {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: "local",
      },
      destination,
    );
    expect(application.closeReconciliationReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      destinationReviewId,
    );
  });

  it.each(["missing", "disallowed", "destinationless"] as const)(
    "fails closed for %s destination resampling",
    async (failure) => {
      const application = owner();
      const path = normalizeNotePath("notes/actions.md");
      const destination = normalizeNotePath("notes/copy.md");
      const reviewId = createMirrorOperationId(
        "44444444-4444-4444-8444-444444444444",
      );
      const destinationReviewId = createMirrorOperationId(
        "55555555-5555-4555-8555-555555555555",
      );
      if (
        path === undefined ||
        destination === undefined ||
        reviewId === undefined ||
        destinationReviewId === undefined
      ) {
        return;
      }
      vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
        reviewId,
        targetPath: path,
        destinationPath: null,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        allowedActions: [RECONCILIATION_ACTION.keepBoth],
        historyCandidates: [],
      });
      vi.mocked(application.createReconciliationReview).mockResolvedValueOnce(
        failure === "missing"
          ? null
          : {
              reviewId: destinationReviewId,
              targetPath: path,
              destinationPath:
                failure === "destinationless" ? null : destination,
              classification: RECONCILIATION_CLASSIFICATION.bothChanged,
              allowedActions:
                failure === "disallowed"
                  ? [RECONCILIATION_ACTION.defer]
                  : [RECONCILIATION_ACTION.keepBoth],
              historyCandidates: [],
            },
      );
      const modal = new ReconciliationReviewModal(
        new App(),
        application,
        "33333333-3333-4333-8333-333333333333",
        [path],
      );

      modal.open();
      modal.contentEl.querySelectorAll("button")[0]?.click();
      await Promise.resolve();
      await Promise.resolve();
      const input = modal.contentEl.querySelectorAll("input")[0];
      if (input === undefined) return;
      input.value = destination;
      modal.contentEl.querySelectorAll("button")[2]?.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(application.submitReconciliation).not.toHaveBeenCalled();
      if (failure !== "missing") {
        expect(application.closeReconciliationReview).toHaveBeenCalledWith(
          "33333333-3333-4333-8333-333333333333",
          destinationReviewId,
        );
      }
    },
  );

  it("renders unavailable and empty review selections without sampling content", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/unavailable.md");
    if (path === undefined) return;
    const empty = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [],
      true,
    );
    empty.open();
    expect(empty.contentEl.querySelectorAll("button")).toHaveLength(0);

    const unavailable = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );
    unavailable.open();
    unavailable.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(application.createReconciliationReview).toHaveBeenCalledOnce();
  });

  it("guards delayed candidate selection and detached preview controls", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/race.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    if (path === undefined || reviewId === undefined) return;
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<ReconciliationUiOwner["createReconciliationReview"]>>
      >();
    vi.mocked(application.createReconciliationReview).mockReturnValueOnce(
      pending.promise,
    );
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );
    modal.open();
    const candidate = modal.contentEl.querySelectorAll("button")[0];
    candidate?.click();
    if (candidate !== undefined) candidate.disabled = false;
    candidate?.click();
    expect(application.createReconciliationReview).toHaveBeenCalledOnce();
    pending.resolve({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.bothChanged,
      allowedActions: [RECONCILIATION_ACTION.defer],
      historyCandidates: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    const preview = modal.contentEl.querySelectorAll("button")[0];
    modal.close();
    preview?.click();
    expect(application.reconciliationPreview).not.toHaveBeenCalled();
  });

  it("guards duplicate action and destination decisions while submission is pending", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/race.md");
    const destination = normalizeNotePath("notes/copy.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    if (
      path === undefined ||
      destination === undefined ||
      reviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.createReconciliationReview).mockResolvedValue({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.bothChanged,
      allowedActions: [
        RECONCILIATION_ACTION.keepBoth,
        RECONCILIATION_ACTION.defer,
      ],
      historyCandidates: [],
    });
    const submit =
      Promise.withResolvers<
        Awaited<ReturnType<ReconciliationUiOwner["submitReconciliation"]>>
      >();
    vi.mocked(application.submitReconciliation).mockReturnValueOnce(
      submit.promise,
    );
    const modal = new ReconciliationReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );
    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const defer = modal.contentEl.querySelectorAll("button")[4];
    defer?.click();
    if (defer !== undefined) defer.disabled = false;
    defer?.click();
    expect(application.submitReconciliation).toHaveBeenCalledOnce();
    submit.resolve({ kind: "admitted" });
    await Promise.resolve();

    const destinationOwner = owner();
    const destinationReview =
      Promise.withResolvers<
        Awaited<ReturnType<ReconciliationUiOwner["createReconciliationReview"]>>
      >();
    vi.mocked(destinationOwner.createReconciliationReview)
      .mockResolvedValueOnce({
        reviewId,
        targetPath: path,
        destinationPath: null,
        classification: RECONCILIATION_CLASSIFICATION.bothChanged,
        allowedActions: [RECONCILIATION_ACTION.keepBoth],
        historyCandidates: [],
      })
      .mockReturnValueOnce(destinationReview.promise);
    const destinationModal = new ReconciliationReviewModal(
      new App(),
      destinationOwner,
      "33333333-3333-4333-8333-333333333333",
      [path],
    );
    destinationModal.open();
    destinationModal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const input = destinationModal.contentEl.querySelectorAll("input")[0];
    if (input === undefined) return;
    input.value = destination;
    const keepBoth = destinationModal.contentEl.querySelectorAll("button")[2];
    keepBoth?.click();
    if (keepBoth !== undefined) keepBoth.disabled = false;
    keepBoth?.click();
    expect(destinationOwner.createReconciliationReview).toHaveBeenCalledTimes(
      2,
    );
    destinationReview.resolve(null);
    await Promise.resolve();
  });

  it("requires literal recovery-path confirmation before restore submission", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/recovery.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    const recoveryId = createRecoverySnapshotId(
      "55555555-5555-4555-8555-555555555555",
    );
    expect(path).toBeDefined();
    expect(reviewId).toBeDefined();
    expect(recoveryId).toBeDefined();
    if (
      path === undefined ||
      reviewId === undefined ||
      recoveryId === undefined
    ) {
      return;
    }
    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.localMissing,
      allowedActions: [RECONCILIATION_ACTION.restoreRecovery],
      historyCandidates: [],
    });
    const modal = new RecoverySelectionModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [
        {
          id: recoveryId,
          path,
          state: "prepared",
          recoverUntil: null,
          actionable: true,
        },
      ],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    modal.contentEl.querySelectorAll("button")[0]?.click();

    expect(application.submitReconciliation).not.toHaveBeenCalled();
    expect(application.closeReconciliationReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      reviewId,
    );
  });

  it("submits one exactly confirmed recovery and reports unavailable selections", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/recovery.md");
    const reviewId = createMirrorOperationId(
      "44444444-4444-4444-8444-444444444444",
    );
    const recoveryId = createRecoverySnapshotId(
      "55555555-5555-4555-8555-555555555555",
    );
    if (
      path === undefined ||
      reviewId === undefined ||
      recoveryId === undefined
    ) {
      return;
    }
    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce({
      reviewId,
      targetPath: path,
      destinationPath: null,
      classification: RECONCILIATION_CLASSIFICATION.localMissing,
      allowedActions: [RECONCILIATION_ACTION.restoreRecovery],
      historyCandidates: [],
    });
    vi.mocked(application.submitReconciliation).mockResolvedValueOnce({
      kind: "admitted",
    });
    const modal = new RecoverySelectionModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [
        {
          id: recoveryId,
          path,
          state: "prepared",
          recoverUntil: null,
          actionable: true,
        },
      ],
      true,
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const confirmation = modal.contentEl.querySelectorAll("input")[0];
    if (confirmation === undefined) return;
    confirmation.value = path;
    const confirm = modal.contentEl.querySelectorAll("button")[0];
    confirm?.click();
    confirm?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.submitReconciliation).toHaveBeenCalledOnce();
    expect(application.closeReconciliationReview).not.toHaveBeenCalled();
    modal.close();

    vi.mocked(application.createReconciliationReview).mockResolvedValueOnce(
      null,
    );
    const unavailable = new RecoverySelectionModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [
        {
          id: recoveryId,
          path,
          state: "prepared",
          recoverUntil: null,
          actionable: true,
        },
      ],
    );
    unavailable.open();
    unavailable.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(application.createReconciliationReview).toHaveBeenCalledTimes(2);
  });

  it("renders expired and purged recovery metadata without actionable selection", () => {
    const application = owner();
    const path = normalizeNotePath("notes/recovery.md");
    const expiredId = createRecoverySnapshotId(
      "55555555-5555-4555-8555-555555555555",
    );
    const purgedId = createRecoverySnapshotId(
      "66666666-6666-4666-8666-666666666666",
    );
    if (
      path === undefined ||
      expiredId === undefined ||
      purgedId === undefined
    ) {
      return;
    }
    const modal = new RecoverySelectionModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [
        {
          id: expiredId,
          path,
          state: "sealed-expired",
          recoverUntil: "1970-01-01T00:00:00.000Z",
          actionable: false,
        },
        {
          id: purgedId,
          path,
          state: "purged",
          recoverUntil: "1970-01-01T00:00:00.000Z",
          actionable: false,
        },
      ],
    );

    modal.open();
    const buttons = modal.contentEl.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect([...buttons].every((button) => button.disabled)).toBe(true);
    buttons.forEach((button) => {
      button.click();
    });
    expect(application.createReconciliationReview).not.toHaveBeenCalled();
  });

  it("discards a complete gap review that finishes after its modal closes", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/gap.md");
    const predecessorOperationId = createMirrorOperationId(
      "77777777-7777-4777-8777-777777777777",
    );
    const groupReviewId = createMirrorOperationId(
      "88888888-8888-4888-8888-888888888888",
    );
    if (
      path === undefined ||
      predecessorOperationId === undefined ||
      groupReviewId === undefined
    ) {
      return;
    }
    const pendingReview =
      Promise.withResolvers<
        Awaited<ReturnType<ReconciliationUiOwner["createObservationGapReview"]>>
      >();
    vi.mocked(application.createObservationGapReview).mockReturnValueOnce(
      pendingReview.promise,
    );
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    modal.close();
    pendingReview.resolve({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [],
        unreviewablePaths: [],
      },
    });
    await vi.waitFor(() =>
      expect(application.closeObservationGapReview).toHaveBeenCalledWith(
        "33333333-3333-4333-8333-333333333333",
        groupReviewId,
      ),
    );
    expect(modal.contentEl.children).toEqual([]);
  });

  it("submits every changed gap path as one exact atomic batch", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/gap.md");
    const predecessorOperationId = createMirrorOperationId(
      "77777777-7777-4777-8777-777777777777",
    );
    const groupReviewId = createMirrorOperationId(
      "88888888-8888-4888-8888-888888888888",
    );
    const childReviewId = createMirrorOperationId(
      "99999999-9999-4999-8999-999999999999",
    );
    if (
      path === undefined ||
      predecessorOperationId === undefined ||
      groupReviewId === undefined ||
      childReviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.listObservationGaps).mockReturnValueOnce({
      kind: "available",
      candidates: [{ operationId: predecessorOperationId, paths: [path] }],
    });
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [
          {
            reviewId: childReviewId,
            targetPath: path,
            classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
            allowedActions: [
              RECONCILIATION_ACTION.adoptRevision,
              RECONCILIATION_ACTION.useRemote,
            ],
            historyCandidates: [],
          },
        ],
        unreviewablePaths: [],
      },
    });
    vi.mocked(application.submitObservationGapReview).mockResolvedValueOnce({
      kind: "admitted",
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(modal.contentEl.querySelectorAll("button")).toHaveLength(3);
    modal.contentEl.querySelectorAll("button")[0]?.click();
    expect(modal.contentEl.querySelectorAll("pre")[0]?.textContent).toBe(
      "local preview is unavailable.",
    );
    modal.contentEl.querySelectorAll("button")[2]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.submitObservationGapReview).toHaveBeenCalledOnce();
    expect(application.submitObservationGapReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      groupReviewId,
      [
        {
          reviewId: childReviewId,
          action: { kind: RECONCILIATION_ACTION.adoptRevision },
        },
      ],
    );
    expect(application.closeObservationGapReview).not.toHaveBeenCalled();
  });

  it("renders and submits one explicit bounded history decision", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/history-new.md");
    const predecessorOperationId = createMirrorOperationId(
      "77777777-7777-4777-8777-777777777777",
    );
    const groupReviewId = createMirrorOperationId(
      "88888888-8888-4888-8888-888888888888",
    );
    const childReviewId = createMirrorOperationId(
      "99999999-9999-4999-8999-999999999999",
    );
    if (
      path === undefined ||
      predecessorOperationId === undefined ||
      groupReviewId === undefined ||
      childReviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [
          {
            reviewId: childReviewId,
            targetPath: path,
            classification: RECONCILIATION_CLASSIFICATION.deferredHistory,
            allowedActions: [RECONCILIATION_ACTION.resolveHistory],
            historyCandidates: [path],
          },
        ],
        unreviewablePaths: [],
      },
    });
    vi.mocked(application.submitObservationGapReview).mockResolvedValueOnce({
      kind: "admitted",
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    const choice = modal.contentEl.querySelectorAll("select")[0];
    if (choice === undefined) return;
    expect(
      Array.from(choice.querySelectorAll("option"), (option) => option.value),
    ).toEqual([HISTORY_DECISION_KIND.retainIndependent, `execute:${path}`]);
    choice.value = `execute:${path}`;
    modal.contentEl.querySelectorAll("button")[2]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(application.submitObservationGapReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      groupReviewId,
      [
        {
          reviewId: childReviewId,
          action: {
            kind: RECONCILIATION_ACTION.resolveHistory,
            decision: {
              kind: HISTORY_DECISION_KIND.executeCleanupPlan,
              selectedCandidatePath: path,
            },
          },
        },
      ],
    );
  });

  it("withholds every settlement control when one reserved path is unreviewable", async () => {
    const application = owner();
    const path = normalizeNotePath("notes/gap.md");
    const predecessorOperationId = createMirrorOperationId(
      "77777777-7777-4777-8777-777777777777",
    );
    const groupReviewId = createMirrorOperationId(
      "88888888-8888-4888-8888-888888888888",
    );
    if (
      path === undefined ||
      predecessorOperationId === undefined ||
      groupReviewId === undefined
    ) {
      return;
    }
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [],
        unreviewablePaths: [path],
      },
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.contentEl.querySelectorAll("button")).toHaveLength(0);
    expect(application.submitObservationGapReview).not.toHaveBeenCalled();
    modal.close();
    expect(application.closeObservationGapReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      groupReviewId,
    );
  });

  it("exposes aligned no-effect settlement only as an explicit decision", async () => {
    const application = owner();
    const path = required(normalizeNotePath("notes/aligned.md"));
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const groupReviewId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [],
        unreviewablePaths: [],
      },
    });
    vi.mocked(application.submitObservationGapReview).mockResolvedValueOnce({
      kind: "completed",
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() =>
      expect(modal.contentEl.querySelectorAll("button")[0]?.textContent).toBe(
        "Settle aligned gap without effects",
      ),
    );
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() =>
      expect(application.submitObservationGapReview).toHaveBeenCalledOnce(),
    );
    expect(application.submitObservationGapReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      groupReviewId,
      [],
    );
  });

  it("maps every supported simple action into one complete atomic group", async () => {
    const application = owner();
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const groupReviewId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    const kinds = [
      RECONCILIATION_ACTION.keepLocal,
      RECONCILIATION_ACTION.useRemote,
      RECONCILIATION_ACTION.acceptTombstone,
      RECONCILIATION_ACTION.recreateRemote,
      RECONCILIATION_ACTION.restoreRecovery,
    ] as const;
    const children = kinds.map((kind, index) => ({
      reviewId: required(
        createMirrorOperationId(
          `90000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        ),
      ),
      targetPath: required(normalizeNotePath(`notes/gap-${index}.md`)),
      classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
      allowedActions: [kind],
      historyCandidates: [],
    }));
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: children.map((child) => child.targetPath),
        children,
        unreviewablePaths: [],
      },
    });
    vi.mocked(application.submitObservationGapReview).mockResolvedValueOnce({
      kind: "admitted",
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [
        {
          operationId: predecessorOperationId,
          paths: children.map((child) => child.targetPath),
        },
      ],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() =>
      expect(modal.contentEl.querySelectorAll("button")).toHaveLength(11),
    );
    modal.contentEl.querySelectorAll("button")[10]?.click();
    await vi.waitFor(() =>
      expect(application.submitObservationGapReview).toHaveBeenCalledOnce(),
    );
    expect(application.submitObservationGapReview).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      groupReviewId,
      children.map((child, index) => ({
        reviewId: child.reviewId,
        action: { kind: kinds[index] },
      })),
    );
  });

  it("explains an empty gap inventory without implying that work is complete", () => {
    const modal = new ObservationGapReviewModal(
      new App(),
      owner(),
      "33333333-3333-4333-8333-333333333333",
      [],
    );

    modal.open();

    expect(
      Array.from(modal.contentEl.querySelectorAll("p")).map(
        (paragraph) => paragraph.textContent,
      ),
    ).toContain("No active observation-gap reservations are available.");
  });

  it("refuses a gap child with no supported ordinary action", async () => {
    const application = owner();
    const path = required(normalizeNotePath("notes/no-action.md"));
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const groupReviewId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    const childReviewId = required(
      createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
    );
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [
          {
            reviewId: childReviewId,
            targetPath: path,
            classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
            allowedActions: [],
            historyCandidates: [],
          },
        ],
        unreviewablePaths: [],
      },
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();

    await vi.waitFor(() =>
      expect(
        Array.from(modal.contentEl.querySelectorAll("p")).map(
          (paragraph) => paragraph.textContent,
        ),
      ).toContain("No ordinary action fits this path's retained reservation."),
    );
    Array.from(modal.contentEl.querySelectorAll("button")).at(-1)?.click();
    expect(application.submitObservationGapReview).not.toHaveBeenCalled();
    expect(
      Array.from(modal.contentEl.querySelectorAll("p")).map(
        (paragraph) => paragraph.textContent,
      ),
    ).toContain("Every changed path requires one supported fresh action.");
  });

  it("rejects a selector value outside the owner-supplied simple action subset", async () => {
    const application = owner();
    const path = required(normalizeNotePath("notes/unsupported-action.md"));
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const groupReviewId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    const childReviewId = required(
      createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
    );
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [
          {
            reviewId: childReviewId,
            targetPath: path,
            classification: RECONCILIATION_CLASSIFICATION.bothChanged,
            allowedActions: [RECONCILIATION_ACTION.keepBoth],
            historyCandidates: [],
          },
        ],
        unreviewablePaths: [],
      },
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await Promise.resolve();
    await Promise.resolve();
    Array.from(modal.contentEl.querySelectorAll("button")).at(-1)?.click();

    expect(application.submitObservationGapReview).not.toHaveBeenCalled();
    expect(
      Array.from(modal.contentEl.querySelectorAll("p")).map(
        (paragraph) => paragraph.textContent,
      ),
    ).toContain("Every changed path requires one supported fresh action.");
  });

  it("keeps the predecessor held when a complete transfer is refused", async () => {
    const application = owner();
    const path = required(normalizeNotePath("notes/refused.md"));
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const groupReviewId = required(
      createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
    );
    const childReviewId = required(
      createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
    );
    vi.mocked(application.createObservationGapReview).mockResolvedValueOnce({
      kind: "created",
      review: {
        reviewId: groupReviewId,
        predecessorOperationId,
        paths: [path],
        children: [
          {
            reviewId: childReviewId,
            targetPath: path,
            classification: RECONCILIATION_CLASSIFICATION.remoteAhead,
            allowedActions: [RECONCILIATION_ACTION.useRemote],
            historyCandidates: [],
          },
        ],
        unreviewablePaths: [],
      },
    });
    vi.mocked(application.submitObservationGapReview).mockResolvedValueOnce({
      kind: "stale",
    });
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() =>
      expect(modal.contentEl.querySelectorAll("button")).toHaveLength(3),
    );
    modal.contentEl.querySelectorAll("button")[2]?.click();
    await vi.waitFor(() =>
      expect(application.closeObservationGapReview).toHaveBeenCalledOnce(),
    );
    expect(modal.contentEl.querySelectorAll("p")[0]?.textContent).toContain(
      "all untransferred reservations remain held",
    );
  });

  it("shows a fixed message when the complete group sample is unavailable", async () => {
    const application = owner();
    const path = required(normalizeNotePath("notes/unavailable.md"));
    const predecessorOperationId = required(
      createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
    );
    const modal = new ObservationGapReviewModal(
      new App(),
      application,
      "33333333-3333-4333-8333-333333333333",
      [{ operationId: predecessorOperationId, paths: [path] }],
    );

    modal.open();
    modal.contentEl.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() =>
      expect(modal.contentEl.querySelectorAll("p")[0]?.textContent).toContain(
        "complete fresh review is unavailable",
      ),
    );
    expect(application.submitObservationGapReview).not.toHaveBeenCalled();
  });

  it("suppresses a delayed modal after detach", async () => {
    const candidates =
      Promise.withResolvers<
        Awaited<
          ReturnType<ReconciliationUiOwner["listReconciliationCandidates"]>
        >
      >();
    const application = owner();
    vi.mocked(application.listReconciliationCandidates).mockReturnValueOnce(
      candidates.promise,
    );
    const fixture = host();
    const open = vi
      .spyOn(ReconciliationReviewModal.prototype, "open")
      .mockImplementation(() => undefined);
    const commands = new ReconciliationCommands(
      fixture.plugin,
      application,
      "33333333-3333-4333-8333-333333333333",
    );
    commands.register();

    fixture.commands[0]?.callback?.();
    commands.detach();
    candidates.resolve({ kind: "available", candidates: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(open).not.toHaveBeenCalled();
  });
});
