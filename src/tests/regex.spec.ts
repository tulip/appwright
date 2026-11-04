import { test, expect } from "vitest";
import { longestDeterministicGroup } from "../utils";

test("longest deterministic group with one group", () => {
  const pattern = /.*(Copy to clipboard)$/;
  const substring = longestDeterministicGroup(pattern);
  expect(substring).toBe("Copy to clipboard");
});

test("longest deterministic group with no groups", () => {
  const pattern = /.*Copy to clipboard$/;
  const substring = longestDeterministicGroup(pattern);
  expect(substring).toBe(undefined);
});

test("longest deterministic group with group that has special chars", () => {
  const pattern = /.*(Copy .* to clipboard)$/;
  const substring = longestDeterministicGroup(pattern);
  expect(substring).toBe(undefined);
});

test("a group a match can skip is never picked", () => {
  // Either side of an alternation can be missing from a match.
  expect(longestDeterministicGroup(/(Save)|(Discard)/)).toBe(undefined);
  expect(longestDeterministicGroup(/(Save) changes|Discard/)).toBe(undefined);
  // So can a group a quantifier allows zero of.
  expect(longestDeterministicGroup(/(Draft )?Saved/)).toBe(undefined);
  expect(longestDeterministicGroup(/(Draft )*Saved/)).toBe(undefined);
  expect(longestDeterministicGroup(/(Draft ){0,1}Saved/)).toBe(undefined);
  // One that must appear still narrows, beside a skippable one.
  expect(longestDeterministicGroup(/(Draft )?(Saved)/)).toBe("Saved");
  expect(longestDeterministicGroup(/(Saved)+ at/)).toBe("Saved");
});
