import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

export interface PathSuggestionItem {
  name: string;
  fullPath: string;
  isDir: boolean;
}

export interface PathSuggestionResult {
  filePath: string;
  dirPath: string;
  dirExists: boolean;
  suggestions: PathSuggestionItem[];
}

/**
 * Extract target file path from ENOENT error message string
 */
export function extractPathFromEnoentError(errorText: string): string | null {
  if (!errorText) return null;
  // Matches: stat '/path/to/file' or open '/path/to/file' or lstat '/path/to/file' or no such file or directory: '/path/to/file'
  const match =
    errorText.match(/(?:stat|open|lstat|access|readdir)\s+['"]([^'"]+)['"]/i) ||
    errorText.match(/(?:no such file or directory|ENOENT)[^'\n]*['"]([^'"]+)['"]/i) ||
    errorText.match(/['"](\/[^'"]+\.[a-zA-Z0-9]+)['"]/);

  if (match && match[1]) {
    return match[1];
  }
  return null;
}

/**
 * Perform fuzzy search in filesystem for missing file path
 */
export function getFuzzySuggestions(targetPath: string): PathSuggestionResult | null {
  if (!targetPath || !targetPath.startsWith("/")) return null;

  const normalized = path.normalize(targetPath);
  const targetDir = path.dirname(normalized);
  const targetBase = path.basename(normalized);

  // Case 1: The parent directory exists
  if (fs.existsSync(targetDir)) {
    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const baseStem = (targetBase.split(".")[0] ?? targetBase).toLowerCase();
      const ext = path.extname(targetBase).toLowerCase();

      const sorted = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => {
          const eName = e.name;
          const eStem = (eName.split(".")[0] ?? eName).toLowerCase();
          const eExt = path.extname(eName).toLowerCase();
          const fullPath = path.join(targetDir, eName);

          let score = 0;
          if (eStem === baseStem) score += 100;
          else if (eStem.includes(baseStem) || baseStem.includes(eStem)) score += 50;

          // Match test patterns (e.g. bootstrap.ts vs bootstrap.test.ts)
          if (eName.includes("test") || eName.includes("spec") || targetBase.includes("test")) {
            const cleanBase = baseStem.replace(/[-_.]?(test|spec)/g, "");
            const cleanE = eStem.replace(/[-_.]?(test|spec)/g, "");
            if (cleanBase === cleanE && cleanBase.length > 0) score += 80;
          }

          if (eExt === ext && ext !== "") score += 10;
          if (e.isDirectory()) score += 5;

          return { name: eName, fullPath, isDir: e.isDirectory(), score };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, 8);

      return {
        filePath: targetPath,
        dirPath: targetDir,
        dirExists: true,
        suggestions: sorted.map((s) => ({ name: s.name, fullPath: s.fullPath, isDir: s.isDir })),
      };
    } catch {
      return null;
    }
  }

  // Case 2: Parent directory does not exist -> find nearest parent directory
  let currentDir = targetDir;
  while (currentDir && currentDir !== "/" && currentDir !== path.parse(currentDir).root) {
    currentDir = path.dirname(currentDir);
    if (fs.existsSync(currentDir)) {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        const suggestions = entries
          .filter((e) => !e.name.startsWith("."))
          .slice(0, 8)
          .map((e) => ({
            name: e.name,
            fullPath: path.join(currentDir, e.name),
            isDir: e.isDirectory(),
          }));

        return {
          filePath: targetPath,
          dirPath: currentDir,
          dirExists: false,
          suggestions,
        };
      } catch {
        break;
      }
    }
  }

  return null;
}

/**
 * Format the Agent System Hint and Fuzzy Suggestions box
 */
export function formatErrorHintAndSuggestions(errorText: string): string {
  const extractedPath = extractPathFromEnoentError(errorText);
  const suggestionsResult = extractedPath ? getFuzzySuggestions(extractedPath) : null;

  const lines: string[] = [];

  lines.push(chalk.bold.yellow("💡 [SYSTEM HINT FOR AGENT]:"));
  lines.push(chalk.yellow("  • El archivo especificado NO existe. Detén los reintentos con la misma ruta exacta."));
  lines.push(chalk.yellow("  • Usa `list_directory` o `find` para ubicar la ruta correcta en el proyecto."));
  lines.push(chalk.yellow("  • Si estás intentando crear un archivo nuevo, usa `write_file` en lugar de `read_file`."));

  if (suggestionsResult && suggestionsResult.suggestions.length > 0) {
    lines.push("");
    if (suggestionsResult.dirExists) {
      lines.push(chalk.bold.cyan(`🔍 AUTO-SUGGESTIONS (Archivos en '${suggestionsResult.dirPath}'):`));
    } else {
      lines.push(chalk.bold.cyan(`🔍 AUTO-SUGGESTIONS (Directorio existente cercano '${suggestionsResult.dirPath}'):`));
    }

    for (const item of suggestionsResult.suggestions) {
      const icon = item.isDir ? "📁" : "📄";
      const pathLink = `\u001b]8;;file://${item.fullPath}\u001b\\${chalk.green(item.name)}\u001b]8;;\u001b\\`;
      lines.push(`  ${icon} ${pathLink}${item.isDir ? "/" : ""}`);
    }
  }

  return lines.join("\n");
}
