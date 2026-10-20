import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { attachIssueReviewTransferReceiptsSchema, requestIssueReviewTransferSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, issueService } from "../services/index.js";
import { issueReviewTransferService } from "../services/issue-review-transfer.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

export function issueReviewTransferRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const access = accessService(db);
  const transfers = issueReviewTransferService(db);

  async function assertCanMutate(req: Request, issue: NonNullable<Awaited<ReturnType<typeof issuesSvc.getById>>>) {
    assertCompanyAccess(req, issue.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId ?? null,
        parentIssueId: issue.parentId ?? null,
        assigneeAgentId: issue.assigneeAgentId ?? null,
        assigneeUserId: issue.assigneeUserId ?? null,
        status: issue.status,
      },
    });
    if (!decision.allowed) throw forbidden("You cannot change this task's review routing.");
  }

  router.post("/issues/:id/review-transfers", validate(requestIssueReviewTransferSchema), async (req, res) => {
    // Moving a review obligation changes who must approve a delivery, so it is
    // a board-governed action like other review overrides.
    assertBoard(req);
    const source = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!source) return;
    const destination = await getAccessibleResource(
      req,
      res,
      issuesSvc.getById(req.body.destinationIssueId),
      "Destination issue not found",
    );
    if (!destination) return;
    // Check each side independently: access to one task never implies the other.
    await assertCanMutate(req, source);
    await assertCanMutate(req, destination);

    const actor = getActorInfo(req);
    const result = await transfers.transfer(
      { ...req.body, companyId: source.companyId, sourceIssueId: source.id },
      { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId, runId: actor.runId },
    );
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.post(
    "/review-transfers/:transferId/receipts",
    validate(attachIssueReviewTransferReceiptsSchema),
    async (req, res) => {
      assertBoard(req);
      const transferId = req.params.transferId as string;
      // Resolve the transfer through an issue the caller can access, so a
      // transfer id from another company is indistinguishable from a missing one.
      const sourceIssueId = await transfers.sourceIssueIdFor(transferId);
      const source = sourceIssueId ? await issuesSvc.getById(sourceIssueId) : null;
      const accessible = await getAccessibleResource(req, res, source, "Review transfer not found");
      if (!accessible) return;
      const row = await transfers.getTransfer(accessible.companyId, transferId);
      if (!row) throw notFound("Review transfer not found");
      const destination = await issuesSvc.getById(row.destinationIssueId);
      if (!destination) throw notFound("Review transfer not found");
      await assertCanMutate(req, accessible);
      await assertCanMutate(req, destination);
      const actor = getActorInfo(req);
      const result = await transfers.attachReceipts(
        { ...req.body, companyId: accessible.companyId, transferId },
        { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId, runId: actor.runId },
      );
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.get("/issues/:id/review-transfers", async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    res.json(await transfers.readTransfers(issue.companyId, issue.id));
  });

  return router;
}
