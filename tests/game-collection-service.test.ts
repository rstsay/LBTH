import { describe, expect, it, vi } from "vitest";
import {
  collectTreasure,
  type CollectionRepository,
  type CollectionRequest,
} from "../src/game-collection-service.ts";

function createRepository(): CollectionRepository {
  return {
    findParticipant: vi.fn(() => ({ status: "playing" })),
    findGame: vi.fn(() => ({ status: "published", startsAt: 0, endsAt: 20_000 })),
    findTreasure: vi.fn(() => ({ enabled: true, latitude: 25, longitude: 121 })),
    findCollection: vi.fn(() => undefined),
    beginWriteTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    recordAttempt: vi.fn(),
    insertCollection: vi.fn(),
    refreshProgress: vi.fn(() => ({
      progress: { collectedTreasureIds: ["treasure-1"], collectedCount: 1 },
      totalCollected: 1,
      totalCollectedSoFar: 1,
    })),
  };
}

const request: CollectionRequest = {
  gameId: "game-1",
  playerId: "player-1",
  treasureId: "treasure-1",
  timestamp: 10_000,
  position: { latitude: 25, longitude: 121, accuracy: 5 },
  initialGame: { status: "published", startsAt: 0, endsAt: 20_000 },
};

describe("玩家搜集服務", () => {
  it("records a valid collection and returns the authoritative progress in one transaction", () => {
    const repository = createRepository();

    const result = collectTreasure(repository, request);

    expect(result).toMatchObject({
      kind: "collected",
      alreadyCollected: false,
      distanceMeters: 0,
      progress: { collectedCount: 1 },
      totalCollectedSoFar: 1,
    });
    expect(repository.recordAttempt).toHaveBeenCalledOnce();
    expect(repository.beginWriteTransaction).toHaveBeenCalledTimes(2);
    expect(repository.insertCollection).toHaveBeenCalledWith({
      gameId: "game-1",
      playerId: "player-1",
      treasureId: "treasure-1",
      timestamp: 10_000,
      distanceMeters: 0,
      accuracy: 5,
    });
    expect(repository.commit).toHaveBeenCalledTimes(2);
    expect(repository.rollback).not.toHaveBeenCalled();
  });

  it("rolls back the collection transaction when the progress update fails", () => {
    const repository = createRepository();
    vi.mocked(repository.refreshProgress).mockImplementation(() => {
      throw new Error("progress write failed");
    });

    expect(() => collectTreasure(repository, request)).toThrow("progress write failed");
    expect(repository.insertCollection).toHaveBeenCalledOnce();
    expect(repository.commit).toHaveBeenCalledOnce();
    expect(repository.rollback).toHaveBeenCalledOnce();
  });

  it("returns the persisted distance and current progress for an idempotent retry", () => {
    const repository = createRepository();
    vi.mocked(repository.findCollection).mockReturnValue({ distanceMeters: 4.25 });

    const result = collectTreasure(repository, request);

    expect(result).toMatchObject({
      kind: "collected",
      alreadyCollected: true,
      distanceMeters: 4.25,
      totalCollectedSoFar: 1,
    });
    expect(repository.insertCollection).not.toHaveBeenCalled();
    expect(repository.refreshProgress).toHaveBeenCalledOnce();
    expect(repository.commit).toHaveBeenCalledTimes(2);
    expect(repository.rollback).not.toHaveBeenCalled();
  });
});
