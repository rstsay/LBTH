export function adminCapabilities(role) {
  return {
    canManageAdministrators: role === "owner",
    canReadAuditLogs: role === "owner" || role === "auditor",
    canManageGames: role === "owner" || role === "admin",
    canReadAnomalies: role === "owner" || role === "admin" || role === "auditor",
    canReviewAnomalies: role === "owner" || role === "admin",
    canManageProgressResets: role === "owner" || role === "admin",
  };
}
