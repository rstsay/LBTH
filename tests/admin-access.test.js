import { describe, expect, it } from "vitest";
import { adminCapabilities } from "../web/admin-access.js";

describe("administrator workspace access", () => {
  it("allows owners to manage administrators, review audit logs, and manage games", () => {
    expect(adminCapabilities("owner")).toEqual({
      canManageAdministrators: true,
      canReadAuditLogs: true,
      canManageGames: true,
      canReadAnomalies: true,
      canReviewAnomalies: true,
      canManageProgressResets: true,
    });
  });

  it("limits auditors to audit log reads", () => {
    expect(adminCapabilities("auditor")).toEqual({
      canManageAdministrators: false,
      canReadAuditLogs: true,
      canManageGames: false,
      canReadAnomalies: true,
      canReviewAnomalies: false,
      canManageProgressResets: false,
    });
  });

  it("does not expose owner-only tools to regular administrators or unknown roles", () => {
    expect(adminCapabilities("admin")).toEqual({
      canManageAdministrators: false,
      canReadAuditLogs: false,
      canManageGames: true,
      canReadAnomalies: true,
      canReviewAnomalies: true,
      canManageProgressResets: true,
    });
    expect(adminCapabilities("unknown")).toEqual({
      canManageAdministrators: false,
      canReadAuditLogs: false,
      canManageGames: false,
      canReadAnomalies: false,
      canReviewAnomalies: false,
      canManageProgressResets: false,
    });
  });
});
