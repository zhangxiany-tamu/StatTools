import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

export type SafetyOverrideCheckResult = {
  csvRows: number;
  uniqueIds: number;
  duplicateIds: string[];
  missingIds: string[];
};

export function checkSafetyOverrides(
  dbPath: string,
  csvPath: string,
): SafetyOverrideCheckResult {
  const lines = readFileSync(csvPath, "utf-8")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const ids = lines.map((line) => line.split(",", 1)[0].trim()).filter(Boolean);
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) duplicateIds.add(id);
    seen.add(id);
  }

  const db = new Database(dbPath, { readonly: true });
  const stmt = db.prepare("SELECT 1 FROM functions WHERE id = ?");
  const missingIds = [...seen].filter((id) => !stmt.get(id));
  db.close();

  return {
    csvRows: ids.length,
    uniqueIds: seen.size,
    duplicateIds: [...duplicateIds].sort(),
    missingIds: missingIds.sort(),
  };
}
