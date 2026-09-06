import * as path from "path";
import * as vscode from "vscode";
import {
  BooleanOverride,
  ErrorInfo,
  FileViewType,
  GitGraphViewGlobalState,
  GitGraphViewWorkspaceState,
  GitRepoSet,
  GitRepoState,
  RepoCommitOrdering,
} from "./types";
import { Disposable } from "./utils";

const AVATARS = "jj-graph.avatars";
const GLOBAL_VIEW_STATE = "jj-graph.globalState";
const LAST_ACTIVE_REPO = "jj-graph.lastActiveRepo";
const REPO_STATES = "jj-graph.repos";
const WORKSPACE_VIEW_STATE = "jj-graph.workspaceState";

export const DEFAULT_REPO_STATE: GitRepoState = {
  cdvDivider: 0.5,
  cdvHeight: 250,
  columnWidths: null,
  commitOrdering: RepoCommitOrdering.Default,
  fileViewType: FileViewType.Default,
  hideRemotes: [],
  includeCommitsMentionedByReflogs: BooleanOverride.Default,
  issueLinkingConfig: null,
  lastImportAt: 0,
  name: null,
  onlyFollowFirstParent: BooleanOverride.Default,
  onRepoLoadShowCheckedOutBranch: BooleanOverride.Default,
  onRepoLoadShowSpecificBranches: null,
  pullRequestConfig: null,
  showRemoteBranches: true,
  showWorkspaces: false,
  showRemoteBranchesV2: BooleanOverride.Default,
  showStashes: BooleanOverride.Default,
  showTags: BooleanOverride.Default,
  workspaceFolderIndex: null,
};

const DEFAULT_JJ_GRAPH_VIEW_GLOBAL_STATE: GitGraphViewGlobalState = {
  alwaysAcceptCheckoutCommit: false,
  issueLinkingConfig: null,
  pushTagSkipRemoteCheck: false,
};

const DEFAULT_JJ_GRAPH_VIEW_WORKSPACE_STATE: GitGraphViewWorkspaceState = {
  findIsCaseSensitive: false,
  findIsRegex: false,
  findOpenCommitDetailsView: false,
};

export interface Avatar {
  image: string | null;
  timestamp: number;
}

export type AvatarCache = { [email: string]: Avatar };

/**
 * Manages the JJ Graph Extension State, which stores data in the Visual Studio Code Workspace State.
 */
export class JJGraphExtensionState extends Disposable {
  private readonly workspaceState: vscode.Memento;

  /**
   * Creates the JJ Graph Extension State.
   * @param context The context of the extension.
   */
  constructor(context: vscode.ExtensionContext) {
    super();
    this.workspaceState = context.workspaceState;
  }

  /* Known Repositories */

  /**
   * Get the known repositories in the current workspace.
   * @returns The set of repositories.
   */
  public getRepos() {
    const repoSet = this.workspaceState.get<GitRepoSet>(REPO_STATES, {});
    const outputSet: GitRepoSet = {};
    Object.keys(repoSet).forEach((repo) => {
      outputSet[repo] = Object.assign({}, DEFAULT_REPO_STATE, repoSet[repo]);
    });
    return outputSet;
  }

  /**
   * Get the set of repositories for the provided repository roots, creating default states for any that are unknown.
   * @param repos The paths of the repositories.
   * @returns The set of repositories.
   */
  public getReposForRoots(repos: ReadonlyArray<string>) {
    const repoSet = this.getRepos();
    const outputSet: GitRepoSet = {};
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    repos.forEach((repo) => {
      const state = Object.assign({}, DEFAULT_REPO_STATE, repoSet[repo]);
      const folderIndex = workspaceFolders.findIndex(
        (folder) => !path.relative(folder.uri.fsPath, repo).startsWith(".."),
      );
      state.workspaceFolderIndex = folderIndex > -1 ? folderIndex : null;
      outputSet[repo] = state;
    });
    return outputSet;
  }

  /**
   * Set the state of a repository.
   * @param repo The path of the repository.
   * @param state The state of the repository.
   */
  public setRepoState(repo: string, state: GitRepoState) {
    const repoSet = this.getRepos();
    repoSet[repo] = state;
    return this.updateWorkspaceState(REPO_STATES, repoSet);
  }

  /* Global View State */

  /**
   * Get the global state of the JJ Graph View.
   * @returns The global state.
   */
  public getGlobalViewState() {
    const globalViewState = this.workspaceState.get<GitGraphViewGlobalState>(
      GLOBAL_VIEW_STATE,
      DEFAULT_JJ_GRAPH_VIEW_GLOBAL_STATE,
    );
    return Object.assign({}, DEFAULT_JJ_GRAPH_VIEW_GLOBAL_STATE, globalViewState);
  }

  /**
   * Set the global state of the JJ Graph View.
   * @param state The global state.
   */
  public setGlobalViewState(state: GitGraphViewGlobalState) {
    return this.updateWorkspaceState(GLOBAL_VIEW_STATE, state);
  }

  /* Workspace View State */

  /**
   * Get the workspace state of the JJ Graph View.
   * @returns The workspace state.
   */
  public getWorkspaceViewState() {
    const workspaceViewState = this.workspaceState.get<GitGraphViewWorkspaceState>(
      WORKSPACE_VIEW_STATE,
      DEFAULT_JJ_GRAPH_VIEW_WORKSPACE_STATE,
    );
    return Object.assign({}, DEFAULT_JJ_GRAPH_VIEW_WORKSPACE_STATE, workspaceViewState);
  }

  /**
   * Set the workspace state of the JJ Graph View.
   * @param state The workspace state.
   */
  public setWorkspaceViewState(state: GitGraphViewWorkspaceState) {
    return this.updateWorkspaceState(WORKSPACE_VIEW_STATE, state);
  }

  /* Last Active Repo */

  /**
   * Get the last active repository in the current workspace.
   * @returns The path of the last active repository.
   */
  public getLastActiveRepo() {
    return this.workspaceState.get<string | null>(LAST_ACTIVE_REPO, null);
  }

  /**
   * Set the last active repository in the current workspace.
   * @param repo The path of the last active repository.
   */
  public setLastActiveRepo(repo: string | null) {
    this.updateWorkspaceState(LAST_ACTIVE_REPO, repo);
  }

  /* Avatars */

  /**
   * Gets the cache of avatars known to JJ Graph.
   * @returns The avatar cache.
   */
  public getAvatarCache() {
    return this.workspaceState.get<AvatarCache>(AVATARS, {});
  }

  /**
   * Add a new avatar to the cache of avatars known to JJ Graph.
   * @param email The email address that the avatar is for.
   * @param avatar The details of the avatar.
   */
  public saveAvatar(email: string, avatar: Avatar) {
    const avatars = this.getAvatarCache();
    avatars[email] = avatar;
    this.updateWorkspaceState(AVATARS, avatars);
  }

  /**
   * Removes an avatar from the cache of avatars known to JJ Graph.
   * @param email The email address of the avatar to remove.
   */
  public removeAvatarFromCache(email: string) {
    const avatars = this.getAvatarCache();
    delete avatars[email];
    this.updateWorkspaceState(AVATARS, avatars);
  }

  /* Update State Memento's */

  /**
   * Update the JJ Graph Workspace State with a new <key, value> pair.
   * @param key The key.
   * @param value The value.
   * @returns A Thenable resolving to the ErrorInfo that resulted from updating the Workspace State.
   */
  private updateWorkspaceState(key: string, value: unknown): Thenable<ErrorInfo> {
    return this.workspaceState.update(key, value).then(
      () => null,
      () => "Visual Studio Code was unable to save the JJ Graph Workspace State Memento.",
    );
  }
}
