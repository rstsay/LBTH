import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { COLLECTION_THRESHOLD_METERS, distanceMeters } from "../web/geo.js";
import type { Coordinates } from "../web/geo.js";
import {
  collectTreasure,
  MAXIMUM_GPS_ACCURACY_METERS,
  type CollectionRepository,
} from "./game-collection-service.ts";
import {
  GAME_EVENT_RETENTION_MS,
  archiveGameEvents,
  recordDataRetentionAudit,
} from "./retention.ts";
import { beginWriteTransaction } from "./database-reliability.ts";

const ARCHIVE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const PLAYER_GAME_HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;

interface GameRecord {
  id: string;
  name: string;
  description: string;
  starts_at: number;
  ends_at: number;
  timezone: string;
  map_center_latitude: number;
  map_center_longitude: number;
  status: "draft" | "published" | "paused" | "ended";
  ended_at: number | null;
  archive_restored_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ParticipantRecord {
  game_id: string;
  player_id: string;
  status: "playing" | "paused" | "exited";
  progress_json: string;
  device_token_hash: string | null;
  last_heartbeat_at: number | null;
}

interface TreasureRecord {
  id: string;
  game_id: string;
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  fuzzy_latitude: number;
  fuzzy_longitude: number;
  fuzzy_radius_meters: number;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface PlayerPosition extends Coordinates {
  accuracy: number;
  timestamp: number;
}

interface CollectedTreasureSnapshot {
  game_id: string;
  player_id: string;
  treasure_id: string;
  collected_at: number;
  distance_meters: number;
  accuracy: number;
}

export interface GameRouterOptions {
  database: DatabaseSync;
  now: () => number;
  createId?: () => string;
  getAdminActorId?: (request: Request) => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCollectedTreasureSnapshot(
  value: unknown,
): value is CollectedTreasureSnapshot {
  return (
    isRecord(value) &&
    typeof value.game_id === "string" &&
    typeof value.player_id === "string" &&
    typeof value.treasure_id === "string" &&
    typeof value.collected_at === "number" &&
    Number.isFinite(value.collected_at) &&
    typeof value.distance_meters === "number" &&
    Number.isFinite(value.distance_meters) &&
    typeof value.accuracy === "number" &&
    Number.isFinite(value.accuracy)
  );
}

function parseTimestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validMapCenter(value: unknown): value is { latitude: number; longitude: number } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.latitude === "number" &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === "number" &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

function parsePlayerPosition(value: unknown, now: number): PlayerPosition | undefined {
  if (
    !isRecord(value) ||
    value.isMock === true ||
    value.mode === "mock" ||
    value.gpsMode === "mock" ||
    value.source === "mock" ||
    typeof value.latitude !== "number" ||
    !Number.isFinite(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    typeof value.longitude !== "number" ||
    !Number.isFinite(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    typeof value.accuracy !== "number" ||
    !Number.isFinite(value.accuracy) ||
    value.accuracy < 0 ||
    typeof value.timestamp !== "number" ||
    !Number.isSafeInteger(value.timestamp) ||
    value.timestamp < 0 ||
    value.timestamp > now
  ) {
    return undefined;
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    accuracy: value.accuracy,
    timestamp: value.timestamp,
  };
}

function isGameCurrentlyPlayable(game: GameRecord, now: number): boolean {
  return game.status === "published" && now >= game.starts_at && now < game.ends_at;
}

function serializeGame(
  game: GameRecord,
  now: number,
  totalTreasuresCount = 0,
): Record<string, unknown> {
  let status: string = game.status;
  if (game.status === "published" || game.status === "paused") {
    if (now >= game.ends_at) {
      status =
        game.archive_restored_at === null && now < game.ends_at + ARCHIVE_PERIOD_MS
          ? "archived"
          : "ended";
    } else if (game.status === "published") {
      status = now < game.starts_at ? "scheduled" : "active";
    }
  } else if (game.status === "ended") {
    status =
      game.archive_restored_at === null &&
      game.ended_at !== null &&
      now < game.ended_at + ARCHIVE_PERIOD_MS
        ? "archived"
        : "ended";
  }

  return {
    id: game.id,
    name: game.name,
    description: game.description,
    startsAt: new Date(game.starts_at).toISOString(),
    endsAt: new Date(game.ends_at).toISOString(),
    timezone: game.timezone,
    mapCenter: {
      latitude: game.map_center_latitude,
      longitude: game.map_center_longitude,
    },
    totalTreasuresCount,
    status,
    createdAt: new Date(game.created_at).toISOString(),
    updatedAt: new Date(game.updated_at).toISOString(),
  };
}

function parseTreasureRecord(value: Record<string, SQLOutputValue>): TreasureRecord {
  const {
    id,
    game_id,
    title,
    description,
    latitude,
    longitude,
    fuzzy_latitude,
    fuzzy_longitude,
    fuzzy_radius_meters,
    enabled,
    sort_order,
    created_at,
    updated_at,
  } = value;
  if (
    typeof id !== "string" ||
    typeof game_id !== "string" ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof fuzzy_latitude !== "number" ||
    typeof fuzzy_longitude !== "number" ||
    typeof fuzzy_radius_meters !== "number" ||
    typeof enabled !== "number" ||
    typeof sort_order !== "number" ||
    typeof created_at !== "number" ||
    typeof updated_at !== "number"
  ) {
    throw new Error("Stored treasure record is invalid");
  }
  return {
    id,
    game_id,
    title,
    description,
    latitude,
    longitude,
    fuzzy_latitude,
    fuzzy_longitude,
    fuzzy_radius_meters,
    enabled,
    sort_order,
    created_at,
    updated_at,
  };
}

function serializeTreasure(treasure: TreasureRecord): Record<string, unknown> {
  return {
    id: treasure.id,
    title: treasure.title,
    description: treasure.description,
    latitude: treasure.latitude,
    longitude: treasure.longitude,
    fuzzyLatitude: treasure.fuzzy_latitude,
    fuzzyLongitude: treasure.fuzzy_longitude,
    fuzzyRadiusMeters: treasure.fuzzy_radius_meters,
    enabled: treasure.enabled === 1,
    sortOrder: treasure.sort_order,
  };
}

function countAllTreasures(database: DatabaseSync, gameId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?")
    .get(gameId) as { count: number };
  return row.count;
}

function countEnabledTreasures(database: DatabaseSync, gameId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ? AND enabled = 1")
    .get(gameId) as { count: number };
  return row.count;
}

function hasPlayerCompletedGame(
  database: DatabaseSync,
  gameId: string,
  playerId: string,
): boolean {
  const counts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM treasures WHERE game_id = ? AND enabled = 1) AS target_count,
         (SELECT COUNT(*) FROM collected_treasures c
          JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
          WHERE c.game_id = ? AND c.player_id = ? AND t.enabled = 1) AS collected_count`,
    )
    .get(gameId, gameId, playerId) as {
    target_count: number;
    collected_count: number;
  };
  return counts.target_count > 0 && counts.collected_count === counts.target_count;
}

function refreshAuthoritativeProgress(
  database: DatabaseSync,
  gameId: string,
  playerId: string,
  timestamp: number,
): {
  progress: Record<string, unknown>;
  totalCollected: number;
  totalCollectedSoFar: number;
} {
  const participant = database
    .prepare(
      "SELECT progress_json FROM game_participants WHERE game_id = ? AND player_id = ?",
    )
    .get(gameId, playerId) as { progress_json: string } | undefined;
  if (!participant) {
    throw new Error("Player participation disappeared during collection");
  }

  const collections = database
    .prepare(
      `SELECT c.treasure_id, t.enabled
       FROM collected_treasures c
       JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
       WHERE c.game_id = ? AND c.player_id = ?
       ORDER BY c.collected_at, c.treasure_id`,
    )
    .all(gameId, playerId) as Array<{ treasure_id: string; enabled: number }>;
  const targetTreasureCount = countEnabledTreasures(database, gameId);
  const collectedCount = collections.filter((collection) => collection.enabled === 1).length;
  const previousProgress = JSON.parse(participant.progress_json) as Record<string, unknown>;
  const progress = {
    ...previousProgress,
    collectedTreasureIds: collections.map((collection) => collection.treasure_id),
    collectedCount,
    targetTreasureCount,
    completed: targetTreasureCount > 0 && collectedCount === targetTreasureCount,
  };
  const totalCollectedSoFar = (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM collected_treasures WHERE player_id = ?",
      )
      .get(playerId) as { count: number }
  ).count;

  database
    .prepare(
      `UPDATE game_participants SET progress_json = ?, updated_at = ?
       WHERE game_id = ? AND player_id = ?`,
    )
    .run(JSON.stringify(progress), timestamp, gameId, playerId);

  return {
    progress,
    totalCollected: collections.length,
    totalCollectedSoFar,
  };
}

function recordAnomaly(
  database: DatabaseSync,
  createId: () => string,
  gameId: string,
  playerId: string,
  signalType: string,
  dedupeKey: string,
  detectedAt: number,
  details: Record<string, unknown>,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO anomaly_events (
        id, game_id, player_id, signal_type, details_json, detected_at, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId(),
      gameId,
      playerId,
      signalType,
      JSON.stringify(details),
      detectedAt,
      dedupeKey,
    );
}

function recordLocationAnomalies(
  database: DatabaseSync,
  createId: () => string,
  gameId: string,
  playerId: string,
  position: PlayerPosition,
): void {
  database
    .prepare("DELETE FROM location_samples WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(position.timestamp);
  const previous = database
    .prepare(
      `SELECT * FROM location_samples
       WHERE game_id = ? AND player_id = ? AND expires_at IS NULL
       ORDER BY measured_at DESC LIMIT 1`,
    )
    .get(gameId, playerId) as
    | {
        id: string;
        latitude: number;
        longitude: number;
        accuracy: number;
        measured_at: number;
      }
    | undefined;
  const sampleId = createId();
  database
    .prepare(
      `INSERT INTO location_samples (
        id, game_id, player_id, latitude, longitude, accuracy, measured_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      sampleId,
      gameId,
      playerId,
      position.latitude,
      position.longitude,
      position.accuracy,
      position.timestamp,
    );
  if (!previous || position.timestamp <= previous.measured_at) {
    return;
  }

  const elapsedMilliseconds = position.timestamp - previous.measured_at;
  const rawDistanceMeters = distanceMeters(position, {
    latitude: previous.latitude,
    longitude: previous.longitude,
  });
  const accuracyAdjustedDistanceMeters = Math.max(
    0,
    rawDistanceMeters - previous.accuracy - position.accuracy,
  );
  const speedKilometersPerHour =
    (accuracyAdjustedDistanceMeters / elapsedMilliseconds) * 3.6 * 1000;
  const sampleDetails = {
    previousSampleId: previous.id,
    currentSampleId: sampleId,
    elapsedMilliseconds,
    rawDistanceMeters,
    accuracyAdjustedDistanceMeters,
    previousAccuracyMeters: previous.accuracy,
    accuracyMeters: position.accuracy,
    speedKilometersPerHour,
  };
  const segmentKey = `${gameId}:${playerId}:${previous.id}:${sampleId}`;
  if (elapsedMilliseconds <= 120_000 && rawDistanceMeters > 1_000) {
    recordAnomaly(
      database,
      createId,
      gameId,
      playerId,
      "location_jump",
      `location_jump:${segmentKey}`,
      position.timestamp,
      sampleDetails,
    );
  }
  if (speedKilometersPerHour > 45) {
    recordAnomaly(
      database,
      createId,
      gameId,
      playerId,
      "speed",
      `speed:${segmentKey}`,
      position.timestamp,
      sampleDetails,
    );
  }
}

function recordCollectionAttempt(
  database: DatabaseSync,
  createId: () => string,
  gameId: string,
  playerId: string,
  treasureId: string,
  timestamp: number,
): void {
  const windowStartedAt = timestamp - 5 * 60 * 1000;
  database
    .prepare("DELETE FROM collection_attempts WHERE attempted_at < ?")
    .run(windowStartedAt);
  database
    .prepare(
      `INSERT INTO collection_attempts (
        id, game_id, player_id, treasure_id, attempted_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(createId(), gameId, playerId, treasureId, timestamp);
  const attemptCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM collection_attempts
         WHERE game_id = ? AND player_id = ? AND treasure_id = ? AND attempted_at >= ?`,
      )
      .get(gameId, playerId, treasureId, windowStartedAt) as { count: number }
  ).count;
  if (attemptCount >= 10) {
    recordAnomaly(
      database,
      createId,
      gameId,
      playerId,
      "repeated_collection_attempts",
      `repeated_collection_attempts:${gameId}:${playerId}:${treasureId}:${Math.floor(timestamp / 300_000)}`,
      timestamp,
      { treasureId, attemptCount, windowMilliseconds: 5 * 60 * 1000 },
    );
  }
}

function listTreasures(database: DatabaseSync, gameId: string): TreasureRecord[] {
  return database
    .prepare("SELECT * FROM treasures WHERE game_id = ? ORDER BY sort_order, id")
    .all(gameId)
    .map(parseTreasureRecord);
}

function findTreasure(
  database: DatabaseSync,
  gameId: string,
  treasureId: string,
): TreasureRecord | undefined {
  const row = database
    .prepare("SELECT * FROM treasures WHERE game_id = ? AND id = ?")
    .get(gameId, treasureId);
  return row === undefined ? undefined : parseTreasureRecord(row);
}

interface TreasureInput {
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  fuzzyLatitude: number;
  fuzzyLongitude: number;
  fuzzyRadiusMeters: number;
  enabled: boolean;
  sortOrder: number;
}

interface TreasureImportIssue {
  row: number;
  field: string;
  code: string;
  reason: string;
}

interface TreasureImportRow {
  row: number;
  treasure: TreasureInput;
}

interface TreasureImportResult {
  validRows: TreasureImportRow[];
  errors: TreasureImportIssue[];
}

type TreasureImportMode = "all_or_nothing" | "skip_invalid";

const TREASURE_IMPORT_FIELDS = new Set([
  "title",
  "latitude",
  "longitude",
  "fuzzyLatitude",
  "fuzzyLongitude",
  "description",
  "fuzzyRadiusMeters",
  "enabled",
  "sortOrder",
]);

function coordinateKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function parseTreasureImport(
  value: unknown,
  existingTreasures: TreasureRecord[],
): TreasureImportResult {
    const errors: TreasureImportIssue[] = [];
    if (!isRecord(value)) {
      return {
        validRows: [],
        errors: [
          {
            row: 0,
            field: "body",
            code: "INVALID_FORMAT",
            reason: "匯入內容必須是 JSON 物件。",
          },
        ],
      };
    }
    if (value.schemaVersion !== 1) {
      errors.push({
        row: 0,
        field: "schemaVersion",
        code: "UNSUPPORTED_VERSION",
        reason: "schemaVersion 必須是整數 1。",
      });
    }
    if (!Array.isArray(value.treasures)) {
      errors.push({
        row: 0,
        field: "treasures",
        code: "INVALID_TYPE",
        reason: "treasures 必須是 JSON 陣列。",
      });
    }
    if (errors.length > 0) {
      return { validRows: [], errors };
    }

    const rows = value.treasures as unknown[];
    if (rows.length > 500) {
      return {
        validRows: [],
        errors: [
          {
            row: 0,
            field: "treasures",
            code: "TOO_MANY_ROWS",
            reason: "單次匯入最多只能包含 500 筆寶藏。",
          },
        ],
      };
    }

    const occupiedCoordinates = new Set(
      existingTreasures.map((treasure) =>
        coordinateKey(treasure.latitude, treasure.longitude),
      ),
    );
    const validRows: TreasureImportRow[] = [];
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 1;
      const rowErrors: TreasureImportIssue[] = [];
      if (!isRecord(row)) {
        errors.push({
          row: rowNumber,
          field: "row",
          code: "INVALID_ROW",
          reason: "每一列必須是 JSON 物件。",
        });
        continue;
      }
      for (const field of Object.keys(row)) {
        if (!TREASURE_IMPORT_FIELDS.has(field)) {
          rowErrors.push({
            row: rowNumber,
            field,
            code: "UNSUPPORTED_FIELD",
            reason: `欄位 ${field} 不在匯入格式中；寶藏 ID 由伺服器產生。`,
          });
        }
      }

      for (const field of [
        "title",
        "latitude",
        "longitude",
        "fuzzyLatitude",
        "fuzzyLongitude",
      ]) {
        if (!(field in row)) {
          rowErrors.push({
            row: rowNumber,
            field,
            code: "REQUIRED",
            reason: `缺少必填欄位 ${field}。`,
          });
        }
      }

      if ("title" in row && typeof row.title !== "string") {
        rowErrors.push({
          row: rowNumber,
          field: "title",
          code: "INVALID_TYPE",
          reason: "title 必須是字串。",
        });
      } else if (
        typeof row.title === "string" &&
        (row.title.trim().length === 0 || row.title.trim().length > 120)
      ) {
        rowErrors.push({
          row: rowNumber,
          field: "title",
          code: "INVALID_VALUE",
          reason: "title 必須是 1 至 120 個字元的非空字串。",
        });
      }

      for (const [field, maximum] of [
        ["latitude", 90],
        ["fuzzyLatitude", 90],
        ["longitude", 180],
        ["fuzzyLongitude", 180],
      ] as const) {
        if (!(field in row)) {
          continue;
        }
        const coordinate = row[field];
        if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
          rowErrors.push({
            row: rowNumber,
            field,
            code: "INVALID_TYPE",
            reason: `${field} 必須是有限數值。`,
          });
        } else if (coordinate < -maximum || coordinate > maximum) {
          rowErrors.push({
            row: rowNumber,
            field,
            code: "OUT_OF_RANGE",
            reason: `${field} 必須介於 ${-maximum} 至 ${maximum} 之間。`,
          });
        }
      }

      if (
        "description" in row &&
        (typeof row.description !== "string" || row.description.length > 2000)
      ) {
        rowErrors.push({
          row: rowNumber,
          field: "description",
          code: "INVALID_VALUE",
          reason: "description 必須是最多 2,000 個字元的字串。",
        });
      }
      if (
        "fuzzyRadiusMeters" in row &&
        (typeof row.fuzzyRadiusMeters !== "number" ||
          !Number.isInteger(row.fuzzyRadiusMeters) ||
          row.fuzzyRadiusMeters < 20 ||
          row.fuzzyRadiusMeters > 1000)
      ) {
        rowErrors.push({
          row: rowNumber,
          field: "fuzzyRadiusMeters",
          code: "OUT_OF_RANGE",
          reason: "fuzzyRadiusMeters 必須是 20 至 1,000 公尺的整數。",
        });
      }
      if ("enabled" in row && typeof row.enabled !== "boolean") {
        rowErrors.push({
          row: rowNumber,
          field: "enabled",
          code: "INVALID_TYPE",
          reason: "enabled 必須是布林值。",
        });
      }
      if (
        "sortOrder" in row &&
        (typeof row.sortOrder !== "number" ||
          !Number.isSafeInteger(row.sortOrder) ||
          row.sortOrder < 0)
      ) {
        rowErrors.push({
          row: rowNumber,
          field: "sortOrder",
          code: "INVALID_VALUE",
          reason: "sortOrder 必須是非負安全整數。",
        });
      }

      if (rowErrors.length === 0) {
        const input = parseTreasureInput({
          ...row,
          description: row.description ?? "",
          fuzzyRadiusMeters: row.fuzzyRadiusMeters ?? 100,
          enabled: row.enabled ?? true,
          sortOrder: row.sortOrder ?? index,
        });
        if (!input) {
          throw new Error("Validated treasure import row could not be normalized");
        }
        const key = coordinateKey(input.latitude, input.longitude);
        if (occupiedCoordinates.has(key)) {
          rowErrors.push({
            row: rowNumber,
            field: "latitude",
            code: "DUPLICATE_COORDINATES",
            reason: "精確座標四捨五入至小數點後六位後，與既有或其他列重複。",
          });
        } else {
          occupiedCoordinates.add(key);
          validRows.push({ row: rowNumber, treasure: input });
        }
      }
      errors.push(...rowErrors);
    }

    const remainingCapacity = Math.max(0, 500 - existingTreasures.length);
    if (validRows.length > remainingCapacity) {
      const overflowRows = validRows.splice(remainingCapacity);
      for (const { row } of overflowRows) {
        errors.push({
          row,
          field: "treasures",
          code: "GAME_CAPACITY_EXCEEDED",
          reason: "匯入後單場寶藏總數不可超過 500。",
        });
      }
    }

  return { validRows, errors };
}

function parseTreasureInput(
  value: unknown,
  defaults?: TreasureRecord,
): TreasureInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const allowedFields = new Set([
    "title",
    "description",
    "latitude",
    "longitude",
    "fuzzyLatitude",
    "fuzzyLongitude",
    "fuzzyRadiusMeters",
    "enabled",
    "sortOrder",
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    return undefined;
  }
  const title = value.title === undefined ? defaults?.title : value.title;
  const description =
    value.description === undefined ? defaults?.description ?? "" : value.description;
  const latitude = value.latitude === undefined ? defaults?.latitude : value.latitude;
  const longitude = value.longitude === undefined ? defaults?.longitude : value.longitude;
  const fuzzyLatitude =
    value.fuzzyLatitude === undefined ? defaults?.fuzzy_latitude : value.fuzzyLatitude;
  const fuzzyLongitude =
    value.fuzzyLongitude === undefined ? defaults?.fuzzy_longitude : value.fuzzyLongitude;
  const fuzzyRadiusMeters =
    value.fuzzyRadiusMeters === undefined
      ? defaults?.fuzzy_radius_meters ?? 100
      : value.fuzzyRadiusMeters;
  const enabled =
    value.enabled === undefined ? defaults?.enabled !== 0 : value.enabled;
  const sortOrder =
    value.sortOrder === undefined ? defaults?.sort_order ?? 0 : value.sortOrder;

  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.trim().length > 120 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof fuzzyLatitude !== "number" ||
    !Number.isFinite(fuzzyLatitude) ||
    fuzzyLatitude < -90 ||
    fuzzyLatitude > 90 ||
    typeof fuzzyLongitude !== "number" ||
    !Number.isFinite(fuzzyLongitude) ||
    fuzzyLongitude < -180 ||
    fuzzyLongitude > 180 ||
    typeof fuzzyRadiusMeters !== "number" ||
    !Number.isInteger(fuzzyRadiusMeters) ||
    fuzzyRadiusMeters < 20 ||
    fuzzyRadiusMeters > 1000 ||
    typeof enabled !== "boolean" ||
    typeof sortOrder !== "number" ||
    !Number.isSafeInteger(sortOrder) ||
    sortOrder < 0
  ) {
    return undefined;
  }

  return {
    title: title.trim(),
    description: description.trim(),
    latitude,
    longitude,
    fuzzyLatitude,
    fuzzyLongitude,
    fuzzyRadiusMeters,
    enabled,
    sortOrder,
  };
}

function requireTreasure(
  database: DatabaseSync,
  gameId: string,
  treasureId: string,
): TreasureRecord {
  const treasure = findTreasure(database, gameId, treasureId);
  if (!treasure) {
    throw new Error("Treasure disappeared during an update");
  }
  return treasure;
}

function findGame(database: DatabaseSync, gameId: string): GameRecord | undefined {
  const row = database.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
  return row === undefined ? undefined : parseGameRecord(row);
}

function requireGame(database: DatabaseSync, gameId: string): GameRecord {
  const game = findGame(database, gameId);
  if (!game) {
    throw new Error("Game disappeared during a lifecycle operation");
  }
  return game;
}

function parseGameRecord(value: Record<string, SQLOutputValue>): GameRecord {
  const {
    id,
    name,
    description,
    starts_at,
    ends_at,
    timezone,
    map_center_latitude,
    map_center_longitude,
    status,
    ended_at,
    archive_restored_at,
    created_at,
    updated_at,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof starts_at !== "number" ||
    typeof ends_at !== "number" ||
    typeof timezone !== "string" ||
    typeof map_center_latitude !== "number" ||
    typeof map_center_longitude !== "number" ||
    (status !== "draft" &&
      status !== "published" &&
      status !== "paused" &&
      status !== "ended") ||
    (ended_at !== null && typeof ended_at !== "number") ||
    (archive_restored_at !== null && typeof archive_restored_at !== "number") ||
    typeof created_at !== "number" ||
    typeof updated_at !== "number"
  ) {
    throw new Error("Stored game record is invalid");
  }
  return {
    id,
    name,
    description,
    starts_at,
    ends_at,
    timezone,
    map_center_latitude,
    map_center_longitude,
    status,
    ended_at,
    archive_restored_at,
    created_at,
    updated_at,
  };
}

function routeGameId(request: Request): string | undefined {
  const gameId = request.params.gameId;
  return typeof gameId === "string" ? gameId : undefined;
}

function findPlayerId(response: Response): string | undefined {
  const playerId = response.locals.playerId;
  return typeof playerId === "string" ? playerId : undefined;
}

function findPlayerDeviceTokenHash(response: Response): string | undefined {
  const tokenHash = response.locals.playerDeviceTokenHash;
  return typeof tokenHash === "string" ? tokenHash : undefined;
}

function respondNotFound(response: Response): void {
  response.status(404).json({ error: "找不到指定的遊戲。" });
}

function respondConflict(response: Response, message: string): void {
  response.status(409).json({ error: message });
}

export function initializeGameSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      timezone TEXT NOT NULL,
      map_center_latitude REAL NOT NULL,
      map_center_longitude REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'paused', 'ended')),
      ended_at INTEGER,
      archive_restored_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(starts_at < ends_at)
    );

    CREATE TABLE IF NOT EXISTS game_participants (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('playing', 'paused', 'exited')),
      progress_json TEXT NOT NULL DEFAULT '{}',
      device_token_hash TEXT,
      last_heartbeat_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS treasures (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
      longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
      fuzzy_latitude REAL NOT NULL CHECK(fuzzy_latitude >= -90 AND fuzzy_latitude <= 90),
      fuzzy_longitude REAL NOT NULL CHECK(fuzzy_longitude >= -180 AND fuzzy_longitude <= 180),
      fuzzy_radius_meters INTEGER NOT NULL CHECK(fuzzy_radius_meters BETWEEN 20 AND 1000),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS treasures_game_sort_idx
      ON treasures(game_id, sort_order, id);

    CREATE TABLE IF NOT EXISTS collected_treasures (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      treasure_id TEXT NOT NULL REFERENCES treasures(id) ON DELETE CASCADE,
      collected_at INTEGER NOT NULL,
      distance_meters REAL NOT NULL,
      accuracy REAL NOT NULL,
      PRIMARY KEY (game_id, player_id, treasure_id)
    );

    CREATE TABLE IF NOT EXISTS location_samples (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy REAL NOT NULL,
      measured_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS location_samples_player_game_time_idx
      ON location_samples(game_id, player_id, measured_at DESC);

    CREATE TABLE IF NOT EXISTS collection_attempts (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      treasure_id TEXT NOT NULL REFERENCES treasures(id) ON DELETE CASCADE,
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collection_attempts_window_idx
      ON collection_attempts(game_id, player_id, treasure_id, attempted_at);

    CREATE TABLE IF NOT EXISTS anomaly_events (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      signal_type TEXT NOT NULL CHECK(signal_type IN ('location_jump', 'speed', 'repeated_collection_attempts')),
      details_json TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'awaiting_second_review', 'reviewed')),
      decision TEXT CHECK(decision IS NULL OR decision IN ('confirmed', 'dismissed'))
    );
    CREATE INDEX IF NOT EXISTS anomaly_events_status_detected_idx
      ON anomaly_events(status, detected_at);

    CREATE TABLE IF NOT EXISTS anomaly_reviews (
      id TEXT PRIMARY KEY,
      anomaly_id TEXT NOT NULL REFERENCES anomaly_events(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('confirmed', 'dismissed')),
      notes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(anomaly_id, actor_id)
    );

    CREATE TABLE IF NOT EXISTS progress_reset_requests (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      confirmed_by TEXT,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      restored_by TEXT,
      restored_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('awaiting_confirmation', 'completed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS progress_reset_pending_player_idx
      ON progress_reset_requests(game_id, player_id)
      WHERE status = 'awaiting_confirmation';

    CREATE TABLE IF NOT EXISTS anomaly_audit_log (
      id TEXT PRIMARY KEY,
      anomaly_id TEXT REFERENCES anomaly_events(id) ON DELETE SET NULL,
      reset_id TEXT REFERENCES progress_reset_requests(id) ON DELETE SET NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS game_participants_one_playing_game_per_player_idx
      ON game_participants(player_id)
      WHERE status = 'playing';

  `);
  const participantColumns = database
    .prepare("PRAGMA table_info(game_participants)")
    .all() as Array<{ name: string }>;
  if (!participantColumns.some((column) => column.name === "device_token_hash")) {
    database.exec("ALTER TABLE game_participants ADD COLUMN device_token_hash TEXT");
  }
  if (!participantColumns.some((column) => column.name === "last_heartbeat_at")) {
    database.exec("ALTER TABLE game_participants ADD COLUMN last_heartbeat_at INTEGER");
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS game_participants_heartbeat_idx
     ON game_participants(status, last_heartbeat_at)`,
  );
  database.exec(
    `UPDATE game_participants SET last_heartbeat_at = updated_at
     WHERE status = 'playing' AND last_heartbeat_at IS NULL`,
  );
  const resetColumns = database
    .prepare("PRAGMA table_info(progress_reset_requests)")
    .all() as Array<{ name: string }>;
  if (!resetColumns.some((column) => column.name === "snapshot_json")) {
    database.exec(
      "ALTER TABLE progress_reset_requests ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'",
    );
  }
  if (!resetColumns.some((column) => column.name === "restored_by")) {
    database.exec("ALTER TABLE progress_reset_requests ADD COLUMN restored_by TEXT");
  }
  if (!resetColumns.some((column) => column.name === "restored_at")) {
    database.exec("ALTER TABLE progress_reset_requests ADD COLUMN restored_at INTEGER");
  }
}

export function pauseStalePlayerGameSessions(
  database: DatabaseSync,
  timestamp: number,
): number {
  const cutoff = timestamp - PLAYER_GAME_HEARTBEAT_TIMEOUT_MS;
  const staleParticipants = database
    .prepare(
      `SELECT participant.game_id, participant.player_id
       FROM game_participants participant
       JOIN games game ON game.id = participant.game_id
       WHERE participant.status = 'playing'
         AND (
           COALESCE(participant.last_heartbeat_at, participant.updated_at) <= ? OR
           game.status != 'published' OR game.starts_at > ? OR game.ends_at <= ?
         )`,
    )
    .all(cutoff, timestamp, timestamp) as Array<{ game_id: string; player_id: string }>;
  if (staleParticipants.length === 0) return 0;

  beginWriteTransaction(database);
  try {
    let pausedCount = 0;
    for (const participant of staleParticipants) {
      const result = database
        .prepare(
          `UPDATE game_participants SET status = 'paused', device_token_hash = NULL,
             last_heartbeat_at = NULL, updated_at = ?
           WHERE game_id = ? AND player_id = ? AND status = 'playing'
             AND (
               COALESCE(last_heartbeat_at, updated_at) <= ? OR
               EXISTS (
                 SELECT 1 FROM games game WHERE game.id = game_participants.game_id
                   AND (game.status != 'published' OR game.starts_at > ? OR game.ends_at <= ?)
               )
             )`,
        )
        .run(timestamp, participant.game_id, participant.player_id, cutoff, timestamp, timestamp);
      if (Number(result.changes) !== 1) continue;
      pausedCount += 1;
      database
        .prepare(
          `UPDATE location_samples SET expires_at = ?
           WHERE game_id = ? AND player_id = ? AND expires_at IS NULL`,
        )
        .run(timestamp + 24 * 60 * 60 * 1000, participant.game_id, participant.player_id);
    }
    database.exec("COMMIT");
    return pausedCount;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function createAdminGameRouter(options: GameRouterOptions): Router {
  const router = Router();
  const createId = options.createId ?? randomUUID;

  router.post("/:gameId/mock-gps/test", (request, response) => {
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "Mock GPS 僅可用於未發布草稿。");
      return;
    }
    if (
      !isRecord(request.body) ||
      typeof request.body.treasureId !== "string" ||
      typeof request.body.latitude !== "number" ||
      !Number.isFinite(request.body.latitude) ||
      request.body.latitude < -90 ||
      request.body.latitude > 90 ||
      typeof request.body.longitude !== "number" ||
      !Number.isFinite(request.body.longitude) ||
      request.body.longitude < -180 ||
      request.body.longitude > 180 ||
      typeof request.body.accuracy !== "number" ||
      !Number.isFinite(request.body.accuracy) ||
      request.body.accuracy < 0
    ) {
      response.status(400).json({ error: "Mock GPS 測試資料無效。" });
      return;
    }
    const treasure = findTreasure(options.database, game.id, request.body.treasureId);
    if (!treasure) {
      respondNotFound(response);
      return;
    }
    if (treasure.enabled !== 1) {
      respondConflict(response, "此寶藏已停用，不能進行 Mock GPS 測試。");
      return;
    }

    const distance = distanceMeters(
      { latitude: request.body.latitude, longitude: request.body.longitude },
      { latitude: treasure.latitude, longitude: treasure.longitude },
    );
    const accuracyAccepted = request.body.accuracy <= MAXIMUM_GPS_ACCURACY_METERS;
    const withinThreshold = distance <= COLLECTION_THRESHOLD_METERS;
    response.json({
      mode: "mock",
      treasureId: treasure.id,
      distanceMeters: distance,
      thresholdMeters: COLLECTION_THRESHOLD_METERS,
      accuracyAccepted,
      withinThreshold,
      collectible: accuracyAccepted && withinThreshold,
    });
  });

  router.get("/players", (request, response) => {
    const gameId = request.query.gameId;
    const anonymousCode = request.query.anonymousCode;
    if (
      typeof gameId !== "string" ||
      gameId.trim().length === 0 ||
      typeof anonymousCode !== "string" ||
      anonymousCode.trim().length < 3 ||
      anonymousCode.trim().length > 40
    ) {
      response.status(400).json({ error: "請選擇遊戲並輸入至少 3 個字元的匿名代碼。" });
      return;
    }
    const game = options.database
      .prepare("SELECT id, name FROM games WHERE id = ?")
      .get(gameId.trim()) as { id: string; name: string } | undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    const players = options.database
      .prepare(
        "SELECT p.id AS player_id, p.anonymous_code, gp.game_id, " +
          "g.name AS game_name, " +
          "(SELECT COUNT(*) FROM collected_treasures c " +
          "JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id " +
          "WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id " +
          "AND t.enabled = 1) AS collected_count, " +
          "(SELECT COUNT(*) FROM treasures t " +
          "WHERE t.game_id = gp.game_id AND t.enabled = 1) AS target_treasure_count " +
          "FROM game_participants gp " +
          "JOIN players p ON p.id = gp.player_id " +
          "JOIN games g ON g.id = gp.game_id " +
          "WHERE gp.game_id = ? AND instr(upper(p.anonymous_code), upper(?)) > 0 " +
          "ORDER BY p.anonymous_code LIMIT 100",
      )
      .all(game.id, anonymousCode.trim()) as Array<{
      player_id: string;
      anonymous_code: string;
      game_id: string;
      game_name: string;
      collected_count: number;
      target_treasure_count: number;
    }>;
    response.setHeader("Cache-Control", "no-store");
    response.json({
      players: players.map((player) => {
        const collections = options.database
          .prepare(
            "SELECT t.title AS treasure_title, c.collected_at, c.distance_meters " +
              "FROM collected_treasures c " +
              "JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id " +
              "JOIN games g ON g.id = c.game_id " +
              "WHERE c.game_id = ? AND c.player_id = ? " +
              "AND COALESCE(g.ended_at, g.ends_at) + ? > ? " +
              "ORDER BY c.collected_at DESC LIMIT 101",
          )
          .all(
            player.game_id,
            player.player_id,
            GAME_EVENT_RETENTION_MS,
            options.now(),
          ) as Array<{
          treasure_title: string;
          collected_at: number;
          distance_meters: number;
        }>;
        return {
          playerId: player.player_id,
          anonymousCode: player.anonymous_code,
          gameId: player.game_id,
          gameName: player.game_name,
          collectedCount: player.collected_count,
          targetTreasureCount: player.target_treasure_count,
          completed:
            player.target_treasure_count > 0 &&
            player.collected_count === player.target_treasure_count,
          collections: collections.slice(0, 100).map((collection) => ({
            treasureTitle: collection.treasure_title,
            collectedAt: new Date(collection.collected_at).toISOString(),
            distanceMeters: Math.round(collection.distance_meters * 10) / 10,
          })),
          hasMoreCollections: collections.length > 100,
        };
      }),
    });
  });

  router.get("/operations", (_request, response) => {
    const games = options.database
      .prepare(
        `WITH enabled_treasures AS (
           SELECT game_id, COUNT(*) AS target_count
           FROM treasures WHERE enabled = 1 GROUP BY game_id
         ),
         player_progress AS (
           SELECT gp.game_id, gp.player_id,
                  COALESCE(et.target_count, 0) AS target_count,
                  (SELECT COUNT(*) FROM collected_treasures c
                   JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
                   WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id AND t.enabled = 1) AS collected_count
           FROM game_participants gp
           LEFT JOIN enabled_treasures et ON et.game_id = gp.game_id
         ),
         completed AS (
           SELECT game_id, COUNT(*) AS completed_count
           FROM player_progress
           WHERE target_count > 0 AND collected_count >= target_count
           GROUP BY game_id
         ),
         collection_totals AS (
           SELECT game_id, COUNT(*) AS collection_count
           FROM collected_treasures GROUP BY game_id
         )
         SELECT g.id, g.name, g.status,
                (SELECT COUNT(*) FROM game_participants gp WHERE gp.game_id = g.id) AS participant_count,
                COALESCE(ct.collection_count, 0) AS collection_count,
                (SELECT COUNT(*) FROM player_progress pp WHERE pp.game_id = g.id AND pp.target_count > 0) AS eligible_count,
                COALESCE(c.completed_count, 0) AS completed_count
         FROM games g
         LEFT JOIN collection_totals ct ON ct.game_id = g.id
         LEFT JOIN completed c ON c.game_id = g.id
         WHERE g.status != 'draft'
         ORDER BY g.starts_at DESC, g.id` ,
      )
      .all() as Array<{
      id: string;
      name: string;
      status: string;
      participant_count: number;
      collection_count: number;
      eligible_count: number;
      completed_count: number;
    }>;
    const leaderboard = options.database
      .prepare(
        `WITH collection_stats AS (
           SELECT player_id, COUNT(*) AS total_collected, MAX(collected_at) AS achieved_at
           FROM collected_treasures GROUP BY player_id
         ),
         per_game_progress AS (
           SELECT gp.player_id, gp.game_id,
                  (SELECT COUNT(*) FROM treasures t WHERE t.game_id = gp.game_id AND t.enabled = 1) AS target_count,
                  (SELECT COUNT(*) FROM collected_treasures c
                   JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
                   WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id AND t.enabled = 1) AS collected_count
           FROM game_participants gp
         ),
         completed_games AS (
           SELECT player_id, COUNT(*) AS completed_count FROM per_game_progress
           WHERE target_count > 0 AND collected_count = target_count GROUP BY player_id
         )
         SELECT COALESCE(NULLIF(p.nickname, ''), p.anonymous_code) AS display_name,
                COALESCE(cs.total_collected, 0) AS total_collected,
                COALESCE(cg.completed_count, 0) AS completed_games,
                COALESCE(cs.achieved_at, 0) AS achieved_at, p.id AS stable_id
         FROM players p
         LEFT JOIN collection_stats cs ON cs.player_id = p.id
         LEFT JOIN completed_games cg ON cg.player_id = p.id
         WHERE p.leaderboard_visible = 1 AND COALESCE(cs.total_collected, 0) > 0
         ORDER BY total_collected DESC, completed_games DESC, achieved_at ASC, stable_id ASC LIMIT 3`,
      )
      .all() as Array<{
      display_name: string;
      total_collected: number;
      completed_games: number;
    }>;
    response.setHeader("Cache-Control", "no-store");
    response.json({
      games: games.map((game) => ({
        gameId: game.id,
        gameName: game.name,
        status: game.status,
        participantCount: game.participant_count,
        validCollectionCount: game.collection_count,
        completionRate:
          game.eligible_count === 0
            ? 0
            : Math.round((game.completed_count / game.eligible_count) * 100),
      })),
      leaderboard: leaderboard.map((player, index) => ({
        rank: index + 1,
        displayName: player.display_name,
        totalCollected: player.total_collected,
        completedGames: player.completed_games,
      })),
    });
  });

  router.get("/progress-resets", (request, response) => {
    const statusFilter = request.query.status ?? "all";
    if (
      statusFilter !== "all" &&
      statusFilter !== "awaiting_confirmation" &&
      statusFilter !== "completed" &&
      statusFilter !== "restored"
    ) {
      response.status(400).json({ error: "進度重置狀態篩選條件無效。" });
      return;
    }
    const rows = options.database
      .prepare(
        "SELECT r.id, r.game_id, r.player_id, r.reason, r.requested_by, " +
          "r.confirmed_by, r.status, r.created_at, r.completed_at, " +
          "r.restored_by, r.restored_at, p.anonymous_code, g.name AS game_name, " +
          "(SELECT COUNT(*) FROM collected_treasures c " +
          "WHERE c.game_id = r.game_id AND c.player_id = r.player_id) AS current_collections " +
          "FROM progress_reset_requests r " +
          "JOIN players p ON p.id = r.player_id " +
          "JOIN games g ON g.id = r.game_id " +
          "WHERE (? = 'all' OR " +
          "(? = 'awaiting_confirmation' AND r.status = 'awaiting_confirmation') OR " +
          "(? = 'completed' AND r.status = 'completed' AND r.restored_at IS NULL) OR " +
          "(? = 'restored' AND r.restored_at IS NOT NULL)) " +
          "ORDER BY r.created_at DESC, r.id DESC",
      )
      .all(statusFilter, statusFilter, statusFilter, statusFilter) as Array<{
      id: string;
      game_id: string;
      player_id: string;
      reason: string;
      requested_by: string;
      confirmed_by: string | null;
      status: string;
      created_at: number;
      completed_at: number | null;
      restored_by: string | null;
      restored_at: number | null;
      anonymous_code: string;
      game_name: string;
      current_collections: number;
    }>;
    const actorId = options.getAdminActorId?.(request)?.trim();
    response.setHeader("Cache-Control", "no-store");
    response.json({
      requests: rows.map((row) => ({
        resetId: row.id,
        gameId: row.game_id,
        gameName: row.game_name,
        playerId: row.player_id,
        anonymousCode: row.anonymous_code,
        reason: row.reason,
        requestedBy: row.requested_by,
        confirmedBy: row.confirmed_by,
        status: row.restored_at === null ? row.status : "restored",
        createdAt: row.created_at,
        completedAt: row.completed_at,
        restoredBy: row.restored_by,
        restoredAt: row.restored_at,
        canConfirm:
          row.status === "awaiting_confirmation" &&
          Boolean(actorId) &&
          actorId !== row.requested_by,
        canRestore:
          row.status === "completed" &&
          row.restored_at === null &&
          row.current_collections === 0,
        restoreBlockedByNewCollections:
          row.status === "completed" &&
          row.restored_at === null &&
          row.current_collections > 0,
      })),
    });
  });

  router.get("/anomalies", (request, response) => {
    const status = request.query.status;
    if (
      status !== undefined &&
      status !== "pending" &&
      status !== "awaiting_second_review" &&
      status !== "reviewed"
    ) {
      response.status(400).json({ error: "異常狀態篩選條件無效。" });
      return;
    }
    const rows = options.database
      .prepare(
        `SELECT a.*, p.anonymous_code, g.name AS game_name
         FROM anomaly_events a
         JOIN players p ON p.id = a.player_id
         JOIN games g ON g.id = a.game_id
         WHERE (? IS NULL OR a.status = ?)
         ORDER BY a.detected_at DESC, a.id
         LIMIT 500`,
      )
      .all(status ?? null, status ?? null) as Array<{
      id: string;
      game_id: string;
      player_id: string;
      signal_type: string;
      details_json: string;
      detected_at: number;
      status: string;
      decision: string | null;
      anonymous_code: string;
      game_name: string;
    }>;
    response.setHeader("Cache-Control", "no-store");
    response.json({
      anomalies: rows.map((row) => {
        const details = JSON.parse(row.details_json) as Record<string, unknown>;
        const sampleIds = [details.previousSampleId, details.currentSampleId].filter(
          (id): id is string => typeof id === "string",
        );
        const locationSamples = sampleIds.flatMap((sampleId) => {
          const sample = options.database
            .prepare(
              `SELECT latitude, longitude, accuracy, measured_at, expires_at
               FROM location_samples
               WHERE id = ? AND game_id = ? AND player_id = ?`,
            )
            .get(sampleId, row.game_id, row.player_id) as
            | {
                latitude: number;
                longitude: number;
                accuracy: number;
                measured_at: number;
                expires_at: number | null;
              }
            | undefined;
          return sample ? [{ sampleId, ...sample }] : [];
        });
        const collectionEvents = options.database
          .prepare(
            `SELECT c.treasure_id, t.title AS treasure_title, c.collected_at,
                    c.distance_meters, c.accuracy
             FROM collected_treasures c
             JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
             WHERE c.game_id = ? AND c.player_id = ?
               AND (? IS NULL OR c.treasure_id = ?)
             ORDER BY c.collected_at DESC`,
          )
          .all(
            row.game_id,
            row.player_id,
            typeof details.treasureId === "string" ? details.treasureId : null,
            typeof details.treasureId === "string" ? details.treasureId : null,
          );
        return {
          id: row.id,
          gameId: row.game_id,
          gameName: row.game_name,
          playerId: row.player_id,
          anonymousCode: row.anonymous_code,
          signalType: row.signal_type,
          details,
          evidence: { locationSamples, collectionEvents },
          detectedAt: row.detected_at,
          status: row.status,
          decision: row.decision,
          reviews: options.database
            .prepare(
              `SELECT actor_id, decision, notes, created_at
               FROM anomaly_reviews WHERE anomaly_id = ?
               ORDER BY created_at, id`,
            )
            .all(row.id)
            .map((review) => {
              const item = review as {
                actor_id: string;
                decision: string;
                notes: string;
                created_at: number;
              };
              return {
                actorId: item.actor_id,
                decision: item.decision,
                notes: item.notes,
                createdAt: item.created_at,
              };
            }),
        };
      }),
    });
  });

  router.post("/anomalies/:anomalyId/reviews", (request, response) => {
    const actorId = options.getAdminActorId?.(request)?.trim();
    if (!actorId) {
      response.status(503).json({ error: "目前無法取得管理員識別資訊，不能執行雙人審查。" });
      return;
    }
    const anomalyId = request.params.anomalyId;
    if (
      typeof anomalyId !== "string" ||
      !isRecord(request.body) ||
      (request.body.decision !== "confirmed" && request.body.decision !== "dismissed") ||
      (request.body.notes !== undefined &&
        (typeof request.body.notes !== "string" || request.body.notes.length > 500))
    ) {
      response.status(400).json({ error: "異常審查資料無效。" });
      return;
    }
    const anomaly = options.database
      .prepare("SELECT status FROM anomaly_events WHERE id = ?")
      .get(anomalyId) as { status: string } | undefined;
    if (!anomaly) {
      respondNotFound(response);
      return;
    }
    if (anomaly.status === "reviewed") {
      respondConflict(response, "此異常訊號已完成雙人審查。");
      return;
    }

    beginWriteTransaction(options.database);
    try {
      const existingReview = options.database
        .prepare(
          "SELECT actor_id, decision FROM anomaly_reviews WHERE anomaly_id = ? ORDER BY created_at, id LIMIT 1",
        )
        .get(anomalyId) as { actor_id: string; decision: string } | undefined;
      if (!existingReview) {
        options.database
          .prepare(
            `INSERT INTO anomaly_reviews (
              id, anomaly_id, actor_id, decision, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createId(),
            anomalyId,
            actorId,
            request.body.decision,
            typeof request.body.notes === "string" ? request.body.notes : "",
            options.now(),
          );
        options.database
          .prepare("UPDATE anomaly_events SET status = 'awaiting_second_review' WHERE id = ?")
          .run(anomalyId);
        options.database
          .prepare(
            `INSERT INTO anomaly_audit_log (
              id, anomaly_id, actor_id, action, details_json, created_at
            ) VALUES (?, ?, ?, 'anomaly_review_started', ?, ?)`,
          )
          .run(
            createId(),
            anomalyId,
            actorId,
            JSON.stringify({ decision: request.body.decision }),
            options.now(),
          );
        options.database.exec("COMMIT");
        response.status(202).json({ anomalyId, status: "awaiting_second_review" });
        return;
      }
      if (existingReview.actor_id === actorId) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "第二位審查者必須是不同的管理員。");
        return;
      }
      if (existingReview.decision !== request.body.decision) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "第二位管理員的審查決定必須與第一位一致。");
        return;
      }

      options.database
        .prepare(
          `INSERT INTO anomaly_reviews (
            id, anomaly_id, actor_id, decision, notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createId(),
          anomalyId,
          actorId,
          request.body.decision,
          typeof request.body.notes === "string" ? request.body.notes : "",
          options.now(),
        );
      options.database
        .prepare("UPDATE anomaly_events SET status = 'reviewed', decision = ? WHERE id = ?")
        .run(request.body.decision, anomalyId);
      options.database
        .prepare(
          `INSERT INTO anomaly_audit_log (
            id, anomaly_id, actor_id, action, details_json, created_at
          ) VALUES (?, ?, ?, 'anomaly_review_completed', ?, ?)`,
        )
        .run(
          createId(),
          anomalyId,
          actorId,
          JSON.stringify({ decision: request.body.decision }),
          options.now(),
        );
      options.database.exec("COMMIT");
      response.json({ anomalyId, status: "reviewed", decision: request.body.decision });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  router.post(
    "/:gameId/players/:playerId/progress-reset",
    (request, response) => {
      const actorId = options.getAdminActorId?.(request)?.trim();
      if (!actorId) {
        response.status(503).json({
          error: "目前無法取得管理員識別資訊，不能執行雙人進度重置。",
        });
        return;
      }
      const gameId = routeGameId(request);
      const playerId = request.params.playerId;
      if (
        !gameId ||
        typeof playerId !== "string" ||
        !isRecord(request.body) ||
        typeof request.body.reason !== "string" ||
        request.body.reason.trim().length === 0 ||
        request.body.reason.length > 500
      ) {
        response.status(400).json({ error: "進度重置資料無效，必須提供原因。" });
        return;
      }
      const participant = options.database
        .prepare(
          "SELECT 1 FROM game_participants WHERE game_id = ? AND player_id = ?",
        )
        .get(gameId, playerId);
      if (!participant) {
        respondNotFound(response);
        return;
      }
      const pending = options.database
        .prepare(
          `SELECT id FROM progress_reset_requests
           WHERE game_id = ? AND player_id = ? AND status = 'awaiting_confirmation'`,
        )
        .get(gameId, playerId) as { id: string } | undefined;
      if (pending) {
        respondConflict(response, "此玩家已有待雙人確認的進度重置申請。");
        return;
      }

      const resetId = createId();
      const timestamp = options.now();
      beginWriteTransaction(options.database);
      try {
        const participantState = options.database
          .prepare(
            `SELECT progress_json FROM game_participants
             WHERE game_id = ? AND player_id = ?`,
          )
          .get(gameId, playerId) as { progress_json: string } | undefined;
        if (!participantState) {
          throw new Error("Player participation disappeared before progress reset");
        }
        const collections = options.database
          .prepare(
            `SELECT game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
             FROM collected_treasures WHERE game_id = ? AND player_id = ?`,
          )
          .all(gameId, playerId);
        const snapshot = JSON.stringify({
          progressJson: participantState.progress_json,
          collections,
        });
        options.database
          .prepare(
            `INSERT INTO progress_reset_requests (
              id, game_id, player_id, reason, requested_by, snapshot_json,
              status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?)`,
          )
          .run(
            resetId,
            gameId,
            playerId,
            request.body.reason.trim(),
            actorId,
            snapshot,
            timestamp,
          );
        options.database
          .prepare(
            `INSERT INTO anomaly_audit_log (
              id, reset_id, actor_id, action, details_json, created_at
            ) VALUES (?, ?, ?, 'progress_reset_requested', ?, ?)`,
          )
          .run(
            createId(),
            resetId,
            actorId,
            JSON.stringify({ gameId, playerId, reason: request.body.reason.trim() }),
            timestamp,
          );
        options.database.exec("COMMIT");
        response.status(202).json({ resetId, status: "awaiting_confirmation" });
      } catch (error) {
        options.database.exec("ROLLBACK");
        throw error;
      }
    },
  );

  router.post("/progress-resets/:resetId/confirm", (request, response) => {
    const actorId = options.getAdminActorId?.(request)?.trim();
    if (!actorId) {
      response.status(503).json({
        error: "目前無法取得管理員識別資訊，不能執行雙人進度重置。",
      });
      return;
    }
    const resetId = request.params.resetId;
    if (typeof resetId !== "string") {
      respondNotFound(response);
      return;
    }
    beginWriteTransaction(options.database);
    try {
      const reset = options.database
        .prepare(
          `SELECT * FROM progress_reset_requests
           WHERE id = ? AND status = 'awaiting_confirmation'`,
        )
        .get(resetId) as
        | {
            id: string;
            game_id: string;
            player_id: string;
            requested_by: string;
            reason: string;
            snapshot_json: string;
          }
        | undefined;
      if (!reset) {
        options.database.exec("ROLLBACK");
        respondNotFound(response);
        return;
      }
      if (reset.requested_by === actorId) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "確認者必須是不同於申請者的管理員。");
        return;
      }
      options.database
        .prepare(
          "DELETE FROM collected_treasures WHERE game_id = ? AND player_id = ?",
        )
        .run(reset.game_id, reset.player_id);
      const participant = options.database
        .prepare(
          "SELECT status FROM game_participants WHERE game_id = ? AND player_id = ?",
        )
        .get(reset.game_id, reset.player_id) as { status: string } | undefined;
      if (!participant) {
        throw new Error("Player participation disappeared during progress reset");
      }
      const progress = {
        collectedTreasureIds: [],
        collectedCount: 0,
        targetTreasureCount: countEnabledTreasures(options.database, reset.game_id),
        completed: false,
      };
      options.database
        .prepare(
          `UPDATE game_participants SET progress_json = ?, updated_at = ?
           WHERE game_id = ? AND player_id = ?`,
        )
        .run(JSON.stringify(progress), options.now(), reset.game_id, reset.player_id);
      options.database
        .prepare(
          `UPDATE progress_reset_requests
           SET status = 'completed', confirmed_by = ?, completed_at = ? WHERE id = ?`,
        )
        .run(actorId, options.now(), reset.id);
      options.database
        .prepare(
          `INSERT INTO anomaly_audit_log (
            id, reset_id, actor_id, action, details_json, created_at
          ) VALUES (?, ?, ?, 'progress_reset_confirmed', ?, ?)`,
        )
        .run(
          createId(),
          reset.id,
          actorId,
          JSON.stringify({
            gameId: reset.game_id,
            playerId: reset.player_id,
            requestedBy: reset.requested_by,
            reason: reset.reason,
          }),
          options.now(),
        );
      options.database.exec("COMMIT");
      response.json({ resetId: reset.id, status: "completed", progress });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  router.post("/progress-resets/:resetId/restore", (request, response) => {
    const actorId = options.getAdminActorId?.(request)?.trim();
    if (!actorId) {
      response.status(503).json({
        error: "目前無法取得管理員識別資訊，不能復原進度重置。",
      });
      return;
    }
    const resetId = request.params.resetId;
    if (typeof resetId !== "string") {
      respondNotFound(response);
      return;
    }
    beginWriteTransaction(options.database);
    try {
      const reset = options.database
        .prepare(
          `SELECT * FROM progress_reset_requests
           WHERE id = ? AND status = 'completed'`,
        )
        .get(resetId) as
        | {
            id: string;
            game_id: string;
            player_id: string;
            requested_by: string;
            snapshot_json: string;
            restored_at: number | null;
          }
        | undefined;
      if (!reset) {
        options.database.exec("ROLLBACK");
        respondNotFound(response);
        return;
      }
      if (reset.restored_at !== null) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "此進度重置已復原。");
        return;
      }
      const participant = options.database
        .prepare(
          `SELECT 1 FROM game_participants WHERE game_id = ? AND player_id = ?`,
        )
        .get(reset.game_id, reset.player_id);
      if (!participant) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "原遊戲參與資料已不存在，無法復原進度。");
        return;
      }
      const currentCollections = (
        options.database
          .prepare(
            `SELECT COUNT(*) AS count FROM collected_treasures
             WHERE game_id = ? AND player_id = ?`,
          )
          .get(reset.game_id, reset.player_id) as { count: number }
      ).count;
      if (currentCollections > 0) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "玩家重置後已有新搜集，請先處理新進度再復原。");
        return;
      }

      const snapshot: unknown = JSON.parse(reset.snapshot_json);
      if (
        !isRecord(snapshot) ||
        typeof snapshot.progressJson !== "string" ||
        !Array.isArray(snapshot.collections)
      ) {
        throw new Error("Stored progress reset snapshot is invalid");
      }
      const collections = snapshot.collections.filter(
        isCollectedTreasureSnapshot,
      );
      if (
        collections.length !== snapshot.collections.length ||
        collections.some(
          (collection) =>
            collection.game_id !== reset.game_id ||
            collection.player_id !== reset.player_id,
        )
      ) {
        throw new Error("Stored progress reset snapshot is invalid");
      }
      const insertCollection = options.database.prepare(
        `INSERT INTO collected_treasures (
          game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const collection of collections) {
        insertCollection.run(
          collection.game_id,
          collection.player_id,
          collection.treasure_id,
          collection.collected_at,
          collection.distance_meters,
          collection.accuracy,
        );
      }
      options.database
        .prepare(
          `UPDATE game_participants SET progress_json = ?
           WHERE game_id = ? AND player_id = ?`,
        )
        .run(snapshot.progressJson, reset.game_id, reset.player_id);
      const summary = refreshAuthoritativeProgress(
        options.database,
        reset.game_id,
        reset.player_id,
        options.now(),
      );
      options.database
        .prepare(
          "UPDATE progress_reset_requests SET restored_by = ?, restored_at = ? WHERE id = ?",
        )
        .run(actorId, options.now(), reset.id);
      options.database
        .prepare(
          `INSERT INTO anomaly_audit_log (
            id, reset_id, actor_id, action, details_json, created_at
          ) VALUES (?, ?, ?, 'progress_reset_restored', ?, ?)`,
        )
        .run(
          createId(),
          reset.id,
          actorId,
          JSON.stringify({
            gameId: reset.game_id,
            playerId: reset.player_id,
            requestedBy: reset.requested_by,
          }),
          options.now(),
        );
      options.database.exec("COMMIT");
      response.json({ resetId: reset.id, status: "restored", ...summary });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  router.get("/", (_request, response) => {
    const games = options.database
      .prepare("SELECT * FROM games ORDER BY created_at DESC, id")
      .all()
      .map(parseGameRecord);
    response.json({
      games: games.map((game) =>
        {
          const now = options.now();
          const serialized = serializeGame(
            game,
            now,
            countEnabledTreasures(options.database, game.id),
          );
          const archiveStartedAt = game.ended_at ?? game.ends_at;
          const hasArchive = game.status !== "draft";
          return {
            ...serialized,
            archiveStartedAt: hasArchive
              ? new Date(archiveStartedAt).toISOString()
              : null,
            archiveExpiresAt: hasArchive
              ? new Date(archiveStartedAt + ARCHIVE_PERIOD_MS).toISOString()
              : null,
            archiveRestoredAt:
              game.archive_restored_at === null
                ? null
                : new Date(game.archive_restored_at).toISOString(),
            canRestore: serialized.status === "archived",
            canPermanentlyDelete:
              game.status === "draft" ||
              ((game.status === "ended" || now >= game.ends_at) &&
                now >= archiveStartedAt + ARCHIVE_PERIOD_MS),
          };
        },
      ),
    });
  });

  router.get("/:gameId/treasures", (request, response) => {
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    const treasures = listTreasures(options.database, game.id);
    response.json({
      treasures: treasures.map(serializeTreasure),
      totalTreasuresCount: countEnabledTreasures(options.database, game.id),
    });
  });

  router.post("/:gameId/treasures/import/preview", (request, response) => {
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "只有未發布草稿可以預覽寶藏匯入。");
      return;
    }

    const result = parseTreasureImport(request.body, listTreasures(options.database, game.id));
    response.status(
      result.errors.some((error) => error.row === 0) ? 400 : 200,
    ).json({
      validCount: result.validRows.length,
      errorCount: result.errors.length,
      errors: result.errors,
      preview: result.validRows.map(({ row, treasure }) => ({
        row,
        ...treasure,
      })),
    });
  });

  router.post("/:gameId/treasures/import/commit", (request, response) => {
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "只有未發布草稿可以匯入寶藏。");
      return;
    }
    if (
      !isRecord(request.body) ||
      (request.body.mode !== "all_or_nothing" && request.body.mode !== "skip_invalid")
    ) {
      response.status(400).json({
        importedCount: 0,
        errors: [
          {
            row: 0,
            field: "mode",
            code: "INVALID_MODE",
            reason: "mode 必須是 all_or_nothing 或 skip_invalid。",
          },
        ],
      });
      return;
    }

    const mode = request.body.mode as TreasureImportMode;
    beginWriteTransaction(options.database);
    try {
      const currentGame = findGame(options.database, game.id);
      if (!currentGame || currentGame.status !== "draft") {
        options.database.exec("ROLLBACK");
        respondConflict(response, "只有未發布草稿可以匯入寶藏。");
        return;
      }
      const result = parseTreasureImport(
        request.body,
        listTreasures(options.database, currentGame.id),
      );
      const hasGlobalError = result.errors.some((error) => error.row === 0);
      const shouldAbort =
        hasGlobalError ||
        (mode === "all_or_nothing" && result.errors.length > 0) ||
        result.validRows.length === 0;
      if (shouldAbort) {
        options.database.exec("ROLLBACK");
        response.status(400).json({
          importedCount: 0,
          totalTreasuresCount: countEnabledTreasures(options.database, game.id),
          errors:
            result.errors.length > 0
              ? result.errors
              : [
                  {
                    row: 0,
                    field: "treasures",
                    code: "NO_VALID_ROWS",
                    reason: "沒有可匯入的有效寶藏資料。",
                  },
                ],
        });
        return;
      }

      const timestamp = options.now();
      const insertTreasure = options.database.prepare(
        `INSERT INTO treasures (
          id, game_id, title, description, latitude, longitude,
          fuzzy_latitude, fuzzy_longitude, fuzzy_radius_meters,
          enabled, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const imported: Array<Record<string, unknown>> = [];
      for (const { row, treasure } of result.validRows) {
        const id = createId();
        insertTreasure.run(
          id,
          game.id,
          treasure.title,
          treasure.description,
          treasure.latitude,
          treasure.longitude,
          treasure.fuzzyLatitude,
          treasure.fuzzyLongitude,
          treasure.fuzzyRadiusMeters,
          treasure.enabled ? 1 : 0,
          treasure.sortOrder,
          timestamp,
          timestamp,
        );
        imported.push({ row, id, ...treasure });
      }
      options.database
        .prepare("UPDATE games SET updated_at = ? WHERE id = ? AND status = 'draft'")
        .run(timestamp, game.id);
      const totalTreasuresCount = countEnabledTreasures(options.database, game.id);
      options.database.exec("COMMIT");
      response.status(200).json({
        importedCount: imported.length,
        totalTreasuresCount,
        imported,
        errors: result.errors,
      });
    } catch (error) {
      options.database.exec("ROLLBACK");
      console.error("寶藏 JSON 匯入交易失敗：", error);
      response.status(500).json({
        importedCount: 0,
        error: "匯入失敗，資料未變更。",
      });
    }
  });

  router.post("/:gameId/treasures", (request, response) => {
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "遊戲發布後不可新增寶藏。");
      return;
    }
    const body = request.body;
    const treasureInput = parseTreasureInput(body);
    if (!treasureInput) {
      response.status(400).json({ error: "寶藏資料無效，請檢查標題、座標、熱區半徑與排序。" });
      return;
    }

    const timestamp = options.now();
    const id = createId();
    beginWriteTransaction(options.database);
    try {
      const capacityUsed = countAllTreasures(options.database, game.id);
      if (capacityUsed >= 500) {
        options.database.exec("ROLLBACK");
        response.status(409).json({
          error: "單場遊戲最多只能有 500 個寶藏。",
          totalTreasuresCount: capacityUsed,
        });
        return;
      }
      const duplicate = options.database
        .prepare(
          `SELECT 1 FROM treasures
           WHERE game_id = ? AND ROUND(latitude, 6) = ROUND(?, 6)
             AND ROUND(longitude, 6) = ROUND(?, 6)`,
        )
        .get(game.id, treasureInput.latitude, treasureInput.longitude);
      if (duplicate) {
        options.database.exec("ROLLBACK");
        response.status(409).json({ error: "此遊戲已有寶藏使用相同的精確座標。" });
        return;
      }
      options.database
        .prepare(
          `INSERT INTO treasures (
            id, game_id, title, description, latitude, longitude,
            fuzzy_latitude, fuzzy_longitude, fuzzy_radius_meters,
            enabled, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          game.id,
          treasureInput.title,
          treasureInput.description,
          treasureInput.latitude,
          treasureInput.longitude,
          treasureInput.fuzzyLatitude,
          treasureInput.fuzzyLongitude,
          treasureInput.fuzzyRadiusMeters,
          treasureInput.enabled ? 1 : 0,
          treasureInput.sortOrder,
          timestamp,
          timestamp,
        );
      const treasure = findTreasure(options.database, game.id, id);
      if (!treasure) {
        throw new Error("Created treasure could not be loaded");
      }
      options.database.exec("COMMIT");
      response.status(201).json({
        treasure: serializeTreasure(treasure),
        totalTreasuresCount: countEnabledTreasures(options.database, game.id),
      });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  router.patch("/:gameId/treasures/:treasureId", (request, response) => {
    const gameId = routeGameId(request);
    const treasureId = request.params.treasureId;
    if (!gameId || typeof treasureId !== "string") {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    const treasure = findTreasure(options.database, gameId, treasureId);
    if (!game || !treasure) {
      respondNotFound(response);
      return;
    }
    const body = request.body;
    if (!isRecord(body) || Object.keys(body).length === 0) {
      response.status(400).json({ error: "請提供要更新的寶藏欄位。" });
      return;
    }
    if (game.status !== "draft") {
      if (body.enabled === false && Object.keys(body).length === 1) {
        const timestamp = options.now();
        beginWriteTransaction(options.database);
        try {
          options.database
            .prepare(
              "UPDATE treasures SET enabled = 0, updated_at = ? WHERE id = ? AND game_id = ?",
            )
            .run(timestamp, treasure.id, game.id);
          const participants = options.database
            .prepare("SELECT player_id FROM game_participants WHERE game_id = ?")
            .all(game.id) as Array<{ player_id: string }>;
          for (const participant of participants) {
            refreshAuthoritativeProgress(
              options.database,
              game.id,
              participant.player_id,
              timestamp,
            );
          }
          options.database.exec("COMMIT");
        } catch (error) {
          options.database.exec("ROLLBACK");
          throw error;
        }
        response.json({
          treasure: serializeTreasure(requireTreasure(options.database, game.id, treasure.id)),
          totalTreasuresCount: countEnabledTreasures(options.database, game.id),
        });
        return;
      }
      respondConflict(response, "遊戲發布後只能停用寶藏，不可修改或刪除內容。");
      return;
    }

    const treasureInput = parseTreasureInput(body, treasure);
    if (!treasureInput) {
      response.status(400).json({ error: "寶藏更新資料無效。" });
      return;
    }

    const duplicate = options.database
      .prepare(
        `SELECT 1 FROM treasures
         WHERE game_id = ? AND id != ? AND ROUND(latitude, 6) = ROUND(?, 6)
           AND ROUND(longitude, 6) = ROUND(?, 6)`,
      )
      .get(game.id, treasure.id, treasureInput.latitude, treasureInput.longitude);
    if (duplicate) {
      respondConflict(response, "此遊戲已有寶藏使用相同的精確座標。");
      return;
    }
    options.database
      .prepare(
        `UPDATE treasures SET title = ?, description = ?, latitude = ?, longitude = ?,
          fuzzy_latitude = ?, fuzzy_longitude = ?, fuzzy_radius_meters = ?,
          enabled = ?, sort_order = ?, updated_at = ? WHERE id = ? AND game_id = ?`,
      )
      .run(
        treasureInput.title,
        treasureInput.description,
        treasureInput.latitude,
        treasureInput.longitude,
        treasureInput.fuzzyLatitude,
        treasureInput.fuzzyLongitude,
        treasureInput.fuzzyRadiusMeters,
        treasureInput.enabled ? 1 : 0,
        treasureInput.sortOrder,
        options.now(),
        treasure.id,
        game.id,
      );
    const updatedTreasure = requireTreasure(options.database, game.id, treasure.id);
    response.json({
      treasure: serializeTreasure(updatedTreasure),
      totalTreasuresCount: countEnabledTreasures(options.database, game.id),
    });
  });

  router.delete("/:gameId/treasures/:treasureId", (request, response) => {
    const gameId = routeGameId(request);
    const treasureId = request.params.treasureId;
    if (!gameId || typeof treasureId !== "string") {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    const treasure = findTreasure(options.database, gameId, treasureId);
    if (!game || !treasure) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "遊戲發布後不可刪除寶藏。");
      return;
    }
    if (
      !isRecord(request.body) ||
      request.body.confirmPermanentDeletion !== true
    ) {
      response.status(400).json({
        error: "永久刪除寶藏前，請明確確認 confirmPermanentDeletion。",
      });
      return;
    }
    options.database
      .prepare("DELETE FROM treasures WHERE id = ? AND game_id = ?")
      .run(treasure.id, game.id);
    response.status(204).end();
  });

  router.post("/", (request, response) => {
    const body = request.body;
    const startsAt = isRecord(body) ? parseTimestamp(body.startsAt) : undefined;
    const endsAt = isRecord(body) ? parseTimestamp(body.endsAt) : undefined;
    if (
      !isRecord(body) ||
      typeof body.name !== "string" ||
      body.name.trim().length === 0 ||
      body.name.trim().length > 120 ||
      (body.description !== undefined &&
        (typeof body.description !== "string" || body.description.length > 2000)) ||
      startsAt === undefined ||
      endsAt === undefined ||
      startsAt >= endsAt ||
      !isTimezone(body.timezone) ||
      !validMapCenter(body.mapCenter)
    ) {
      response.status(400).json({ error: "遊戲草稿資料無效，請檢查名稱、時間、時區與地圖中心。" });
      return;
    }

    const timestamp = options.now();
    const id = createId();
    options.database
      .prepare(
        `INSERT INTO games (
          id, name, description, starts_at, ends_at, timezone,
          map_center_latitude, map_center_longitude, status,
          ended_at, archive_restored_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        body.name.trim(),
        typeof body.description === "string" ? body.description.trim() : "",
        startsAt,
        endsAt,
        body.timezone,
        body.mapCenter.latitude,
        body.mapCenter.longitude,
        timestamp,
        timestamp,
      );
    const game = findGame(options.database, id);
    if (!game) {
      throw new Error("Created game could not be loaded");
    }
    response.status(201).json({ game: serializeGame(game, timestamp, 0) });
  });

  router.patch("/:gameId", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft") {
      respondConflict(response, "遊戲發布後不可修改內容。");
      return;
    }

    const body = request.body;
    if (!isRecord(body) || Object.keys(body).length === 0) {
      response.status(400).json({ error: "請提供要更新的草稿欄位。" });
      return;
    }
    const name = body.name === undefined ? game.name : body.name;
    const description = body.description === undefined ? game.description : body.description;
    const startsAt =
      body.startsAt === undefined ? game.starts_at : parseTimestamp(body.startsAt);
    const endsAt = body.endsAt === undefined ? game.ends_at : parseTimestamp(body.endsAt);
    const timezone = body.timezone === undefined ? game.timezone : body.timezone;
    const mapCenter =
      body.mapCenter === undefined
        ? { latitude: game.map_center_latitude, longitude: game.map_center_longitude }
        : body.mapCenter;
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.trim().length > 120 ||
      typeof description !== "string" ||
      description.length > 2000 ||
      startsAt === undefined ||
      endsAt === undefined ||
      startsAt >= endsAt ||
      !isTimezone(timezone) ||
      !validMapCenter(mapCenter)
    ) {
      response.status(400).json({ error: "草稿更新資料無效。" });
      return;
    }

    const updatedAt = options.now();
    options.database
      .prepare(
        `UPDATE games SET name = ?, description = ?, starts_at = ?, ends_at = ?,
          timezone = ?, map_center_latitude = ?, map_center_longitude = ?, updated_at = ?
         WHERE id = ? AND status = 'draft'`,
      )
      .run(
        name.trim(),
        description.trim(),
        startsAt,
        endsAt,
        timezone,
        mapCenter.latitude,
        mapCenter.longitude,
        updatedAt,
        game.id,
      );
    const updatedGame = findGame(options.database, game.id);
    if (!updatedGame) {
      throw new Error("Updated game could not be loaded");
    }
    response.json({
      game: serializeGame(
        updatedGame,
        updatedAt,
        countEnabledTreasures(options.database, updatedGame.id),
      ),
    });
  });

  router.post("/:gameId/publish", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "draft" || game.ends_at <= options.now()) {
      respondConflict(response, "只有尚未結束的草稿可以發布。");
      return;
    }
    options.database
      .prepare(
        "UPDATE games SET status = 'published', updated_at = ? WHERE id = ? AND status = 'draft'",
      )
      .run(options.now(), game.id);
    const published = findGame(options.database, game.id);
    if (!published) {
      throw new Error("Published game could not be loaded");
    }
    response.json({
      game: serializeGame(
        published,
        options.now(),
        countEnabledTreasures(options.database, published.id),
      ),
    });
  });

  router.post("/:gameId/pause", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "published" || game.ends_at <= options.now()) {
      respondConflict(response, "只有尚未結束的已發布遊戲可以暫停。");
      return;
    }
    options.database
      .prepare(
        "UPDATE games SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'published'",
      )
      .run(options.now(), game.id);
    response.json({
      game: serializeGame(
        requireGame(options.database, game.id),
        options.now(),
        countEnabledTreasures(options.database, game.id),
      ),
    });
  });

  router.post("/:gameId/resume", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (game.status !== "paused" || game.ends_at <= options.now()) {
      respondConflict(response, "遊戲已結束，或目前不在可恢復狀態。");
      return;
    }
    options.database
      .prepare(
        "UPDATE games SET status = 'published', updated_at = ? WHERE id = ? AND status = 'paused'",
      )
      .run(options.now(), game.id);
    response.json({
      game: serializeGame(
        requireGame(options.database, game.id),
        options.now(),
        countEnabledTreasures(options.database, game.id),
      ),
    });
  });

  router.post("/:gameId/end", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    if (!["published", "paused"].includes(game.status) || game.ends_at <= options.now()) {
      respondConflict(response, "只有尚未結束的已發布遊戲可以提前結束。");
      return;
    }
    const endedAt = options.now();
    options.database
      .prepare(
        `UPDATE games SET status = 'ended', ended_at = ?, archive_restored_at = NULL,
          updated_at = ? WHERE id = ? AND status IN ('published', 'paused')`,
      )
      .run(endedAt, endedAt, game.id);
    response.json({
      game: serializeGame(
        requireGame(options.database, game.id),
        endedAt,
        countEnabledTreasures(options.database, game.id),
      ),
    });
  });

  router.post("/:gameId/restore", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    const archiveStartedAt = game.ended_at ?? game.ends_at;
    if (
      game.archive_restored_at !== null ||
      options.now() >= archiveStartedAt + ARCHIVE_PERIOD_MS ||
      (game.status !== "ended" && options.now() < game.ends_at)
    ) {
      respondConflict(response, "遊戲不在可還原的 7 天封存期間。");
      return;
    }
    const restoredAt = options.now();
    options.database
      .prepare("UPDATE games SET archive_restored_at = ?, updated_at = ? WHERE id = ?")
      .run(restoredAt, restoredAt, game.id);
    response.json({
      game: serializeGame(
        requireGame(options.database, game.id),
        restoredAt,
        countEnabledTreasures(options.database, game.id),
      ),
    });
  });

  router.delete("/:gameId", (request, response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game) {
      respondNotFound(response);
      return;
    }
    const ended = game.status === "ended" || options.now() >= game.ends_at;
    if (game.status !== "draft" && !ended) {
      respondConflict(response, "只有草稿或已結束的遊戲可以刪除。");
      return;
    }
    if (
      game.status !== "draft" &&
      options.now() < (game.ended_at ?? game.ends_at) + ARCHIVE_PERIOD_MS
    ) {
      respondConflict(response, "遊戲結束後須保留 7 天，期滿後才能永久刪除。");
      return;
    }
    if (
      !isRecord(request.body) ||
      request.body.confirmPermanentDeletion !== true
    ) {
      response.status(400).json({
        error: "永久刪除遊戲前，請明確確認 confirmPermanentDeletion。",
      });
      return;
    }
    const timestamp = options.now();
    beginWriteTransaction(options.database);
    try {
      if (ended) {
        archiveGameEvents(
          options.database,
          game.id,
          game.ended_at ?? game.ends_at,
          timestamp,
        );
      }
      const deletion = options.database
        .prepare("DELETE FROM games WHERE id = ?")
        .run(game.id);
      if (Number(deletion.changes) !== 1) {
        throw new Error("Game disappeared during permanent deletion");
      }
      recordDataRetentionAudit(
        options.database,
        "game_permanently_deleted",
        game.id,
        timestamp,
      );
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
    response.status(204).end();
  });

  return router;
}

export function createPlayerGameRouter(options: GameRouterOptions): Router {
  const router = Router();
  const createId = options.createId ?? randomUUID;
  const collectionRepository: CollectionRepository = {
    findGame: (gameId) => {
      const game = findGame(options.database, gameId);
      return game
        ? { status: game.status, startsAt: game.starts_at, endsAt: game.ends_at }
        : undefined;
    },
    findParticipant: (gameId, playerId) => {
      const participant = options.database
        .prepare(
          `SELECT status FROM game_participants
           WHERE game_id = ? AND player_id = ?`,
        )
        .get(gameId, playerId) as { status: string } | undefined;
      return participant ? { status: participant.status } : undefined;
    },
    findTreasure: (gameId, treasureId) => {
      const treasure = findTreasure(options.database, gameId, treasureId);
      return treasure
        ? {
            enabled: treasure.enabled === 1,
            latitude: treasure.latitude,
            longitude: treasure.longitude,
          }
        : undefined;
    },
    findCollection: (gameId, playerId, treasureId) => {
      const collection = options.database
        .prepare(
          `SELECT distance_meters FROM collected_treasures
           WHERE game_id = ? AND player_id = ? AND treasure_id = ?`,
        )
        .get(gameId, playerId, treasureId) as
        | { distance_meters: number }
        | undefined;
      return collection ? { distanceMeters: collection.distance_meters } : undefined;
    },
    beginWriteTransaction: () => beginWriteTransaction(options.database),
    commit: () => options.database.exec("COMMIT"),
    rollback: () => options.database.exec("ROLLBACK"),
    recordAttempt: (gameId, playerId, treasureId, timestamp) =>
      recordCollectionAttempt(
        options.database,
        createId,
        gameId,
        playerId,
        treasureId,
        timestamp,
      ),
    insertCollection: (collection) => {
      options.database
        .prepare(
          `INSERT INTO collected_treasures (
            game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          collection.gameId,
          collection.playerId,
          collection.treasureId,
          collection.timestamp,
          collection.distanceMeters,
          collection.accuracy,
        );
    },
    refreshProgress: (gameId, playerId, timestamp) =>
      refreshAuthoritativeProgress(options.database, gameId, playerId, timestamp),
  };

  router.get("/", (_request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    const games = options.database
      .prepare("SELECT * FROM games WHERE status != 'draft' ORDER BY starts_at, id")
      .all()
      .map(parseGameRecord);
    const completedGameIds = new Set(
      playerId
        ? games
            .filter((game) =>
              hasPlayerCompletedGame(options.database, game.id, playerId),
            )
            .map((game) => game.id)
        : [],
    );
    response.json({
      completedGames: completedGameIds.size,
      totalGames: games.length,
      games: games.map((game) => ({
        ...serializeGame(
          game,
          options.now(),
          countEnabledTreasures(options.database, game.id),
        ),
        completed: completedGameIds.has(game.id),
      })),
    });
  });

  router.get("/:gameId", (request: Request, response: Response) => {
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    if (!game || game.status === "draft") {
      respondNotFound(response);
      return;
    }
    response.json({
      game: serializeGame(
        game,
        options.now(),
        countEnabledTreasures(options.database, game.id),
      ),
    });
  });

  router.get("/:gameId/progress", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const playerId = findPlayerId(response);
    if (!playerId) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    const gameId = routeGameId(request);
    const game = gameId ? findGame(options.database, gameId) : undefined;
    if (!game || game.status === "draft") {
      respondNotFound(response);
      return;
    }
    const participant = options.database
      .prepare(
        "SELECT 1 FROM game_participants WHERE game_id = ? AND player_id = ?",
      )
      .get(game.id, playerId);
    if (!participant) {
      respondConflict(response, "請先加入這場遊戲。");
      return;
    }

    const summary = refreshAuthoritativeProgress(
      options.database,
      game.id,
      playerId,
      options.now(),
    );
    const collectedCount = summary.progress.collectedCount as number;
    const targetTreasureCount = summary.progress.targetTreasureCount as number;
    response.json({
      gameId: game.id,
      gameName: game.name,
      status: serializeGame(
        game,
        options.now(),
        countEnabledTreasures(options.database, game.id),
      ).status,
      ...summary.progress,
      collectedCount,
      remainingCount: Math.max(0, targetTreasureCount - collectedCount),
      completionRate:
        targetTreasureCount === 0
          ? 0
          : Math.round((collectedCount / targetTreasureCount) * 100),
      totalCollected: summary.totalCollected,
      totalCollectedSoFar: summary.totalCollectedSoFar,
    });
  });

  router.post("/:gameId/location", (request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    const gameId = routeGameId(request);
    if (!playerId) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    const timestamp = options.now();
    if (!game || game.status === "draft") {
      respondNotFound(response);
      return;
    }
    const participant = options.database
      .prepare(
        `SELECT status FROM game_participants
         WHERE game_id = ? AND player_id = ?`,
      )
      .get(game.id, playerId) as { status: string } | undefined;
    if (!participant) {
      respondConflict(response, "請先加入這場遊戲。");
      return;
    }
    if (
      participant.status !== "playing" ||
      !isGameCurrentlyPlayable(game, timestamp)
    ) {
      respondConflict(response, "遊戲目前未進行，無法回報位置。");
      return;
    }
    const position = parsePlayerPosition(request.body, timestamp);
    if (!position) {
      response.status(400).json({ error: "定位資料無效，玩家只能使用 Real GPS。" });
      return;
    }
    recordLocationAnomalies(
      options.database,
      createId,
      game.id,
      playerId,
      position,
    );
    const treasures = listTreasures(options.database, game.id)
      .filter((treasure) => treasure.enabled === 1)
      .map((treasure) => {
        const inFuzzyZone =
          distanceMeters(position, {
            latitude: treasure.fuzzy_latitude,
            longitude: treasure.fuzzy_longitude,
          }) <= treasure.fuzzy_radius_meters;
        return {
          id: treasure.id,
          title: treasure.title,
          description: treasure.description,
          fuzzyCenter: {
            latitude: treasure.fuzzy_latitude,
            longitude: treasure.fuzzy_longitude,
          },
          fuzzyRadiusMeters: treasure.fuzzy_radius_meters,
          inFuzzyZone,
          ...(inFuzzyZone && position.accuracy <= MAXIMUM_GPS_ACCURACY_METERS
            ? {
                preciseLocation: {
                  latitude: treasure.latitude,
                  longitude: treasure.longitude,
                },
              }
            : {}),
        };
      });
    response.setHeader("Cache-Control", "no-store");
    response.json({ treasures });
  });

  router.post("/:gameId/join", (request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    const deviceTokenHash = findPlayerDeviceTokenHash(response);
    if (!playerId) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    if (!deviceTokenHash) {
      response.status(401).json({ error: "此裝置尚未完成信任，請重新登入。" });
      return;
    }
    const gameId = routeGameId(request);
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const game = findGame(options.database, gameId);
    const timestamp = options.now();
    if (!game || game.status === "draft") {
      respondNotFound(response);
      return;
    }
    if (
      game.status !== "published" ||
      timestamp < game.starts_at ||
      timestamp >= game.ends_at
    ) {
      respondConflict(response, "此遊戲目前不接受遊玩。");
      return;
    }
    if (hasPlayerCompletedGame(options.database, game.id, playerId)) {
      respondConflict(response, "你已完成此遊戲，無法再次加入。");
      return;
    }

    pauseStalePlayerGameSessions(options.database, timestamp);
    beginWriteTransaction(options.database);
    try {
      const activeGame = options.database
        .prepare(
          `SELECT game_id FROM game_participants
           WHERE player_id = ? AND status = 'playing'`,
        )
        .get(playerId) as { game_id: string } | undefined;
      if (activeGame && activeGame.game_id !== game.id) {
        options.database.exec("ROLLBACK");
        respondConflict(response, "請先暫停目前遊戲，再開始另一場。");
        return;
      }

      const participant = options.database
        .prepare("SELECT * FROM game_participants WHERE game_id = ? AND player_id = ?")
        .get(game.id, playerId) as ParticipantRecord | undefined;
      if (participant?.status === "playing") {
        if (participant.device_token_hash && participant.device_token_hash !== deviceTokenHash) {
          options.database.exec("ROLLBACK");
          respondConflict(response, "此遊戲回合已綁定另一裝置，請先暫停或等待心跳逾時。");
          return;
        }
        options.database
          .prepare(
            `UPDATE game_participants SET device_token_hash = ?, last_heartbeat_at = ?
             WHERE game_id = ? AND player_id = ? AND status = 'playing'`,
          )
          .run(deviceTokenHash, timestamp, game.id, playerId);
        options.database.exec("COMMIT");
        response.json({
          gameId: game.id,
          status: participant.status,
          progress: JSON.parse(participant.progress_json) as unknown,
        });
        return;
      }
      if (participant) {
        options.database
          .prepare(
            `UPDATE game_participants SET status = 'playing', updated_at = ?,
               device_token_hash = ?, last_heartbeat_at = ?
               WHERE game_id = ? AND player_id = ? AND status IN ('paused', 'exited')`,
          )
          .run(timestamp, deviceTokenHash, timestamp, game.id, playerId);
      } else {
        options.database
          .prepare(
            `INSERT INTO game_participants (
              game_id, player_id, status, progress_json, device_token_hash,
              last_heartbeat_at, created_at, updated_at
            ) VALUES (?, ?, 'playing', '{}', ?, ?, ?, ?)`,
          )
          .run(game.id, playerId, deviceTokenHash, timestamp, timestamp, timestamp);
      }
      const resumed = options.database
        .prepare("SELECT * FROM game_participants WHERE game_id = ? AND player_id = ?")
        .get(game.id, playerId) as ParticipantRecord | undefined;
      options.database.exec("COMMIT");
      if (!resumed) {
        throw new Error("Player participation could not be loaded after joining");
      }
      response.json({
        gameId: game.id,
        status: resumed.status,
        progress: JSON.parse(resumed.progress_json) as unknown,
      });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  router.post("/:gameId/heartbeat", (request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    const deviceTokenHash = findPlayerDeviceTokenHash(response);
    const gameId = routeGameId(request);
    if (!playerId || !deviceTokenHash) {
      response.status(401).json({ error: "請先以信任裝置登入。" });
      return;
    }
    if (!gameId) {
      respondNotFound(response);
      return;
    }
    const timestamp = options.now();
    pauseStalePlayerGameSessions(options.database, timestamp);
    const updated = options.database
      .prepare(
        `UPDATE game_participants SET last_heartbeat_at = ?,
           device_token_hash = COALESCE(device_token_hash, ?)
         WHERE game_id = ? AND player_id = ? AND status = 'playing'
           AND (device_token_hash IS NULL OR device_token_hash = ?)`,
      )
      .run(timestamp, deviceTokenHash, gameId, playerId, deviceTokenHash);
    if (Number(updated.changes) !== 1) {
      response.status(409).json({
        code: "PLAYER_GAME_SESSION_PAUSED",
        error: "此遊戲回合已暫停或由其他裝置接手，請重新選擇遊戲。",
      });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ gameId, status: "playing", heartbeatAt: new Date(timestamp).toISOString() });
  });

  router.post("/:gameId/pause", (request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    const deviceTokenHash = findPlayerDeviceTokenHash(response);
    if (!playerId) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    const gameId = routeGameId(request);
    if (!gameId) {
      respondConflict(response, "目前沒有正在進行的這場遊戲。");
      return;
    }
    const result = options.database
      .prepare(
        `UPDATE game_participants SET status = 'paused', device_token_hash = NULL,
           last_heartbeat_at = NULL, updated_at = ?
         WHERE game_id = ? AND player_id = ? AND status = 'playing'
           AND (device_token_hash IS NULL OR device_token_hash = ?)`,
      )
      .run(options.now(), gameId, playerId, deviceTokenHash ?? "");
    if (Number(result.changes) !== 1) {
      respondConflict(response, "目前沒有正在進行的這場遊戲。");
      return;
    }
    options.database
      .prepare(
        `UPDATE location_samples SET expires_at = ?
         WHERE game_id = ? AND player_id = ? AND expires_at IS NULL`,
      )
      .run(options.now() + 24 * 60 * 60 * 1000, gameId, playerId);
    response.json({ gameId, status: "paused" });
  });

  router.post(
    "/:gameId/treasures/:treasureId/collect",
    (request: Request, response: Response) => {
      const playerId = findPlayerId(response);
      const gameId = routeGameId(request);
      const treasureId = request.params.treasureId;
      if (!playerId) {
        response.status(401).json({ error: "請先登入。" });
        return;
      }
      if (!gameId || typeof treasureId !== "string") {
        respondNotFound(response);
        return;
      }
      const game = findGame(options.database, gameId);
      const treasure = findTreasure(options.database, gameId, treasureId);
      if (!game || game.status === "draft" || !treasure) {
        respondNotFound(response);
        return;
      }
      const timestamp = options.now();
      const position = parsePlayerPosition(request.body, timestamp);
      if (!position) {
        response.status(400).json({ error: "定位資料無效，玩家只能使用 Real GPS。" });
        return;
      }
      const result = collectTreasure(collectionRepository, {
        gameId: game.id,
        playerId,
        treasureId: treasure.id,
        timestamp,
        position,
        initialGame: {
          status: game.status,
          startsAt: game.starts_at,
          endsAt: game.ends_at,
        },
      });
      switch (result.kind) {
        case "participant_missing":
          respondConflict(response, "請先加入這場遊戲。");
          return;
        case "state_changed":
          respondConflict(response, "遊戲參與或寶藏資料已變更，請重新整理後再試。");
          return;
        case "game_not_playing":
          respondConflict(response, "遊戲目前未進行，不能搜集寶藏。");
          return;
        case "treasure_disabled":
          respondConflict(response, "此寶藏已停用，不能搜集。");
          return;
        case "accuracy_too_low":
          response.status(422).json({
            error: "GPS_ACCURACY_TOO_LOW",
            message: "定位精度不足，請移至空曠處或稍後再試",
            maximumAccuracyMeters: result.maximumAccuracyMeters,
          });
          return;
        case "distance_too_far":
          response.status(422).json({
            error: "DISTANCE_TOO_FAR",
            message: "距離寶藏太遠，請再靠近一些。",
            distanceMeters: result.distanceMeters,
            thresholdMeters: COLLECTION_THRESHOLD_METERS,
          });
          return;
        case "collected":
          response.json({
            collected: true,
            alreadyCollected: result.alreadyCollected,
            treasureId: result.treasureId,
            distanceMeters: result.distanceMeters,
            progress: result.progress,
            totalCollected: result.totalCollected,
            totalCollectedSoFar: result.totalCollectedSoFar,
          });
          return;
      }
    },
  );

  router.post("/:gameId/exit", (request: Request, response: Response) => {
    const playerId = findPlayerId(response);
    if (!playerId) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    const gameId = routeGameId(request);
    if (!gameId) {
      respondConflict(response, "目前沒有正在進行的這場遊戲。");
      return;
    }
    const result = options.database
      .prepare(
        `UPDATE game_participants SET status = 'exited', device_token_hash = NULL,
           last_heartbeat_at = NULL, updated_at = ?
         WHERE game_id = ? AND player_id = ? AND status IN ('playing', 'paused')
           AND (status != 'playing' OR device_token_hash IS NULL OR device_token_hash = ?)`,
      )
      .run(options.now(), gameId, playerId, findPlayerDeviceTokenHash(response) ?? "");
    if (Number(result.changes) !== 1) {
      respondConflict(response, "目前沒有可退出的這場遊戲。");
      return;
    }
    options.database
      .prepare(
        `UPDATE location_samples SET expires_at = ?
         WHERE game_id = ? AND player_id = ? AND expires_at IS NULL`,
      )
      .run(options.now() + 24 * 60 * 60 * 1000, gameId, playerId);
    response.json({ gameId, status: "exited" });
  });

  return router;
}

export type AdminAuthorizer = (request: Request) => boolean | Promise<boolean>;

export function createAdminAuthorizationMiddleware(
  authorizeAdmin: AdminAuthorizer | undefined,
): RequestHandler {
  return async (request, response, next) => {
    if (!authorizeAdmin || !(await authorizeAdmin(request))) {
      response.status(403).json({ error: "需要管理員權限。" });
      return;
    }
    next();
  };
}

export function createPlayerSessionMiddleware(database: DatabaseSync): RequestHandler {
  return (request, response, next) => {
    const cookieHeader = request.header("cookie");
    const sessionCookie = cookieHeader
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("player_session="));
    const token = sessionCookie?.slice("player_session=".length);
    if (!token) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = database
      .prepare(
        `SELECT player_id, device_token_hash FROM player_sessions
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(tokenHash) as { player_id: string; device_token_hash: string | null } | undefined;
    if (!session) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    let deviceTokenHash = session.device_token_hash ?? undefined;
    if (!deviceTokenHash) {
      const trustedCookie = cookieHeader
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("player_trusted_device="));
      const trustedToken = trustedCookie?.slice("player_trusted_device=".length);
      if (trustedToken) {
        const candidateHash = createHash("sha256").update(trustedToken).digest("hex");
        const trusted = database
          .prepare(
            `SELECT 1 FROM player_trusted_devices
             WHERE token_hash = ? AND player_id = ? AND revoked_at IS NULL`,
          )
          .get(candidateHash, session.player_id);
        if (trusted) {
          database
            .prepare(
              `UPDATE player_sessions SET device_token_hash = ?
               WHERE token_hash = ? AND revoked_at IS NULL AND device_token_hash IS NULL`,
            )
            .run(candidateHash, tokenHash);
          deviceTokenHash = candidateHash;
        }
      }
    }
    response.locals.playerId = session.player_id;
    if (deviceTokenHash) response.locals.playerDeviceTokenHash = deviceTokenHash;
    next();
  };
}
