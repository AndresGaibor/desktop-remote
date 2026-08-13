import { expect, test } from "bun:test";
import { extractPathFromEnoentError, getFuzzySuggestions, formatErrorHintAndSuggestions } from "../src/suggestion-engine";
import { cleanToolResultText } from "../src/result-cleaner";

test("extracts file path from ENOENT error string", () => {
  const errorText = "Error: ENOENT: no such file or directory, stat '/Users/andresgaibor/code/javascript/bq_reportes_creator/apps/api/src/plataforma/bootstrap.test.ts'";
  const extracted = extractPathFromEnoentError(errorText);
  expect(extracted).toBe("/Users/andresgaibor/code/javascript/bq_reportes_creator/apps/api/src/plataforma/bootstrap.test.ts");
});

test("gets fuzzy suggestions for an existing directory", () => {
  // Test with current directory package.json
  const targetPath = "/Users/andresgaibor/code/javascript/desktop-remote/package.test.json";
  const result = getFuzzySuggestions(targetPath);

  expect(result).not.toBeNull();
  expect(result?.dirExists).toBe(true);
  expect(result?.suggestions.some((s) => s.name === "package.json")).toBe(true);
});

test("formats error hints and suggestions in cleanToolResultText", () => {
  const errorText = "Error: ENOENT: no such file or directory, stat '/Users/andresgaibor/code/javascript/desktop-remote/nonexistent_file.ts'";
  const cleaned = cleanToolResultText(errorText);

  expect(cleaned.formattedText).toContain("SYSTEM HINT FOR AGENT");
  expect(cleaned.formattedText).toContain("AUTO-SUGGESTIONS");
});
