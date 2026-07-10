import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDecision, getDecisionById, listDecisions, saveDecision, setDecisionsForTesting } from "./decisions.js";

describe("decision persistence", () => {
  beforeEach(() => {
    setDecisionsForTesting(null);
  });
  afterEach(() => {
    setDecisionsForTesting(null);
  });

  it("creates a decision with generated id and timestamps", () => {
    const decision = createDecision({
      title: "Homepage direction",
      targetUser: "First-time visitors",
      businessGoal: "Clarity in 10s",
      primaryKpi: "Trial starts",
      scope: "screen" as const,
    });
    expect(decision.id).toMatch(/^[a-z0-9]+-[a-z0-9]+/);
    expect(decision.directions).toEqual([]);
    expect(decision.analysis).toBeUndefined();
  });

  it("saves and retrieves a decision by id (in-memory fixture)", () => {
    const decision = createDecision({
      title: "Test", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen",
    });
    saveDecision(decision);
    const found = getDecisionById(decision.id);
    expect(found?.title).toBe("Test");
  });

  it("lists decisions newest-first by updatedAt", () => {
    const old = createDecision({ title: "Old", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    old.updatedAt = "2026-01-01";
    const newer = createDecision({ title: "New", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    newer.updatedAt = "2026-07-10";
    saveDecision(old);
    saveDecision(newer);
    const all = listDecisions();
    expect(all[0].title).toBe("New");
  });

  it("overwrites a decision on re-save (upsert by id)", () => {
    const decision = createDecision({ title: "V1", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    saveDecision(decision);
    decision.title = "V2";
    saveDecision(decision);
    expect(listDecisions()).toHaveLength(1);
    expect(getDecisionById(decision.id)?.title).toBe("V2");
  });
});
