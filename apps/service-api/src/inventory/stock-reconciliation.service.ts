import type { AdminStockReconciliationResolveRequest } from "@vem/shared";

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AuditService } from "../audit/audit.service";
import {
  mapStockReconciliationResolveDtoToRepositoryInput,
  toAdminStockReconciliationCaseDetailResponse,
  toAdminStockReconciliationCaseSummaryResponse,
  toStockReconciliationResolutionResponse,
} from "./stock-reconciliation.contract-mappers";
import {
  StockReconciliationRepository,
  type StockReconciliationPageQuery,
  type StockReconciliationResolveInput,
} from "./stock-reconciliation.repository";

export type {
  StockReconciliationRepository,
  StockReconciliationResolveInput,
} from "./stock-reconciliation.repository";

export type StockReconciliationResolveAction =
  StockReconciliationResolveInput["action"];

export type StockReconciliationResolveRequest =
  AdminStockReconciliationResolveRequest;

@Injectable()
export class StockReconciliationService {
  constructor(
    private readonly repository: StockReconciliationRepository,
    private readonly auditService: AuditService,
  ) {}

  async listCases(query: StockReconciliationPageQuery) {
    const result = await this.repository.listOpenCases(query);
    return {
      ...result,
      items: result.items.map(toAdminStockReconciliationCaseSummaryResponse),
    };
  }

  async getCase(id: string) {
    const row = await this.repository.findCaseDetail(id);
    if (!row)
      throw new NotFoundException("Stock reconciliation case not found");
    return toAdminStockReconciliationCaseDetailResponse(row);
  }

  async resolveCase(
    adminUserId: string,
    id: string,
    request: StockReconciliationResolveRequest,
  ) {
    const note = request.note.trim();
    if (!note) {
      throw new BadRequestException("Resolution note is required");
    }
    const repositoryInput = mapStockReconciliationResolveDtoToRepositoryInput(
      adminUserId,
      request,
    );
    const correctedOnHandQty = repositoryInput.correctedOnHandQty;
    if (
      repositoryInput.action === "manual_correct" &&
      (typeof correctedOnHandQty !== "number" ||
        !Number.isInteger(correctedOnHandQty) ||
        correctedOnHandQty < 0)
    ) {
      throw new BadRequestException(
        "correctedOnHandQty is required for manual correction",
      );
    }

    const resolved = await this.repository.resolveCase(id, {
      ...repositoryInput,
      note,
    });
    if (!resolved) {
      throw new NotFoundException("Stock reconciliation case not found");
    }

    await this.auditService.record({
      adminUserId,
      action: `stock_reconciliation.${repositoryInput.action}`,
      resourceType:
        resolved.case.caseTable === "machine_raw_stock_movement_conflicts"
          ? "machine_raw_stock_movement_conflict"
          : "machine_raw_stock_movement",
      resourceId: resolved.case.id,
      beforeJson: {
        status: resolved.previousCase.status,
        platformReviewStatus: resolved.previousCase.platformReviewStatus,
        saleSafetyBlockerState: resolved.previousCase.saleSafetyBlockerState,
        saleSafetyBlockerSlotId: resolved.previousCase.saleSafetyBlockerSlotId,
        onHandQty: resolved.previousCase.onHandQty,
      },
      afterJson: {
        action: repositoryInput.action,
        note,
        correctedOnHandQty,
        clearedBlocker: resolved.clearedBlocker,
        inventoryMovement: resolved.inventoryMovement,
      },
    });

    return toAdminStockReconciliationCaseDetailResponse(
      resolved.case,
      toStockReconciliationResolutionResponse(resolved, {
        action: repositoryInput.action,
        note,
      }),
    );
  }
}
