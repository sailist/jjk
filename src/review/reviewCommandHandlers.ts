import * as vscode from "vscode";
import path from "path";
import { Effect } from "effect";
import type { InitCommandHandlers } from "../commands";
import type {
  CommandHandlerDeps,
  RepoCommandEffect,
} from "../commandHandlerShared";
import { resolveGroupChange, toError } from "../commandHandlerShared";
import { showQuickPick, type Vscode } from "../services/Vscode";
import { getShow, log } from "../services/Repository";
import type { RepoHandle } from "../repoHandle";
import type { Change } from "../types";

const pickRepo = (
  deps: CommandHandlerDeps,
): Effect.Effect<RepoHandle | undefined, Error, Vscode> =>
  Effect.gen(function* () {
    const repos = deps.repos();
    if (repos.length === 0) {
      return undefined;
    }
    if (repos.length === 1) {
      return repos[0];
    }
    const selected = yield* showQuickPick(
      repos.map((repo) => repo.config.repositoryRoot),
      { placeHolder: "Select a repository" },
    );
    return repos.find((repo) => repo.config.repositoryRoot === selected);
  });

const pickChange = (
  repo: RepoHandle,
): RepoCommandEffect<Change | undefined> =>
  Effect.gen(function* () {
    const items: ({ change: Change } & vscode.QuickPickItem)[] = [];
    const workingCopy = repo.currentState.status?.workingCopy;
    if (workingCopy) {
      items.push({
        label: `@ ${workingCopy.changeId.substring(0, 8)}`,
        description: workingCopy.description || "(no description)",
        detail: "Working Copy",
        alwaysShow: true,
        change: workingCopy,
      });
    }

    const output = yield* log(
      repo.config,
      "::",
      'change_id ++ "\\x1f" ++ commit_id ++ "\\x1f" ++ description.first_line() ++ "\\n"',
      15,
      true,
    );
    for (const line of output.split("\n")) {
      const [changeId, commitId, description] = line.split("\x1f");
      if (!changeId || !commitId || changeId === workingCopy?.changeId) {
        continue;
      }
      items.push({
        label: changeId.substring(0, 8),
        description: description || "(no description)",
        change: { changeId, commitId, description: description ?? "", isEmpty: false, isConflict: false },
      });
    }

    if (items.length === 0) {
      return undefined;
    }
    const selection = yield* showQuickPick(items, {
      placeHolder: "Select a change to review",
    });
    return selection?.change;
  });

const openReviewForChange = (
  deps: CommandHandlerDeps,
  repo: RepoHandle,
  change: Change,
): Promise<void> =>
  deps.runRepoCommand(
    repo,
    Effect.gen(function* () {
      const showResult = yield* getShow(repo.config, change.changeId);
      const files = showResult.fileStatuses.map((status) => ({
        filePath: path
          .relative(repo.config.repositoryRoot, status.path)
          .replaceAll("\\", "/"),
        absPath: status.path,
        status: status.type,
      }));
      if (files.length === 0) {
        yield* showWarningMessageEffect(
          `Change ${change.changeId.substring(0, 8)} has no file changes`,
        );
        return;
      }
      yield* Effect.tryPromise({
        try: () =>
          deps.getReviewManager().show({
            repoRoot: repo.config.repositoryRoot,
            changeId: change.changeId,
            rev: change.commitId,
            files,
          }),
        catch: toError,
      });
    }),
    "Failed to open review",
  );

const showWarningMessageEffect = (message: string) =>
  Effect.tryPromise({
    try: async () => {
      await vscode.window.showWarningMessage(message);
    },
    catch: toError,
  });

export const createReviewInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<InitCommandHandlers, "openReview"> => ({
  openReview: (resourceGroup?: vscode.SourceControlResourceGroup) => {
    if (resourceGroup) {
      const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
      if (!repo) {
        return;
      }
      const change = resolveGroupChange(repo, resourceGroup);
      if (!change) {
        return;
      }
      return openReviewForChange(deps, repo, change);
    }

    return deps.runExtensionEffect(
      Effect.gen(function* () {
        const repo = yield* pickRepo(deps);
        if (!repo) {
          return;
        }
        const change = yield* deps.runRepoEffect(repo, pickChange(repo));
        if (!change) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => openReviewForChange(deps, repo, change),
          catch: toError,
        });
      }),
      "Failed to open review",
    );
  },
});
