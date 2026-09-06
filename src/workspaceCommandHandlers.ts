import * as vscode from "vscode";
import { Effect } from "effect";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { selectRepositoryEffect, toError } from "./commandHandlerShared";
import { jjNew, jjWorkspaceUpdateStale } from "./services/Repository";
import { WorkspaceTreeItem } from "./workspacesTreeView";

export const createWorkspacesInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<
  InitCommandHandlers,
  | "refreshWorkspaces"
  | "selectWorkspacesRepo"
  | "workspaceNew"
  | "workspaceUpdateStale"
  | "workspaceShow"
  | "workspaceSearch"
> => ({
  refreshWorkspaces: () =>
    deps.runExtensionEffect(
      (() => {
        const workspacesManager = deps.getWorkspacesManager();
        return workspacesManager
          ? Effect.tryPromise({
              try: () => workspacesManager.refresh(),
              catch: toError,
            })
          : Effect.void;
      })(),
      "Failed to refresh workspaces",
    ),
  selectWorkspacesRepo: () =>
    deps.runExtensionEffect(
      selectRepositoryEffect(deps),
      "Failed to select repository",
    ),
  workspaceNew: (item) => {
    if (!(item instanceof WorkspaceTreeItem)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(
      vscode.Uri.file(item.repositoryRoot),
    );
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      jjNew(repo.config, undefined, undefined, { cwd: item.workspace.root }),
      "Failed to create change",
    );
  },
  workspaceUpdateStale: (item) => {
    if (!(item instanceof WorkspaceTreeItem)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(
      vscode.Uri.file(item.repositoryRoot),
    );
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      jjWorkspaceUpdateStale(repo.config, item.workspace.root),
      "Failed to update stale workspace",
    );
  },
  workspaceShow: (item) => {
    if (!(item instanceof WorkspaceTreeItem)) {
      return;
    }

    const workspacesManager = deps.getWorkspacesManager();
    if (!workspacesManager) {
      return;
    }

    return deps.runExtensionEffect(
      Effect.sync(() => {
        workspacesManager.setActiveWorkspace(item.workspace);
      }),
      "Failed to show workspace changes",
    );
  },
  workspaceSearch: (item) => {
    if (!(item instanceof WorkspaceTreeItem)) {
      return;
    }

    return vscode.commands.executeCommand("workbench.action.findInFiles", {
      filesToInclude: item.workspace.root,
    });
  },
});
