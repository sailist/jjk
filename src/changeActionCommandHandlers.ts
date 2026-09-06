import { Effect } from "effect";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import {
  readRepoState,
  getActiveWorkspaceRoot,
  resolveGroupChange,
} from "./commandHandlerShared";
import { showInputBox, showQuickPick } from "./services/Vscode";
import {
  getShow,
  jjAbandon,
  jjDescribe,
  jjEdit,
  jjNew,
  jjNewInsertBefore,
  jjRestore,
  jjSquash,
} from "./services/Repository";
import type { FileStatus } from "./types";
import { pathEquals } from "./utils";

const maybePromptForSquashMessage = (
  shouldPrompt: boolean,
  fallbackDescription: string,
): Effect.Effect<
  { readonly cancelled: boolean; readonly message: string | undefined },
  never,
  import("./services/Vscode").Vscode
> =>
  Effect.gen(function* () {
    if (!shouldPrompt) {
      return { cancelled: false, message: undefined } as const;
    }

    const message = yield* showInputBox({
      prompt: "Provide a description",
      placeHolder: "Set description here...",
    });
    if (message === undefined) {
      return { cancelled: true, message: undefined } as const;
    }

    return {
      cancelled: false,
      message: message === "" ? fallbackDescription : message,
    } as const;
  });

export const createChangeActionInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<
  InitCommandHandlers,
  | "newChange"
  | "newChangeBeforeWorkingCopy"
  | "restoreResourceState"
  | "squashToParentResourceState"
  | "squashToWorkingCopyResourceState"
  | "describeChange"
  | "squashToParentResourceGroup"
  | "squashToWorkingCopyResourceGroup"
  | "restoreResourceGroup"
  | "editResourceGroup"
  | "abandonResourceGroup"
> => ({
  newChange: (sourceControl) => {
    const repo = deps.repoLocator.findRepoBySourceControl(sourceControl);
    if (!repo) {
      return;
    }

    const message = sourceControl.inputBox.value.trim() || undefined;
    return deps.runRepoCommand(
      repo,
      jjNew(repo.config, message, undefined, {
        cwd: getActiveWorkspaceRoot(deps, repo),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            sourceControl.inputBox.value = "";
          }),
        ),
      ),
      "Failed to create change",
    );
  },
  newChangeBeforeWorkingCopy: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      Effect.gen(function* () {
        const wcChangeId = readRepoState(repo).status?.workingCopy.changeId;
        yield* jjNewInsertBefore(repo.config, "@", { cwd });
        if (wcChangeId) {
          yield* jjEdit(repo.config, wcChangeId, false, { cwd });
        }
      }),
      "Failed to create change",
    );
  },
  restoreResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          const groupChange = resolveGroupChange(repo, resourceGroup);
          if (!groupChange) {
            return;
          }

          let statuses: FileStatus[];
          if (repo.workingCopyGroup === resourceGroup) {
            if (!state.status) {
              return;
            }
            statuses = resourceStates.map((resourceState) => {
              const found = state.status?.fileStatuses.find((status) =>
                pathEquals(status.path, resourceState.resourceUri.fsPath),
              );
              if (!found) {
                throw new Error("No file status found");
              }
              return found;
            });
          } else {
            const show = state.parentShowResults.get(groupChange.changeId);
            if (!show) {
              return;
            }
            statuses = resourceStates.map((resourceState) => {
              const found = show.fileStatuses.find((status) =>
                pathEquals(status.path, resourceState.resourceUri.fsPath),
              );
              if (!found) {
                throw new Error("No file status found");
              }
              return found;
            });
          }

          const paths = statuses.flatMap((status) => [
            status.path,
            ...(status.renamedFrom ? [status.renamedFrom] : []),
          ]);

          yield* deps.retryImmutable(
            jjRestore(repo.config, groupChange.commitId, paths, false, {
              cwd,
            }),
            `${groupChange.changeId} is immutable, are you sure?`,
            jjRestore(repo.config, groupChange.commitId, paths, true, {
              cwd,
            }),
          );
        }),
      ),
      "Failed to restore",
    );
  },
  squashToParentResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          let destinationParentChange = state.status.parentChanges[0];
          if (state.status.parentChanges.length > 1) {
            const parentOptions = state.status.parentChanges.map((parent) => ({
              label: parent.changeId,
              description: parent.description || "(no description)",
              parent,
            }));
            const selection = yield* showQuickPick(parentOptions, {
              placeHolder: "Select parent to squash into",
            });
            if (!selection) {
              return;
            }
            destinationParentChange = selection.parent;
          } else if (state.status.parentChanges.length === 0) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            resourceGroup.resourceStates.length === resourceStates.length &&
              state.status.workingCopy.description !== "" &&
              destinationParentChange.description !== "",
            destinationParentChange.description,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.commitId,
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              cwd,
            }),
            `${destinationParentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.commitId,
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              ignoreImmutable: true,
              cwd,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  squashToWorkingCopyResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          const parentChange = resolveGroupChange(repo, resourceGroup);
          if (!parentChange || parentChange === state.status.workingCopy) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            resourceGroup.resourceStates.length === resourceStates.length &&
              state.status.workingCopy.description !== "" &&
              parentChange.description !== "",
            state.status.workingCopy.description,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: parentChange.commitId,
              toRev: "@",
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              cwd,
            }),
            `${parentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: parentChange.commitId,
              toRev: "@",
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              ignoreImmutable: true,
              cwd,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  describeChange: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      Effect.gen(function* () {
        const rev = resolveGroupChange(repo, resourceGroup)?.commitId;
        if (!rev) {
          return;
        }
        const showResult = yield* getShow(repo.config, rev);
        const message = yield* showInputBox({
          prompt: "Provide a description",
          placeHolder: "Change description here...",
          value: showResult.change.description,
        });
        if (message === undefined) {
          return;
        }

        yield* deps.retryImmutable(
          jjDescribe(repo.config, rev, message),
          `${rev} is immutable, are you sure?`,
          jjDescribe(repo.config, rev, message, true),
        );
      }),
      "Failed to update description",
    );
  },
  squashToParentResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          let destinationParentChange = state.status.parentChanges[0];
          if (state.status.parentChanges.length > 1) {
            const parentOptions = state.status.parentChanges.map((parent) => ({
              label: parent.changeId,
              description: parent.description || "(no description)",
              parent,
            }));
            const selection = yield* showQuickPick(parentOptions, {
              placeHolder: "Select parent to squash into",
            });
            if (!selection) {
              return;
            }
            destinationParentChange = selection.parent;
          } else if (state.status.parentChanges.length === 0) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            state.status.workingCopy.description !== "" &&
              destinationParentChange.description !== "",
            destinationParentChange.description,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.commitId,
              message: promptResult.message,
              cwd,
            }),
            `${destinationParentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.commitId,
              message: promptResult.message,
              ignoreImmutable: true,
              cwd,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  squashToWorkingCopyResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          const parentChange = resolveGroupChange(repo, resourceGroup);
          if (!parentChange || parentChange === state.status.workingCopy) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            state.status.workingCopy.description !== "" &&
              parentChange.description !== "",
            state.status.workingCopy.description,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: parentChange.commitId,
              toRev: "@",
              message: promptResult.message,
              cwd,
            }),
            `${parentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: parentChange.commitId,
              toRev: "@",
              message: promptResult.message,
              ignoreImmutable: true,
              cwd,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  restoreResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);
    const change = resolveGroupChange(repo, resourceGroup);
    if (!change) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        deps.retryImmutable(
          jjRestore(repo.config, change.commitId, undefined, false, { cwd }),
          `${change.changeId} is immutable, are you sure?`,
          jjRestore(repo.config, change.commitId, undefined, true, { cwd }),
        ),
      ),
      "Failed to restore",
    );
  },
  editResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);
    const change = resolveGroupChange(repo, resourceGroup);
    if (!change) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.retryImmutable(
        jjEdit(repo.config, change.commitId, false, { cwd }),
        `${change.changeId} is immutable, are you sure?`,
        jjEdit(repo.config, change.commitId, true, { cwd }),
      ),
      "Failed to switch to change",
    );
  },
  abandonResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }
    const cwd = getActiveWorkspaceRoot(deps, repo);
    const change = resolveGroupChange(repo, resourceGroup);
    if (!change || change === readRepoState(repo).status?.workingCopy) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.retryImmutable(
        jjAbandon(repo.config, change.commitId, false, { cwd }),
        `${change.changeId} is immutable, are you sure?`,
        jjAbandon(repo.config, change.commitId, true, { cwd }),
      ),
      "Failed to abandon change",
    );
  },
});
