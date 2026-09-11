import { Effect, Stream } from "effect";
import path from "path";
import fs from "fs/promises";
import semver from "semver";
import { JJCli, getPollIgnoreWorkingCopyArgs } from "./JJCli";
import { ExtensionResources } from "./ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./JjWatchmanSnapshotTriggerRef";
import { getConfigurationValue, type Vscode } from "./Vscode";
import {
  parseStatus,
  parseShowResult,
  parseRenamePaths,
  parseOperationLog,
  parseWorkspaceList,
  operationRecordTemplate,
  workspaceRecordTemplate,
  SHOW_FILE_FIELD_SEPARATOR,
  SHOW_FILE_SEPARATOR,
  showPaginatedRecordTemplate,
  showRecordTemplate,
} from "../parsers";
import { pathEquals } from "../utils";
import { buildBaseRevset } from "../baseRevset";
import { logger } from "../logger";
import {
  RepositoryConfig,
  RepositoryStatus,
  Show,
  Operation,
  WorkspaceInfo,
  JJCliError,
  JJImmutableError,
  RepositoryDataError,
} from "../types";
import type { FileStatus, FileStatusType } from "../types";

type RepositoryEnv =
  | JJCli
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef;

// --- Query operations ---

export const getLatestOperationId = (
  config: RepositoryConfig,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const ignoreWCArgs = yield* getPollIgnoreWorkingCopyArgs(
      config.repositoryRoot,
    );
    const output = yield* cli.run(
      [
        ...ignoreWCArgs,
        "operation",
        "log",
        "--limit",
        "1",
        "-T",
        "self.id()",
        "--no-graph",
      ],
      { ignoreWorkingCopy: false }, // ignoreWorkingCopy is handled via ignoreWCArgs above
    );
    return output.trim();
  });

export const getStatus = (
  config: RepositoryConfig,
  opts?: { cwd?: string; ignoreWorkingCopy?: boolean },
): Effect.Effect<
  RepositoryStatus,
  JJCliError | JJImmutableError,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const output = yield* cli.run(["status", "--color=always"], {
      timeout: 5000,
      ignoreWorkingCopy: opts?.ignoreWorkingCopy ?? true,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    return yield* Effect.sync(() => parseStatus(config.repositoryRoot, output));
  });

export const getWorkspaceList = (
  _config: RepositoryConfig,
): Effect.Effect<WorkspaceInfo[], JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const rt = workspaceRecordTemplate;
    const output = yield* cli.run(["workspace", "list", "-T", rt.template], {
      timeout: 5000,
      ignoreWorkingCopy: true,
    });
    return parseWorkspaceList(output, rt);
  });

export const getBaseRevset = (): Effect.Effect<string, never, Vscode> =>
  Effect.map(getConfigurationValue<string[]>("jjk", "baseBookmarks"), (configured) =>
    buildBaseRevset(configured),
  );

const quoteDescriptionGlob = (value: string): string => {
  const globEscaped = value.replace(/[\\*?[\]]/g, (ch) => "\\" + ch);
  const stringEscaped = globEscaped
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return '"' + stringEscaped + '*"';
};

export const getWorkspaceStack = (
  _config: RepositoryConfig,
  workspaceName: string,
): Effect.Effect<
  { changeId: string; commitId: string }[],
  JJCliError | JJImmutableError,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const wsRef = `${workspaceName}@`;
    const baseline = yield* getBaseRevset();
    const candidatesOutput = yield* cli.run(
      [
        "log",
        "--no-graph",
        "-r",
        `::(${wsRef}) ~ ::(${baseline})`,
        "-T",
        'commit_id ++ " " ++ change_id ++ " " ++ if(empty, "1", "") ++ "\\x1f" ++ description.first_line() ++ "\\n"',
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
    const othersOutput = yield* cli.run(
      [
        "log",
        "--no-graph",
        "-r",
        `::(working_copies() ~ (${wsRef}))`,
        "-T",
        'change_id ++ "\\n"',
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
    const otherChangeIds = new Set(
      othersOutput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    let candidates: {
      commitId: string;
      changeId: string;
      isEmpty: boolean;
      description: string;
    }[] = [];
    for (const line of candidatesOutput.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      const [idPart, description = ""] = trimmed.split("\x1f");
      const [commitId, changeId, emptyFlag] = idPart.split(" ");
      if (!candidates.some((candidate) => candidate.changeId === changeId)) {
        candidates.push({
          commitId,
          changeId,
          isEmpty: emptyFlag === "1",
          description,
        });
      }
    }
    const emptyWithDescription = candidates.filter(
      (candidate) => candidate.isEmpty && candidate.description !== "",
    );
    if (emptyWithDescription.length > 0) {
      const descriptionFilter = emptyWithDescription
        .map(
          (candidate) =>
            `description(glob:${quoteDescriptionGlob(candidate.description)})`,
        )
        .join(" | ");
      const mergedOutput = yield* cli.run(
        [
          "log",
          "--no-graph",
          "-r",
          `::(${baseline}) & ~empty() & (${descriptionFilter})`,
          "-T",
          'description.first_line() ++ "\\n"',
        ],
        { timeout: 5000, ignoreWorkingCopy: true },
      );
      const mergedDescriptions = new Set(
        mergedOutput
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      );
      candidates = candidates.filter(
        (candidate) =>
          !(
            candidate.isEmpty &&
            candidate.description !== "" &&
            mergedDescriptions.has(candidate.description)
          ),
      );
    }
    const shared = candidates.filter((candidate) =>
      otherChangeIds.has(candidate.changeId),
    );
    if (shared.length === 0) {
      return candidates.map(({ commitId, changeId }) => ({
        commitId,
        changeId,
      }));
    }
    const workspaces = yield* getWorkspaceList(_config);
    const otherOutputs = yield* Effect.all(
      workspaces
        .filter((workspace) => workspace.name !== workspaceName)
        .map((workspace) =>
          cli.run(
            [
              "log",
              "--no-graph",
              "-r",
              `::(${workspace.name}@) ~ ::(${baseline})`,
              "-T",
              'change_id ++ "\\n"',
            ],
            { timeout: 5000, ignoreWorkingCopy: true },
          ),
        ),
      { concurrency: "unbounded" },
    );
    const otherMinIndexById = new Map<string, number>();
    for (const output of otherOutputs) {
      const indexById = new Map<string, number>();
      for (const line of output.split("\n")) {
        const changeId = line.trim();
        if (changeId === "" || indexById.has(changeId)) {
          continue;
        }
        indexById.set(changeId, indexById.size);
      }
      for (const [changeId, index] of indexById) {
        const current = otherMinIndexById.get(changeId);
        if (current === undefined || index < current) {
          otherMinIndexById.set(changeId, index);
        }
      }
    }
    return candidates.filter((candidate) => {
      const otherMinIndex = otherMinIndexById.get(candidate.changeId);
      if (otherMinIndex === undefined) {
        return true;
      }
      const ownIndex = candidates.findIndex(
        (entry) => entry.changeId === candidate.changeId,
      );
      return ownIndex <= otherMinIndex;
    });
  });

export const getFileList = (
  _config: RepositoryConfig,
  opts?: { cwd?: string },
): Effect.Effect<string[], JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const output = yield* cli.run(["file", "list"], {
      timeout: 5000,
      ignoreWorkingCopy: true,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    return output.trim().split("\n");
  });

export const getShow = (
  config: RepositoryConfig,
  rev: string,
): Effect.Effect<
  Show,
  JJCliError | JJImmutableError | RepositoryDataError,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const results = yield* getShowAll(config, [rev]);
    if (results.length > 1) {
      return yield* Effect.fail(
        new RepositoryDataError({
          message: "Multiple results found for the given revision.",
        }),
      );
    }
    if (results.length === 0) {
      return yield* Effect.fail(
        new RepositoryDataError({
          message: "No results found for the given revision.",
        }),
      );
    }
    return results[0];
  });

export const getShowAll = (
  config: RepositoryConfig,
  revsets: string[],
): Effect.Effect<
  Show[],
  JJCliError | JJImmutableError | RepositoryDataError,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const rt = showRecordTemplate;

    const output = yield* cli.run(
      [
        "log",
        "-T",
        rt.template,
        "--no-graph",
        ...revsets.flatMap((revset) => ["-r", toLogRevset(revset)]),
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );

    if (!output) {
      return yield* Effect.fail(
        new RepositoryDataError({
          message:
            "No output from jj log. Maybe the revision couldn't be found?",
        }),
      );
    }

    const revResults = output.split(rt.recordSeparator).slice(0, -1);
    const shows: Show[] = [];
    for (const revResult of revResults) {
      try {
        shows.push(
          parseShowResult(
            config.repositoryRoot,
            revResult,
            rt,
            SHOW_FILE_SEPARATOR,
            SHOW_FILE_FIELD_SEPARATOR,
          ),
        );
      } catch (e) {
        logger.error(`Skipping unparseable show record: ${String(e)}`);
      }
    }
    return shows;
  });

function parseDiffSummary(
  repositoryRoot: string,
  output: string,
): FileStatus[] {
  const fileStatuses: FileStatus[] = [];
  for (const line of output.split("\n")) {
    const match = /^([AMDRC]) (.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const type = match[1] as FileStatusType;
    const file = match[2];
    if (type === "R" || type === "C") {
      const parsedPaths = parseRenamePaths(file);
      if (parsedPaths) {
        fileStatuses.push({
          type,
          file: parsedPaths.toPath,
          path: path.join(repositoryRoot, parsedPaths.toPath),
          renamedFrom: parsedPaths.fromPath,
        });
      } else {
        logger.warn(`Skipping unexpected rename/copy line: ${line}`);
      }
    } else {
      const normalizedFile = path.normalize(file).replace(/\\/g, "/");
      fileStatuses.push({
        type,
        file: normalizedFile,
        path: path.join(repositoryRoot, normalizedFile),
      });
    }
  }
  return fileStatuses;
}

export const getDiffSummary = (
  config: RepositoryConfig,
  fromRev: string,
  toRev: string,
): Effect.Effect<FileStatus[], JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const output = yield* cli.run(
      ["diff", "--summary", "--from", fromRev, "--to", toRev],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
    return parseDiffSummary(config.repositoryRoot, output);
  });

// --- Mutation operations ---

export const jjNew = (
  _config: RepositoryConfig,
  message?: string,
  revs?: string[],
  opts?: { cwd?: string },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const output = yield* cli.run(
      [
        "new",
        ...(message ? ["-m", message] : []),
        ...(revs ? ["-r", ...revs] : []),
      ],
      { timeout: 5000, ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
    );
    return output;
  });

export const jjNewInsertBefore = (
  _config: RepositoryConfig,
  rev: string,
  opts?: { cwd?: string },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(["new", "--insert-before", rev], {
      timeout: 5000,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
  });

export const jjDescribe = (
  _config: RepositoryConfig,
  rev: string,
  message: string,
  ignoreImmutable = false,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      [
        "describe",
        "-m",
        message,
        rev,
        ...(ignoreImmutable ? ["--ignore-immutable"] : []),
      ],
      { timeout: 5000 },
    );
  });

export const jjSquash = (
  _config: RepositoryConfig,
  opts: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
    ignoreImmutable?: boolean;
    cwd?: string;
  },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      [
        "squash",
        "--from",
        opts.fromRev,
        "--into",
        opts.toRev,
        ...(opts.message ? ["-m", opts.message] : []),
        ...(opts.filepaths
          ? opts.filepaths.map((filepath) => filepathToFileset(filepath))
          : []),
        ...(opts.ignoreImmutable ? ["--ignore-immutable"] : []),
      ],
      { timeout: 5000, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
    );
  });

export const jjEdit = (
  _config: RepositoryConfig,
  rev: string,
  ignoreImmutable = false,
  opts?: { cwd?: string },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const buffer = yield* cli.runBuffer(
      ["edit", "-r", rev, ...(ignoreImmutable ? ["--ignore-immutable"] : [])],
      { timeout: 5000, ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
    );
    return buffer.toString();
  });

export const jjAbandon = (
  _config: RepositoryConfig,
  rev: string,
  ignoreImmutable = false,
  opts?: { cwd?: string },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      ["abandon", "-r", rev, ...(ignoreImmutable ? ["--ignore-immutable"] : [])],
      { timeout: 5000, ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
    );
  });

export const jjCommit = (
  _config: RepositoryConfig,
  rev: string,
  message?: string,
  ignoreImmutable = false,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      [
        "commit",
        "-r",
        rev,
        ...(message ? ["-m", message] : []),
        ...(ignoreImmutable ? ["--ignore-immutable"] : []),
      ],
      { timeout: 5000 },
    );
  });

export const jjWorkspaceUpdateStale = (
  _config: RepositoryConfig,
  cwd: string,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(["workspace", "update-stale"], {
      timeout: 30000,
      cwd,
    });
  });

export const jjRestore = (
  _config: RepositoryConfig,
  rev: string | undefined,
  filepaths: string[] | undefined,
  ignoreImmutable = false,
  opts?: { cwd?: string },
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const buffer = yield* cli.runBuffer(
      [
        "restore",
        "--changes-in",
        rev ? rev : "@",
        ...(filepaths
          ? filepaths.map((filepath) => filepathToFileset(filepath))
          : []),
        ...(ignoreImmutable ? ["--ignore-immutable"] : []),
      ],
      { timeout: 5000, ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
    );
    return buffer.toString();
  });

export const gitFetch = (
  _config: RepositoryConfig,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(["git", "fetch"], { timeout: 60_000 });
  });

export const operationUndo = (
  config: RepositoryConfig,
  id: string,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      [
        "operation",
        semver.gte(config.jjVersion, "0.33.0") ? "revert" : "undo",
        id,
      ],
      { timeout: 5000 },
    );
  });

export const operationRestore = (
  _config: RepositoryConfig,
  id: string,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(["operation", "restore", id], { timeout: 5000 });
  });

export const readFile = (
  _config: RepositoryConfig,
  rev: string,
  filepath: string,
): Effect.Effect<Buffer, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.runBuffer(
      ["file", "show", "--revision", rev, filepathToFileset(filepath)],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
  });

export const annotate = (
  _config: RepositoryConfig,
  filepath: string,
  rev: string,
): Effect.Effect<string[], JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const output = yield* cli.run(["file", "annotate", "-r", rev, filepath], {
      timeout: 60_000,
      ignoreWorkingCopy: true,
    });
    if (output === "") {
      return [];
    }
    const lines = output.trim().split("\n");
    return lines.map((line) => line.split(" ")[0]);
  });

export const log = (
  _config: RepositoryConfig,
  rev: string = "::",
  template: string = "builtin_log_compact",
  limit: number = 50,
  noGraph: boolean = false,
): Effect.Effect<string, JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    return yield* cli.run(
      [
        "log",
        "-r",
        rev,
        "-n",
        limit.toString(),
        "-T",
        template,
        ...(noGraph ? ["--no-graph"] : []),
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
  });

export const getOperationLog = (
  _config: RepositoryConfig,
): Effect.Effect<Operation[], JJCliError | JJImmutableError, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const rt = operationRecordTemplate;

    const output = yield* cli.run(
      [
        "operation",
        "log",
        "--limit",
        "10",
        "--no-graph",
        "--at-operation=@",
        "-T",
        rt.template,
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );

    return parseOperationLog(output, rt);
  });

// --- Streaming ---

export const showAllPaginated = (
  config: RepositoryConfig,
  revsets: string[],
): Stream.Stream<Show, JJCliError, RepositoryEnv> => {
  const startSentinel = showPaginatedRecordTemplate.startSentinel ?? "ඞSTARTඞ";
  const rt = showPaginatedRecordTemplate;

  return Stream.unwrap(
    Effect.gen(function* () {
      const cli = yield* JJCli;

      return cli
        .runStreaming([
          "log",
          "-T",
          rt.template,
          ...revsets.flatMap((r) => ["-r", r]),
        ])
        .pipe(
          splitOnSeparator(rt.recordSeparator),
          Stream.map((record) => {
            const startIndex = record.indexOf(startSentinel);
            if (startIndex === -1) {
              return null;
            }
            return record.slice(startIndex + startSentinel.length);
          }),
          Stream.filter((r): r is string => r !== null),
          Stream.map((revResult) =>
            parseShowResult(
              config.repositoryRoot,
              revResult,
              rt,
              SHOW_FILE_SEPARATOR,
              SHOW_FILE_FIELD_SEPARATOR,
            ),
          ),
        );
    }),
  );
};

// --- Fakeeditor-based operations ---

/**
 * Parse the 5-line fakeeditor output block:
 * line 0: PID, line 1: CWD, line 2: executable path, line 3: left folder, line 4: right folder
 */
function parseFakeeditorOutput(output: string): {
  pid: string;
  cwd: string;
  leftFolder: string;
  rightFolder: string;
  lines: string[];
} {
  const lines = output.trim().split("\n");
  const pid = lines[0];
  const cwd = lines[1];
  // lines[2] is the fakeeditor executable path
  const leftFolder = lines[3];
  const rightFolder = lines[4];

  if (lines.length !== 5) {
    throw new Error(`Unexpected output from fakeeditor: ${output}`);
  }
  if (
    !pid ||
    !cwd ||
    !leftFolder ||
    !leftFolder.endsWith("left") ||
    !rightFolder ||
    !rightFolder.endsWith("right")
  ) {
    throw new Error(`Unexpected output from fakeeditor: ${output}`);
  }

  return { pid, cwd, leftFolder, rightFolder, lines };
}

function resolveAbsolutePath(folder: string, cwd: string): string {
  return path.isAbsolute(folder) ? folder : path.join(cwd, folder);
}

export const jjSquashContent = (
  config: RepositoryConfig,
  {
    fromRev,
    toRev,
    filepath,
    content,
    ignoreImmutable = false,
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
    ignoreImmutable?: boolean;
  },
): Effect.Effect<void, JJCliError | JJImmutableError | Error, RepositoryEnv> =>
  Effect.gen(function* () {
    const cli = yield* JJCli;
    const resources = yield* ExtensionResources;
    const session = yield* resources.createFakeeditorSession();

    try {
      const handle = yield* cli.runWithFakeeditor(
        [
          "squash",
          "--from",
          fromRev,
          "--into",
          toRev,
          "--interactive",
          "--tool",
          resources.fakeEditorPath,
          "--use-destination-message",
          ...(ignoreImmutable ? ["--ignore-immutable"] : []),
        ],
        { timeout: 10_000, env: session.envVars },
      );

      let parsed: ReturnType<typeof parseFakeeditorOutput>;
      try {
        parsed = parseFakeeditorOutput(handle.output);
      } catch (e) {
        handle.killFakeeditor(handle.output.trim().split("\n")[0]);
        throw e;
      }

      const leftFolderAbsPath = resolveAbsolutePath(
        parsed.leftFolder,
        parsed.cwd,
      );
      const rightFolderAbsPath = resolveAbsolutePath(
        parsed.rightFolder,
        parsed.cwd,
      );

      try {
        const relativeFilePath = path.relative(config.repositoryRoot, filepath);
        const fileToEdit = path.join(rightFolderAbsPath, relativeFilePath);

        // Copy left → right, then write the new content for the specific file.
        yield* Effect.tryPromise({
          try: () =>
            fs.rm(rightFolderAbsPath, { recursive: true, force: true }),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () => fs.mkdir(rightFolderAbsPath, { recursive: true }),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () =>
            fs.cp(leftFolderAbsPath, rightFolderAbsPath, {
              recursive: true,
            }),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () => fs.rm(fileToEdit, { force: true }),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () => fs.writeFile(fileToEdit, content),
          catch: toError,
        });
        yield* session.succeed;
        yield* Effect.tryPromise({
          try: () => handle.succeedAndWait(),
          catch: toError,
        });
      } catch (e) {
        handle.killFakeeditor(parsed.pid);
        throw e;
      }
    } finally {
      yield* session.cleanup;
    }
  });

interface DiffOriginalRevInfo {
  parentCommitId: string;
  files: FileStatus[];
}

const diffOriginalRevInfoCache = new Map<string, DiffOriginalRevInfo>();

const getDiffOriginalRevInfo = (
  config: RepositoryConfig,
  rev: string,
): Effect.Effect<
  DiffOriginalRevInfo,
  JJCliError | JJImmutableError,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const cacheable = /^[0-9a-f]{12,}$/.test(rev);
    const cacheKey = `${config.repositoryRoot}\n${rev}`;
    if (cacheable) {
      const cached = diffOriginalRevInfoCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }
    const cli = yield* JJCli;
    const [summaryOutput, parentsOutput] = yield* Effect.all(
      [
        cli.run(["diff", "--summary", "-r", rev], {
          timeout: 5000,
          ignoreWorkingCopy: true,
        }),
        cli.run(
          [
            "log",
            "--no-graph",
            "-r",
            rev,
            "-T",
            'self.parents().map(|c| c.commit_id()).join("\\n")',
          ],
          { timeout: 5000, ignoreWorkingCopy: true },
        ),
      ],
      { concurrency: 2 },
    );
    const info: DiffOriginalRevInfo = {
      parentCommitId: parentsOutput.split("\n")[0]?.trim() ?? "",
      files: parseDiffSummary(config.repositoryRoot, summaryOutput),
    };
    if (cacheable) {
      if (diffOriginalRevInfoCache.size >= 50) {
        const oldest = diffOriginalRevInfoCache.keys().next().value;
        if (oldest !== undefined) {
          diffOriginalRevInfoCache.delete(oldest);
        }
      }
      diffOriginalRevInfoCache.set(cacheKey, info);
    }
    return info;
  });

export const getDiffOriginal = (
  config: RepositoryConfig,
  rev: string,
  filepath: string,
): Effect.Effect<
  Buffer | undefined,
  JJCliError | JJImmutableError | Error,
  RepositoryEnv
> =>
  Effect.gen(function* () {
    const info = yield* getDiffOriginalRevInfo(config, rev);
    if (!info.parentCommitId) {
      return undefined;
    }

    const normalizedTarget = path.normalize(filepath).replace(/\\/g, "/");
    const entry = info.files.find((f) =>
      pathEquals(f.path.replace(/\\/g, "/"), normalizedTarget),
    );
    if (!entry || entry.type === "A") {
      return undefined;
    }

    const parentFilepath = entry.renamedFrom
      ? path.join(config.repositoryRoot, entry.renamedFrom)
      : entry.path;

    const cli = yield* JJCli;
    return yield* cli.runBuffer(
      [
        "file",
        "show",
        "--revision",
        info.parentCommitId,
        filepathToFileset(parentFilepath),
      ],
      { timeout: 5000, ignoreWorkingCopy: true },
    );
  });

// --- Helpers ---

function filepathToFileset(filepath: string): string {
  return `file:"${filepath.replaceAll(/\\/g, "\\\\")}"`;
}

function toLogRevset(rev: string): string {
  return /^[k-z]{8,}$/.test(rev) ? `change_id(${rev})` : rev;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

const splitOnSeparator =
  (separator: string) =>
  <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<string, E, R> =>
    self.pipe(
      Stream.mapAccum("", (buffer, chunk) => {
        const combined = buffer + chunk;
        const parts = combined.split(separator);
        const remaining = parts.pop()!;
        return [remaining, parts] as const;
      }),
      Stream.flatMap((parts) => Stream.fromIterable(parts)),
    );
