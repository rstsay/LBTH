import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beginWriteTransaction } from "./database-reliability.ts";

export const LOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const GAME_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GAME_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface RetentionCleanupResult {
  locationSamplesDeleted: number;
  gamesDeleted: number;
  retainedEventsDeleted: number;
  auditRowsDeleted: number;
}

export function initializeDataRetentionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS retained_game_events (
      event_hash TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN ('collection', 'anomaly')),
      occurred_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retained_game_events_expires_idx
      ON retained_game_events(expires_at);

    CREATE TABLE IF NOT EXISTS data_retention_audit (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS data_retention_audit_created_idx
      ON data_retention_audit(created_at);
    CREATE TABLE IF NOT EXISTS data_retention_control (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      allow_audit_delete INTEGER NOT NULL CHECK(allow_audit_delete IN (0, 1))
    );
  `);
  database.exec(`
    DROP TRIGGER IF EXISTS admin_audit_log_immutable_delete;
    CREATE TRIGGER admin_audit_log_immutable_delete
    BEFORE DELETE ON admin_audit_log
    WHEN NOT EXISTS (
      SELECT 1 FROM data_retention_control
      WHERE id = 1 AND allow_audit_delete = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'admin audit records are immutable');
    END;
  `);
}

export function hashRetentionSubject(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function recordDataRetentionAudit(
  database: DatabaseSync,
  action: string,
  subject: string,
  timestamp: number,
): void {
  database
    .prepare(
      `INSERT INTO data_retention_audit (id, action, subject_hash, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), action, hashRetentionSubject(subject), timestamp);
}

function insertRetainedEvent(
  database: DatabaseSync,
  source: string,
  eventType: "collection" | "anomaly",
  occurredAt: number,
  expiresAt: number,
  details: Record<string, unknown>,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO retained_game_events (
        event_hash, event_type, occurred_at, expires_at, details_json
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      hashRetentionSubject(source),
      eventType,
      occurredAt,
      expiresAt,
      JSON.stringify(details),
    );
}

export function archiveGameEvents(
  database: DatabaseSync,
  gameId: string,
  closedAt: number,
  timestamp: number,
): void {
  const expiresAt = closedAt + GAME_EVENT_RETENTION_MS;
  if (expiresAt <= timestamp) {
    return;
  }
  const collections = database
    .prepare(
      `SELECT player_id, treasure_id, collected_at
       FROM collected_treasures WHERE game_id = ?`,
    )
    .all(gameId) as Array<{
    player_id: string;
    treasure_id: string;
    collected_at: number;
  }>;
  for (const collection of collections) {
    insertRetainedEvent(
      database,
      `collection:${gameId}:${collection.player_id}:${collection.treasure_id}`,
      "collection",
      collection.collected_at,
      expiresAt,
      { kind: "collection" },
    );
  }

  const anomalies = database
    .prepare(
      `SELECT id, signal_type, detected_at
       FROM anomaly_events WHERE game_id = ?`,
    )
    .all(gameId) as Array<{
    id: string;
    signal_type: string;
    detected_at: number;
  }>;
  for (const anomaly of anomalies) {
    insertRetainedEvent(
      database,
      `anomaly:${anomaly.id}`,
      "anomaly",
      anomaly.detected_at,
      expiresAt,
      { signalType: anomaly.signal_type },
    );
  }
}

export function archivePlayerEvents(
  database: DatabaseSync,
  playerId: string,
  timestamp: number,
): void {
  const collections = database
    .prepare(
      `SELECT c.game_id, c.treasure_id, c.collected_at,
              COALESCE(g.ended_at, g.ends_at) AS closed_at
       FROM collected_treasures c
       JOIN games g ON g.id = c.game_id
       WHERE c.player_id = ?`,
    )
    .all(playerId) as Array<{
    game_id: string;
    treasure_id: string;
    collected_at: number;
    closed_at: number;
  }>;
  for (const collection of collections) {
    const expiresAt = collection.closed_at + GAME_EVENT_RETENTION_MS;
    if (expiresAt > timestamp) {
      insertRetainedEvent(
        database,
        `collection:${collection.game_id}:${playerId}:${collection.treasure_id}`,
        "collection",
        collection.collected_at,
        expiresAt,
        { kind: "collection" },
      );
    }
  }

  const anomalies = database
    .prepare(
      `SELECT a.id, a.signal_type, a.detected_at,
              COALESCE(g.ended_at, g.ends_at) AS closed_at
       FROM anomaly_events a
       JOIN games g ON g.id = a.game_id
       WHERE a.player_id = ?`,
    )
    .all(playerId) as Array<{
    id: string;
    signal_type: string;
    detected_at: number;
    closed_at: number;
  }>;
  for (const anomaly of anomalies) {
    const expiresAt = anomaly.closed_at + GAME_EVENT_RETENTION_MS;
    if (expiresAt > timestamp) {
      insertRetainedEvent(
        database,
        `anomaly:${anomaly.id}`,
        "anomaly",
        anomaly.detected_at,
        expiresAt,
        { signalType: anomaly.signal_type },
      );
    }
  }
}

export function runDataRetentionCleanup(
  database: DatabaseSync,
  timestamp: number,
): RetentionCleanupResult {
  const result: RetentionCleanupResult = {
    locationSamplesDeleted: 0,
    gamesDeleted: 0,
    retainedEventsDeleted: 0,
    auditRowsDeleted: 0,
  };
  beginWriteTransaction(database);
  try {
    const locationDelete = database
      .prepare(
        `DELETE FROM location_samples
         WHERE (expires_at IS NOT NULL AND expires_at <= ?)
            OR (expires_at IS NULL AND game_id IN (
              SELECT id FROM games
              WHERE COALESCE(ended_at, ends_at) + ? <= ?
            ))`,
      )
      .run(timestamp, LOCATION_RETENTION_MS, timestamp);
    result.locationSamplesDeleted = Number(locationDelete.changes);
    if (result.locationSamplesDeleted > 0) {
      recordDataRetentionAudit(
        database,
        "location_samples_expired",
        `location-samples:${timestamp}:${result.locationSamplesDeleted}`,
        timestamp,
      );
    }

    const endedGames = database
      .prepare(
        `SELECT id, COALESCE(ended_at, ends_at) AS closed_at
         FROM games
         WHERE (status = 'ended' OR ends_at <= ?)
           AND COALESCE(ended_at, ends_at) + ? <= ?
         ORDER BY id`,
      )
      .all(timestamp, GAME_ARCHIVE_RETENTION_MS, timestamp) as Array<{
      id: string;
      closed_at: number;
    }>;
    for (const game of endedGames) {
      archiveGameEvents(database, game.id, game.closed_at, timestamp);
      const deletion = database.prepare("DELETE FROM games WHERE id = ?").run(game.id);
      if (Number(deletion.changes) === 1) {
        result.gamesDeleted += 1;
        recordDataRetentionAudit(
          database,
          "game_content_purged",
          game.id,
          timestamp,
        );
      }
    }

    const retainedDelete = database
      .prepare("DELETE FROM retained_game_events WHERE expires_at <= ?")
      .run(timestamp);
    result.retainedEventsDeleted = Number(retainedDelete.changes);
    if (result.retainedEventsDeleted > 0) {
      recordDataRetentionAudit(
        database,
        "retained_events_expired",
        `retained-events:${timestamp}:${result.retainedEventsDeleted}`,
        timestamp,
      );
    }

    database
      .prepare(
        `INSERT INTO data_retention_control (id, allow_audit_delete)
         VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET allow_audit_delete = 1`,
      )
      .run();
    const auditDelete = database
      .prepare("DELETE FROM admin_audit_log WHERE created_at < ?")
      .run(timestamp - AUDIT_RETENTION_MS);
    database
      .prepare("DELETE FROM data_retention_control WHERE id = 1")
      .run();
    result.auditRowsDeleted = Number(auditDelete.changes);
    if (result.auditRowsDeleted > 0) {
      recordDataRetentionAudit(
        database,
        "admin_audit_records_expired",
        `admin-audit:${timestamp}:${result.auditRowsDeleted}`,
        timestamp,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return result;
}
