import { describe, it, expect } from "vitest";
import { murmurhash3 } from "../hash";

describe("murmurhash3", () => {
  it("returns a positive 32-bit integer", () => {
    const result = murmurhash3("test");
    expect(result).toBeTypeOf("number");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffffffff);
  });

  it("returns consistent results for the same input", () => {
    expect(murmurhash3("hello")).toBe(murmurhash3("hello"));
  });

  it("returns different results for different inputs", () => {
    expect(murmurhash3("hello")).not.toBe(murmurhash3("world"));
  });

  it("truncates input to 120 chars before hashing", () => {
    const long = "a".repeat(200);
    const truncated = "a".repeat(120);
    expect(murmurhash3(long)).toBe(murmurhash3(truncated));
  });

  it("handles empty string", () => {
    const result = murmurhash3("");
    expect(result).toBeTypeOf("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("respects seed parameter", () => {
    expect(murmurhash3("test", 0)).not.toBe(murmurhash3("test", 42));
  });
});
