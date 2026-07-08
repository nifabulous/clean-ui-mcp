import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { isDeepSeekPeakHour, isDeepSeekCritique } from "./tagger.js";

describe("peak-hour DeepSeek detection", () => {
  it("flags UTC 1-3 as peak (first window: 1:00-4:00 AM)", () => {
    expect(isDeepSeekPeakHour(new Date("2026-07-08T01:30:00Z"))).toBe(true);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T03:59:00Z"))).toBe(true);
  });

  it("flags UTC 6-9 as peak (second window: 6:00-10:00 AM)", () => {
    expect(isDeepSeekPeakHour(new Date("2026-07-08T06:00:00Z"))).toBe(true);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T09:59:00Z"))).toBe(true);
  });

  it("does NOT flag UTC 0, 4, 5, 10, 23 as peak", () => {
    expect(isDeepSeekPeakHour(new Date("2026-07-08T00:30:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T04:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T05:59:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T10:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHour(new Date("2026-07-08T23:30:00Z"))).toBe(false);
  });
});

describe("DeepSeek critique model detection", () => {
  const savedCritModel = process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
  const savedBaseModel = process.env.OPENAI_AUTO_TAG_MODEL;

  afterEach(() => {
    // Restore env
    if (savedCritModel !== undefined) process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE = savedCritModel;
    else delete process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
    if (savedBaseModel !== undefined) process.env.OPENAI_AUTO_TAG_MODEL = savedBaseModel;
    else delete process.env.OPENAI_AUTO_TAG_MODEL;
  });

  it("detects DeepSeek from OPENAI_AUTO_TAG_MODEL_CRITIQUE", () => {
    process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE = "deepseek-chat";
    process.env.OPENAI_AUTO_TAG_MODEL = "gpt-4o";
    expect(isDeepSeekCritique()).toBe(true);
  });

  it("detects DeepSeek case-insensitively", () => {
    process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE = "DeepSeek-V4-Pro";
    expect(isDeepSeekCritique()).toBe(true);
  });

  it("returns false for a non-DeepSeek critique model", () => {
    process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE = "gpt-4o-mini";
    expect(isDeepSeekCritique()).toBe(false);
  });

  it("returns false when no model is configured", () => {
    delete process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
    delete process.env.OPENAI_AUTO_TAG_MODEL;
    // The default in openaiConfigForPass is gpt-5.4-nano, which is not DeepSeek
    expect(isDeepSeekCritique()).toBe(false);
  });
});
