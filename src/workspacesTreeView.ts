import {
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Event,
  TreeView,
  ThemeIcon,
  window,
} from "vscode";
import path from "path";
import type { RepoHandle } from "./repoHandle";
import type { WorkspaceInfo } from "./types";
import { pathEquals } from "./utils";
import { logger } from "./logger";

export interface WorkspaceGroupRule {
  name: string;
  pattern: string;
}

interface WorkspacesManagerDeps {
  readonly initialRepo: RepoHandle;
  readonly loadWorkspaces: (repo: RepoHandle) => Promise<{
    workspaces: readonly WorkspaceInfo[];
    groupRules: readonly WorkspaceGroupRule[];
  }>;
  readonly refreshDisplayedState: (repo: RepoHandle) => void;
  readonly checkWorkspaceEmpty: (
    repo: RepoHandle,
    workspace: WorkspaceInfo,
  ) => Promise<boolean>;
}

type WorkspacesTreeNode = WorkspaceGroupTreeItem | WorkspaceTreeItem;

const globMatch = (pattern: string, value: string): boolean => {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`).test(value);
};

const defaultGroupName = (
  repositoryRoot: string,
  workspaceRoot: string,
): string => {
  if (pathEquals(repositoryRoot, workspaceRoot)) {
    return "Main";
  }
  const parent = path.dirname(path.relative(repositoryRoot, workspaceRoot));
  const segments = parent
    .split(path.sep)
    .filter((segment) => segment !== ".." && segment !== ".");
  if (segments.length === 0) {
    return "(root)";
  }
  return segments.join("/");
};

const groupNameFor = (
  repositoryRoot: string,
  workspaceRoot: string,
  rules: readonly WorkspaceGroupRule[],
): string => {
  const rel = pathEquals(repositoryRoot, workspaceRoot)
    ? ""
    : path.relative(repositoryRoot, workspaceRoot).split(path.sep).join("/");
  for (const rule of rules) {
    if (globMatch(rule.pattern, rel)) {
      return rule.name;
    }
  }
  return defaultGroupName(repositoryRoot, workspaceRoot);
};

export class WorkspaceGroupTreeItem extends TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly workspaces: WorkspaceTreeItem[],
  ) {
    super(groupName, TreeItemCollapsibleState.Expanded);
    this.id = `jjWsGroup:${groupName}`;
    this.contextValue = "jjWsGroup";
    this.iconPath = new ThemeIcon("folder");
  }
}

export class WorkspaceTreeItem extends TreeItem {
  constructor(
    public readonly workspace: WorkspaceInfo,
    public readonly repositoryRoot: string,
    public readonly stale: boolean,
    public readonly active: boolean,
    public readonly empty: boolean,
  ) {
    super(workspace.name, TreeItemCollapsibleState.None);
    this.id = `jjWorkspace:${workspace.name}`;
    this.contextValue = stale ? "jjWorkspace.stale" : "jjWorkspace";
    let stateBadge: string | undefined;
    if (!workspace.isEmpty) {
      stateBadge = "modified";
    } else if (empty) {
      stateBadge = "empty";
    }
    const badges = [
      ...(active ? ["active"] : []),
      ...(stateBadge ? [stateBadge] : []),
      ...(workspace.isDivergent ? ["divergent"] : []),
      ...(workspace.isConflict ? ["conflict"] : []),
      ...(stale ? ["stale"] : []),
    ].join(", ");
    this.description = badges ? `(${badges})` : "";
    this.tooltip = `${workspace.root}\ntarget: ${workspace.targetChangeId}`;
    this.iconPath = new ThemeIcon(active ? "check" : "repo");
    this.command = {
      title: "Show workspace changes",
      command: "jj.workspaceShow",
      arguments: [this],
    };
  }
}

export class WorkspacesManager {
  private readonly subscriptions: {
    dispose(): unknown;
  }[] = [];
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<
    WorkspacesTreeNode | undefined | null | void
  >();
  private readonly workspacesTreeDataProvider: WorkspacesTreeDataProvider;
  private readonly workspacesTreeView: TreeView<WorkspacesTreeNode>;
  private selectedRepo: RepoHandle;
  private workspaceInfos: readonly WorkspaceInfo[] = [];
  private groupRules: readonly WorkspaceGroupRule[] = [];
  private groupItems: WorkspaceGroupTreeItem[] = [];
  private readonly staleWorkspaceNames = new Set<string>();
  private readonly emptyStateByWorkspace = new Map<
    string,
    { signature: string; empty: boolean }
  >();
  private emptyCheckToken = 0;
  private disposed = false;

  constructor(private readonly deps: WorkspacesManagerDeps) {
    this.selectedRepo = deps.initialRepo;
    this.workspacesTreeDataProvider = new WorkspacesTreeDataProvider(
      () => this.groupItems,
      this.onDidChangeTreeDataEmitter.event,
    );
    this.workspacesTreeView = window.createTreeView<WorkspacesTreeNode>(
      "jjWorkspaces",
      {
        treeDataProvider: this.workspacesTreeDataProvider,
        showCollapseAll: true,
      },
    );
    this.workspacesTreeView.title = `Workspaces (${path.basename(
      this.selectedRepo.config.repositoryRoot,
    )})`;
    this.subscriptions.push(this.workspacesTreeView);
    void this.refresh();
  }

  async setSelectedRepo(repo: RepoHandle) {
    const prevRepo = this.selectedRepo;
    this.selectedRepo = repo;
    this.workspacesTreeView.title = `Workspaces (${path.basename(
      repo.config.repositoryRoot,
    )})`;
    if (prevRepo.config.repositoryRoot !== repo.config.repositoryRoot) {
      this.emptyCheckToken++;
      this.emptyStateByWorkspace.clear();
      if (prevRepo.activeWorkspace) {
        prevRepo.activeWorkspace = undefined;
        this.deps.refreshDisplayedState(prevRepo);
      }
      this.staleWorkspaceNames.clear();
      await this.refresh();
    }
  }

  async refresh() {
    try {
      const { workspaces, groupRules } = await this.deps.loadWorkspaces(
        this.selectedRepo,
      );
      this.workspaceInfos = workspaces;
      this.groupRules = groupRules;
      const names = new Set(workspaces.map((workspace) => workspace.name));
      for (const name of [...this.staleWorkspaceNames]) {
        if (!names.has(name)) {
          this.staleWorkspaceNames.delete(name);
        }
      }
      for (const name of [...this.emptyStateByWorkspace.keys()]) {
        if (!names.has(name)) {
          this.emptyStateByWorkspace.delete(name);
        }
      }
      const active = this.selectedRepo.activeWorkspace;
      if (active && !names.has(active.name)) {
        this.selectedRepo.activeWorkspace = undefined;
        this.deps.refreshDisplayedState(this.selectedRepo);
      }
      this.rebuildGroupItems();
      this.onDidChangeTreeDataEmitter.fire();
      void this.runEmptyChecks(workspaces);
    } catch (e) {
      logger.error(`Failed to refresh workspaces: ${String(e)}`);
    }
  }

  getSelectedRepo() {
    return this.selectedRepo;
  }

  getActiveWorkspace(): { name: string; root: string } | undefined {
    return this.selectedRepo.activeWorkspace;
  }

  setActiveWorkspace(workspace: WorkspaceInfo | null) {
    const isDefault =
      workspace !== null &&
      pathEquals(workspace.root, this.selectedRepo.config.repositoryRoot);
    this.selectedRepo.activeWorkspace =
      workspace !== null && !isDefault
        ? { name: workspace.name, root: workspace.root }
        : undefined;
    this.rebuildGroupItems();
    this.onDidChangeTreeDataEmitter.fire();
    this.deps.refreshDisplayedState(this.selectedRepo);
  }

  setWorkspaceStale(name: string, stale: boolean) {
    if (this.staleWorkspaceNames.has(name) === stale) {
      return;
    }
    if (stale) {
      this.staleWorkspaceNames.add(name);
    } else {
      this.staleWorkspaceNames.delete(name);
    }
    this.rebuildGroupItems();
    this.onDidChangeTreeDataEmitter.fire();
  }

  dispose() {
    this.disposed = true;
    this.emptyCheckToken++;
    this.onDidChangeTreeDataEmitter.dispose();
    this.subscriptions.forEach((s) => s.dispose());
  }

  private async runEmptyChecks(workspaces: readonly WorkspaceInfo[]) {
    const token = ++this.emptyCheckToken;
    const repo = this.selectedRepo;
    const pending = workspaces.filter((workspace) => {
      if (!workspace.isEmpty) {
        this.emptyStateByWorkspace.delete(workspace.name);
        return false;
      }
      const cached = this.emptyStateByWorkspace.get(workspace.name);
      return !cached || cached.signature !== workspace.targetChangeId;
    });
    if (pending.length === 0) {
      return;
    }
    let index = 0;
    const isStale = () =>
      this.disposed || token !== this.emptyCheckToken || this.selectedRepo !== repo;
    const workerCount = Math.min(4, pending.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (index < pending.length) {
          const workspace = pending[index++];
          if (isStale()) {
            return;
          }
          try {
            const empty = await this.deps.checkWorkspaceEmpty(repo, workspace);
            if (isStale()) {
              return;
            }
            const cached = this.emptyStateByWorkspace.get(workspace.name);
            if (
              cached &&
              cached.signature === workspace.targetChangeId &&
              cached.empty === empty
            ) {
              continue;
            }
            this.emptyStateByWorkspace.set(workspace.name, {
              signature: workspace.targetChangeId,
              empty,
            });
            this.rebuildGroupItems();
            this.onDidChangeTreeDataEmitter.fire();
          } catch (e) {
            logger.error(
              `Failed to check empty state for workspace ${workspace.name}: ${String(e)}`,
            );
          }
        }
      }),
    );
  }

  private rebuildGroupItems() {
    const byGroup = new Map<string, WorkspaceTreeItem[]>();
    for (const workspace of this.workspaceInfos) {
      const groupName = groupNameFor(
        this.selectedRepo.config.repositoryRoot,
        workspace.root,
        this.groupRules,
      );
      const emptyState = this.emptyStateByWorkspace.get(workspace.name);
      const item = new WorkspaceTreeItem(
        workspace,
        this.selectedRepo.config.repositoryRoot,
        this.staleWorkspaceNames.has(workspace.name),
        this.selectedRepo.activeWorkspace?.name === workspace.name,
        emptyState?.empty === true &&
          emptyState.signature === workspace.targetChangeId,
      );
      const existing = byGroup.get(groupName);
      if (existing) {
        existing.push(item);
      } else {
        byGroup.set(groupName, [item]);
      }
    }
    const groupNames = [...byGroup.keys()].sort((a, b) => {
      if (a === "Main") {
        return -1;
      }
      if (b === "Main") {
        return 1;
      }
      return a.localeCompare(b);
    });
    this.groupItems = groupNames.map((groupName) => {
      const workspaces = byGroup.get(groupName)!;
      workspaces.sort((a, b) =>
        a.workspace.name.localeCompare(b.workspace.name),
      );
      return new WorkspaceGroupTreeItem(groupName, workspaces);
    });
  }
}

export class WorkspacesTreeDataProvider
  implements TreeDataProvider<WorkspacesTreeNode>
{
  constructor(
    private readonly getGroupItems: () => readonly WorkspaceGroupTreeItem[],
    readonly onDidChangeTreeData: Event<
      WorkspacesTreeNode | undefined | null | void
    >,
  ) {}

  getTreeItem(element: WorkspacesTreeNode): TreeItem {
    return element;
  }

  getChildren(element?: WorkspacesTreeNode): WorkspacesTreeNode[] {
    if (!element) {
      return [...this.getGroupItems()];
    }
    if (element instanceof WorkspaceGroupTreeItem) {
      return [...element.workspaces];
    }
    return [];
  }
}
