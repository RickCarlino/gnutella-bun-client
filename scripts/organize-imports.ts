import fs from "node:fs/promises";
import path from "node:path";
import * as prettier from "prettier";
import ts from "typescript";

const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");

function readSource(file: string): string {
  const source = ts.sys.readFile(file);
  if (source === undefined) throw new Error(`Cannot read ${file}`);
  return source;
}

function projectConfig(): ts.ParsedCommandLine {
  const file = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(file, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
  );
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  return parsed;
}

function statementEnd(source: string, statement: ts.Statement): number {
  const comments = ts.getTrailingCommentRanges(source, statement.end);
  return comments?.at(-1)?.end ?? statement.end;
}

function importsFirst(file: string, source: string): string {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = [...parsed.statements];
  while (
    statements[0] &&
    ts.isExpressionStatement(statements[0]) &&
    ts.isStringLiteral(statements[0].expression)
  )
    statements.shift();
  if (!statements.some(ts.isImportDeclaration)) return source;
  const imports: string[] = [];
  const declarations: string[] = [];
  let offset = statements[0]!.getStart(parsed);
  const prefix = source.slice(0, offset);
  for (const statement of statements) {
    const end = statementEnd(source, statement);
    const text = source.slice(offset, end);
    if (ts.isImportDeclaration(statement)) imports.push(text.trim());
    else declarations.push(text);
    offset = end;
  }
  return (
    prefix +
    imports.join("\n") +
    "\n\n" +
    (declarations.join("") + source.slice(offset)).trimStart()
  );
}

function languageService(
  config: ts.ParsedCommandLine,
  sources: Map<string, string>,
): ts.LanguageService {
  return ts.createLanguageService({
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (file) => {
      const source = sources.get(file) ?? ts.sys.readFile(file);
      return source === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(source);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  });
}

function organizeFile(
  service: ts.LanguageService,
  file: string,
  source: string,
): string {
  const edits = service.organizeImports(
    { type: "file", fileName: file, mode: ts.OrganizeImportsMode.All },
    { newLineCharacter: "\n", indentSize: 2, convertTabsToSpaces: true },
    {
      quotePreference: "double",
      organizeImportsIgnoreCase: true,
      organizeImportsTypeOrder: "last",
    },
  );
  for (const edit of edits) {
    if (edit.fileName !== file)
      throw new Error(`Unexpected edit to ${edit.fileName}`);
    for (const change of [...edit.textChanges].sort(
      (a, b) => b.span.start - a.span.start,
    )) {
      const { start, length } = change.span;
      source =
        source.slice(0, start) +
        change.newText +
        source.slice(start + length);
    }
  }
  return source;
}

async function main(): Promise<void> {
  const config = projectConfig();
  const originals = new Map(
    config.fileNames.map((file) => [file, readSource(file)]),
  );
  const sources = new Map(
    [...originals].map(([file, source]) => [
      file,
      importsFirst(file, source),
    ]),
  );
  const service = languageService(config, sources);
  const changes = new Map<string, string>();
  try {
    for (const [file, source] of sources) {
      const organized = organizeFile(service, file, source);
      const formatted = await prettier.format(organized, {
        ...(await prettier.resolveConfig(file)),
        filepath: file,
      });
      if (formatted !== originals.get(file)) changes.set(file, formatted);
    }
  } finally {
    service.dispose();
  }
  for (const [file, source] of changes) {
    if (check)
      console.error(
        `Imports need organizing: ${path.relative(root, file)}`,
      );
    else await fs.writeFile(file, source);
  }
  if (check && changes.size) process.exitCode = 1;
  console.log(
    `${check ? "Checked" : "Organized"} ${sources.size} TypeScript files; ${changes.size} ${check ? "need changes" : "updated"}.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
