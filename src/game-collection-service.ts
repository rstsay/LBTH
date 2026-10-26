import { COLLECTION_THRESHOLD_METERS, distanceMeters } from "../web/geo.js";
import type { Coordinates } from "../web/geo.js";

export const MAXIMUM_GPS_ACCURACY_METERS = 50;

export interface CollectionGame {
  status: string;
  startsAt: number;
  endsAt: number;
}

export interface CollectionParticipant {
  status: string;
}

export interface CollectionTreasure extends Coordinates {
  enabled: boolean;
}

export interface CollectionPosition extends Coordinates {
  accuracy: number;
}

export interface CollectionRequest {
  gameId: string;
  playerId: string;
  treasureId: string;
  timestamp: number;
  position: CollectionPosition;
  initialGame: CollectionGame;
}

export interface CollectionProgressSummary {
  progress: Record<string, unknown>;
  totalCollected: number;
  totalCollectedSoFar: number;
}

export interface CollectionRepository {
  findGame(gameId: string): CollectionGame | undefined;
  findParticipant(gameId: string, playerId: string): CollectionParticipant | undefined;
  findTreasure(gameId: string, treasureId: string): CollectionTreasure | undefined;
  findCollection(
    gameId: string,
    playerId: string,
    treasureId: string,
  ): { distanceMeters: number } | undefined;
  beginWriteTransaction(): void;
  commit(): void;
  rollback(): void;
  recordAttempt(gameId: string, playerId: string, treasureId: string, timestamp: number): void;
  insertCollection(collection: {
    gameId: string;
    playerId: string;
    treasureId: string;
    timestamp: number;
    distanceMeters: number;
    accuracy: number;
  }): void;
  refreshProgress(
    gameId: string,
    playerId: string,
    timestamp: number,
  ): CollectionProgressSummary;
}

export type CollectionResult =
  | { kind: "participant_missing" }
  | { kind: "state_changed" }
  | { kind: "game_not_playing" }
  | { kind: "treasure_disabled" }
  | { kind: "accuracy_too_low"; maximumAccuracyMeters: number }
  | { kind: "distance_too_far"; distanceMeters: number }
  | ({
      kind: "collected";
      alreadyCollected: boolean;
      treasureId: string;
      distanceMeters: number;
    } & CollectionProgressSummary);

function isGamePlayable(game: CollectionGame, timestamp: number): boolean {
  return game.status === "published" && timestamp >= game.startsAt && timestamp < game.endsAt;
}

export function collectTreasure(
  repository: CollectionRepository,
  request: CollectionRequest,
): CollectionResult {
  const { gameId, playerId, treasureId, timestamp, position, initialGame } = request;
  const initialParticipant = repository.findParticipant(gameId, playerId);
  if (!initialParticipant) {
    return { kind: "participant_missing" };
  }

  if (
    initialParticipant.status === "playing" &&
    isGamePlayable(initialGame, timestamp)
  ) {
    repository.beginWriteTransaction();
    try {
      repository.recordAttempt(gameId, playerId, treasureId, timestamp);
      repository.commit();
    } catch (error) {
      repository.rollback();
      throw error;
    }
  }

  repository.beginWriteTransaction();
  try {
    const currentGame = repository.findGame(gameId);
    const currentParticipant = repository.findParticipant(gameId, playerId);
    const currentTreasure = repository.findTreasure(gameId, treasureId);
    if (!currentGame || !currentParticipant || !currentTreasure) {
      repository.rollback();
      return { kind: "state_changed" };
    }

    const existingCollection = repository.findCollection(gameId, playerId, treasureId);
    if (existingCollection) {
      const summary = repository.refreshProgress(gameId, playerId, timestamp);
      repository.commit();
      return {
        kind: "collected",
        alreadyCollected: true,
        treasureId,
        distanceMeters: existingCollection.distanceMeters,
        ...summary,
      };
    }

    if (
      currentParticipant.status !== "playing" ||
      !isGamePlayable(currentGame, timestamp)
    ) {
      repository.rollback();
      return { kind: "game_not_playing" };
    }
    if (!currentTreasure.enabled) {
      repository.rollback();
      return { kind: "treasure_disabled" };
    }
    if (position.accuracy > MAXIMUM_GPS_ACCURACY_METERS) {
      repository.rollback();
      return {
        kind: "accuracy_too_low",
        maximumAccuracyMeters: MAXIMUM_GPS_ACCURACY_METERS,
      };
    }

    const distance = distanceMeters(position, currentTreasure);
    if (distance > COLLECTION_THRESHOLD_METERS) {
      repository.rollback();
      return { kind: "distance_too_far", distanceMeters: distance };
    }

    repository.insertCollection({
      gameId,
      playerId,
      treasureId,
      timestamp,
      distanceMeters: distance,
      accuracy: position.accuracy,
    });
    const summary = repository.refreshProgress(gameId, playerId, timestamp);
    repository.commit();
    return {
      kind: "collected",
      alreadyCollected: false,
      treasureId,
      distanceMeters: distance,
      ...summary,
    };
  } catch (error) {
    repository.rollback();
    throw error;
  }
}
