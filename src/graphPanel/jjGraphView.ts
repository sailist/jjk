import * as vscode from "vscode";
import { AvatarManager } from "./avatarManager";
import { getConfig } from "./config";
import { GitCommitDetailsData, JJConfigKey, JJDataSource, JJGraphLogger } from "./dataSource";
import { JJGraphExtensionState } from "./extensionState";
import {
  ErrorInfo,
  GitConfigLocation,
  GitGraphViewInitialState,
  GitRepoSet,
  LoadGitGraphViewTo,
  RequestMessage,
  ResponseMessage,
} from "./types";
import {
  Disposable,
  Event,
  NOT_SUPPORTED_MSG,
  UNABLE_TO_FIND_JJ_MSG,
  copyFilePathToClipboard,
  copyToClipboard,
  getNonce,
  openExtensionSettings,
  openExternalUrl,
  openFile,
  showErrorMessage,
  standardiseCspSource,
  toDisposable,
  viewDiff,
  viewDiffWithWorkingFile,
  viewFileAtRevision,
  viewScm,
} from "./utils";

/**
 * The source of repositories for the JJ Graph View, implemented by the extension host.
 */
export interface JJGraphRepoSource {
  readonly getRepos: () => string[];
  readonly getSelectedRepo: () => string | null;
  readonly onDidChange: Event<void>;
  readonly rescan: () => Thenable<unknown>;
}

/**
 * Manages the JJ Graph View.
 */
export class JJGraphView extends Disposable {
  public static currentPanel: JJGraphView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly avatarManager: AvatarManager;
  private readonly dataSource: JJDataSource;
  private readonly extensionState: JJGraphExtensionState;
  private readonly repoSource: JJGraphRepoSource;
  private readonly logger: JJGraphLogger;
  private isGraphViewLoaded: boolean = false;
  private isPanelVisible: boolean = true;
  private currentRepo: string | null = null;
  private loadViewTo: LoadGitGraphViewTo = null; // Is used by the next call to getHtmlForWebview, and is then reset to null

  private loadRepoInfoRefreshId: number = 0;
  private loadCommitsRefreshId: number = 0;

  /**
   * If a JJ Graph View already exists, show and update it. Otherwise, create a JJ Graph View.
   * @param extensionUri The uri of the directory containing the extension.
   * @param dataSource The JJ Graph DataSource instance.
   * @param repoSource The JJ Graph RepoSource instance.
   * @param extensionState The JJ Graph ExtensionState instance.
   * @param avatarManager The JJ Graph AvatarManager instance.
   * @param logger The logger instance.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    dataSource: JJDataSource,
    repoSource: JJGraphRepoSource,
    extensionState: JJGraphExtensionState,
    avatarManager: AvatarManager,
    logger: JJGraphLogger,
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;
    const selectedRepo = repoSource.getSelectedRepo();
    const loadViewTo: LoadGitGraphViewTo =
      selectedRepo !== null ? { repo: selectedRepo } : null;

    if (JJGraphView.currentPanel) {
      // If JJ Graph panel already exists
      if (JJGraphView.currentPanel.isPanelVisible) {
        // If the JJ Graph panel is visible
        if (loadViewTo !== null) {
          JJGraphView.currentPanel.respondLoadRepos(
            JJGraphView.currentPanel.getRepoSet(),
            loadViewTo,
          );
        }
      } else {
        // If the JJ Graph panel is not visible
        JJGraphView.currentPanel.loadViewTo = loadViewTo;
      }
      JJGraphView.currentPanel.panel.reveal(column);
    } else {
      // If JJ Graph panel doesn't already exist
      JJGraphView.currentPanel = new JJGraphView(
        extensionUri,
        dataSource,
        repoSource,
        extensionState,
        avatarManager,
        logger,
        loadViewTo,
        column,
      );
    }
  }

  /**
   * Send a refresh message to the JJ Graph View if it is open and displaying the specified repository.
   * @param repoRoot The root of the repository that changed.
   */
  public static refresh(repoRoot: string) {
    if (
      JJGraphView.currentPanel &&
      JJGraphView.currentPanel.panel.visible &&
      JJGraphView.currentPanel.currentRepo === repoRoot
    ) {
      JJGraphView.currentPanel.sendMessage({ command: "refresh" });
    }
  }

  /**
   * Creates a JJ Graph View.
   */
  private constructor(
    extensionUri: vscode.Uri,
    dataSource: JJDataSource,
    repoSource: JJGraphRepoSource,
    extensionState: JJGraphExtensionState,
    avatarManager: AvatarManager,
    logger: JJGraphLogger,
    loadViewTo: LoadGitGraphViewTo,
    column: vscode.ViewColumn | undefined,
  ) {
    super();
    this.extensionUri = extensionUri;
    this.avatarManager = avatarManager;
    this.dataSource = dataSource;
    this.extensionState = extensionState;
    this.repoSource = repoSource;
    this.logger = logger;
    this.loadViewTo = loadViewTo;

    const config = getConfig();
    this.panel = vscode.window.createWebviewPanel(
      "jj-graph",
      "JJ Graph",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "graph")],
        retainContextWhenHidden: config.retainContextWhenHidden,
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "images", "logo.png");

    this.registerDisposables(
      // Dispose JJ Graph View resources when disposed
      toDisposable(() => {
        JJGraphView.currentPanel = undefined;
      }),

      // Dispose this JJ Graph View when the Webview Panel is disposed
      this.panel.onDidDispose(() => this.dispose()),

      // Register a callback that is called when the view is shown or hidden
      this.panel.onDidChangeViewState(() => {
        if (this.panel.visible !== this.isPanelVisible) {
          if (this.panel.visible) {
            this.update();
          } else {
            this.currentRepo = null;
          }
          this.isPanelVisible = this.panel.visible;
        }
      }),

      // Subscribe to events triggered when the set of known repositories changes
      repoSource.onDidChange(() => {
        if (!this.panel.visible) {
          return;
        }
        const numRepos = this.repoSource.getRepos().length;
        if (
          (numRepos === 0 && this.isGraphViewLoaded) ||
          (numRepos > 0 && !this.isGraphViewLoaded)
        ) {
          this.update();
        } else {
          this.respondLoadRepos(this.getRepoSet(), null);
        }
      }),

      // Subscribe to events triggered when an avatar is available
      avatarManager.onAvatar((event) => {
        this.sendMessage({
          command: "fetchAvatar",
          email: event.email,
          image: event.image,
        });
      }),

      // Respond to messages sent from the Webview
      this.panel.webview.onDidReceiveMessage((msg: RequestMessage) =>
        this.respondToMessage(msg),
      ),

      // Dispose the Webview Panel when disposed
      this.panel,
    );

    // Render the content of the Webview
    this.update();

    this.logger.log(
      "Created JJ Graph View" +
        (loadViewTo !== null ? " (active repo: " + loadViewTo.repo + ")" : ""),
    );
  }

  /**
   * Respond to a message sent from the front-end.
   * @param msg The message that was received.
   */
  private async respondToMessage(msg: RequestMessage) {
    let errorInfos: ErrorInfo[];

    switch (msg.command) {
      case "addRemote":
        this.sendMessage({
          command: "addRemote",
          error: await this.dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch),
        });
        break;
      case "addTag":
        errorInfos = [
          await this.dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force),
        ];
        if (errorInfos[0] === null && msg.pushToRemote !== null) {
          errorInfos.push(
            ...await this.dataSource.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck),
          );
        }
        this.sendMessage({
          command: "addTag",
          repo: msg.repo,
          tagName: msg.tagName,
          pushToRemote: msg.pushToRemote,
          commitHash: msg.commitHash,
          errors: errorInfos,
        });
        break;
      case "applyStash":
        this.sendMessage({ command: "applyStash", error: NOT_SUPPORTED_MSG });
        break;
      case "branchFromStash":
        this.sendMessage({ command: "branchFromStash", error: NOT_SUPPORTED_MSG });
        break;
      case "checkoutBranch":
        errorInfos = [await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
        if (errorInfos[0] === null && msg.pullAfterwards !== null) {
          errorInfos.push(
            await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash),
          );
        }
        this.sendMessage({
          command: "checkoutBranch",
          pullAfterwards: msg.pullAfterwards,
          errors: errorInfos,
        });
        break;
      case "checkoutCommit":
        this.sendMessage({
          command: "checkoutCommit",
          error: await this.dataSource.checkoutCommit(msg.repo, msg.commitHash),
        });
        break;
      case "newChange":
        this.sendMessage({
          command: "newChange",
          error: await this.dataSource.newChange(msg.repo, msg.changeId),
        });
        break;
      case "describeChange":
        this.sendMessage({
          command: "describeChange",
          error: await this.dataSource.describeChange(msg.repo, msg.changeId, msg.message),
        });
        break;
      case "squashChange":
        this.sendMessage({
          command: "squashChange",
          error: await this.dataSource.squashChange(msg.repo, msg.changeId),
        });
        break;
      case "cherrypickCommit":
        this.sendMessage({
          command: "cherrypickCommit",
          errors: [await this.dataSource.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)],
        });
        break;
      case "cleanUntrackedFiles":
        this.sendMessage({ command: "cleanUntrackedFiles", error: NOT_SUPPORTED_MSG });
        break;
      case "commitDetails": {
        const data: [GitCommitDetailsData, string | null] = await Promise.all([
          this.dataSource.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents),
          msg.avatarEmail !== null
            ? this.avatarManager.getAvatarImage(msg.avatarEmail)
            : Promise.resolve(null),
        ]);
        this.sendMessage({
          command: "commitDetails",
          ...data[0],
          avatar: data[1],
          codeReview: null,
          refresh: msg.refresh,
        });
        break;
      }
      case "compareCommits":
        this.sendMessage({
          command: "compareCommits",
          commitHash: msg.commitHash,
          compareWithHash: msg.compareWithHash,
          ...await this.dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
          codeReview: null,
          refresh: msg.refresh,
        });
        break;
      case "copyFilePath":
        this.sendMessage({
          command: "copyFilePath",
          error: await copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute),
        });
        break;
      case "copyToClipboard":
        this.sendMessage({
          command: "copyToClipboard",
          type: msg.type,
          error: await copyToClipboard(msg.data),
        });
        break;
      case "createArchive":
        this.sendMessage({ command: "createArchive", error: NOT_SUPPORTED_MSG });
        break;
      case "createBranch":
        this.sendMessage({
          command: "createBranch",
          errors: await this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force),
        });
        break;
      case "createPullRequest":
        this.sendMessage({
          command: "createPullRequest",
          push: msg.push,
          errors: [NOT_SUPPORTED_MSG],
        });
        break;
      case "deleteBranch":
        errorInfos = [await this.dataSource.deleteBranch(msg.repo, msg.branchName, msg.forceDelete)];
        if (errorInfos[0] === null) {
          for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
            errorInfos.push(
              await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]),
            );
          }
        }
        this.sendMessage({
          command: "deleteBranch",
          repo: msg.repo,
          branchName: msg.branchName,
          deleteOnRemotes: msg.deleteOnRemotes,
          errors: errorInfos,
        });
        break;
      case "deleteRemote":
        this.sendMessage({
          command: "deleteRemote",
          error: await this.dataSource.deleteRemote(msg.repo, msg.name),
        });
        break;
      case "deleteRemoteBranch":
        this.sendMessage({
          command: "deleteRemoteBranch",
          error: await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote),
        });
        break;
      case "deleteTag":
        this.sendMessage({
          command: "deleteTag",
          error: await this.dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote),
        });
        break;
      case "deleteUserDetails":
        errorInfos = [];
        if (msg.name) {
          errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, JJConfigKey.UserName, msg.location));
        }
        if (msg.email) {
          errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, JJConfigKey.UserEmail, msg.location));
        }
        this.sendMessage({
          command: "deleteUserDetails",
          errors: errorInfos,
        });
        break;
      case "dropCommit":
        this.sendMessage({
          command: "dropCommit",
          error: await this.dataSource.dropCommit(msg.repo, msg.commitHash),
        });
        break;
      case "dropStash":
        this.sendMessage({ command: "dropStash", error: NOT_SUPPORTED_MSG });
        break;
      case "editRemote":
        this.sendMessage({
          command: "editRemote",
          error: await this.dataSource.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew),
        });
        break;
      case "editUserDetails":
        errorInfos = [
          await this.dataSource.setConfigValue(msg.repo, JJConfigKey.UserName, msg.name, msg.location),
          await this.dataSource.setConfigValue(msg.repo, JJConfigKey.UserEmail, msg.email, msg.location),
        ];
        if (errorInfos[0] === null && errorInfos[1] === null) {
          if (msg.deleteLocalName) {
            errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, JJConfigKey.UserName, GitConfigLocation.Local));
          }
          if (msg.deleteLocalEmail) {
            errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, JJConfigKey.UserEmail, GitConfigLocation.Local));
          }
        }
        this.sendMessage({
          command: "editUserDetails",
          errors: errorInfos,
        });
        break;
      case "endCodeReview":
        break;
      case "exportRepoConfig":
        this.sendMessage({ command: "exportRepoConfig", error: NOT_SUPPORTED_MSG });
        break;
      case "fetch":
        this.sendMessage({
          command: "fetch",
          error: await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags),
        });
        break;
      case "fetchAvatar":
        this.avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
        break;
      case "fetchIntoLocalBranch":
        this.sendMessage({
          command: "fetchIntoLocalBranch",
          error: await this.dataSource.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force),
        });
        break;
      case "loadCommits":
        this.loadCommitsRefreshId = msg.refreshId;
        this.sendMessage({
          command: "loadCommits",
          refreshId: msg.refreshId,
          onlyFollowFirstParent: msg.onlyFollowFirstParent,
          ...await this.dataSource.getCommits(msg.repo, msg.branches, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, msg.showWorkspaces ?? false),
        });
        break;
      case "loadConfig":
        this.sendMessage({
          command: "loadConfig",
          repo: msg.repo,
          ...await this.dataSource.getConfig(msg.repo, msg.remotes),
        });
        break;
      case "loadRepoInfo": {
        this.loadRepoInfoRefreshId = msg.refreshId;
        const repoInfo = await this.dataSource.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes);
        let isRepo = true;
        if (repoInfo.error) {
          // If an error occurred, check to make sure the repo still exists
          isRepo = (await this.dataSource.repoRoot(msg.repo)) !== null;
          if (!isRepo) {
            repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
          }
        }
        this.sendMessage({
          command: "loadRepoInfo",
          refreshId: msg.refreshId,
          ...repoInfo,
          isRepo: isRepo,
        });
        if (msg.repo !== this.currentRepo) {
          this.currentRepo = msg.repo;
          this.extensionState.setLastActiveRepo(msg.repo);
        }
        break;
      }
      case "loadRepos":
        this.respondLoadRepos(this.getRepoSet(), null);
        break;
      case "merge":
        this.sendMessage({
          command: "merge",
          actionOn: msg.actionOn,
          error: await this.dataSource.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit),
        });
        break;
      case "openExtensionSettings":
        this.sendMessage({
          command: "openExtensionSettings",
          error: await openExtensionSettings(),
        });
        break;
      case "openExternalDirDiff":
        this.sendMessage({ command: "openExternalDirDiff", error: NOT_SUPPORTED_MSG });
        break;
      case "openExternalUrl":
        this.sendMessage({
          command: "openExternalUrl",
          error: await openExternalUrl(msg.url),
        });
        break;
      case "openFile":
        this.sendMessage({
          command: "openFile",
          error: await openFile(msg.repo, msg.filePath),
        });
        break;
      case "openTerminal":
        this.sendMessage({
          command: "openTerminal",
          error: await this.dataSource.openJjTerminal(msg.repo, null, msg.name),
        });
        break;
      case "popStash":
        this.sendMessage({ command: "popStash", error: NOT_SUPPORTED_MSG });
        break;
      case "pruneRemote":
        this.sendMessage({ command: "pruneRemote", error: NOT_SUPPORTED_MSG });
        break;
      case "pullBranch":
        this.sendMessage({
          command: "pullBranch",
          error: await this.dataSource.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash),
        });
        break;
      case "pushBranch":
        this.sendMessage({
          command: "pushBranch",
          willUpdateBranchConfig: msg.willUpdateBranchConfig,
          errors: await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode),
        });
        break;
      case "pushStash":
        this.sendMessage({ command: "pushStash", error: NOT_SUPPORTED_MSG });
        break;
      case "pushTag":
        this.sendMessage({
          command: "pushTag",
          repo: msg.repo,
          tagName: msg.tagName,
          remotes: msg.remotes,
          commitHash: msg.commitHash,
          errors: await this.dataSource.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck),
        });
        break;
      case "rebase":
        this.sendMessage({
          command: "rebase",
          actionOn: msg.actionOn,
          interactive: msg.interactive,
          error: await this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive),
        });
        break;
      case "renameBranch":
        this.sendMessage({
          command: "renameBranch",
          error: await this.dataSource.renameBranch(msg.repo, msg.oldName, msg.newName),
        });
        break;
      case "rescanForRepos":
        await this.repoSource.rescan();
        if (this.repoSource.getRepos().length > 0) {
          this.respondLoadRepos(this.getRepoSet(), null);
        } else {
          showErrorMessage("No JJ repositories were found in the current workspace.");
        }
        break;
      case "resetFileToRevision":
        this.sendMessage({
          command: "resetFileToRevision",
          error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath),
        });
        break;
      case "resetToCommit":
        this.sendMessage({ command: "resetToCommit", error: NOT_SUPPORTED_MSG });
        break;
      case "revertCommit":
        this.sendMessage({ command: "revertCommit", error: NOT_SUPPORTED_MSG });
        break;
      case "setGlobalViewState":
        this.sendMessage({
          command: "setGlobalViewState",
          error: await this.extensionState.setGlobalViewState(msg.state),
        });
        break;
      case "setRepoState":
        this.extensionState.setRepoState(msg.repo, msg.state);
        break;
      case "setWorkspaceViewState":
        this.sendMessage({
          command: "setWorkspaceViewState",
          error: await this.extensionState.setWorkspaceViewState(msg.state),
        });
        break;
      case "showErrorMessage":
        showErrorMessage(msg.message);
        break;
      case "startCodeReview":
        this.sendMessage({
          command: "startCodeReview",
          error: NOT_SUPPORTED_MSG,
          codeReview: { id: msg.id, lastActive: 0, lastViewedFile: null, remainingFiles: [] },
          commitHash: msg.commitHash,
          compareWithHash: msg.compareWithHash,
        });
        break;
      case "tagDetails":
        this.sendMessage({
          command: "tagDetails",
          tagName: msg.tagName,
          commitHash: msg.commitHash,
          ...await this.dataSource.getTagDetails(msg.repo, msg.tagName),
        });
        break;
      case "updateCodeReview":
        this.sendMessage({
          command: "updateCodeReview",
          error: NOT_SUPPORTED_MSG,
        });
        break;
      case "viewDiff":
        this.sendMessage({
          command: "viewDiff",
          error: await viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type),
        });
        break;
      case "viewDiffWithWorkingFile":
        this.sendMessage({
          command: "viewDiffWithWorkingFile",
          error: await viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath),
        });
        break;
      case "viewFileAtRevision":
        this.sendMessage({
          command: "viewFileAtRevision",
          error: await viewFileAtRevision(msg.repo, msg.hash, msg.filePath),
        });
        break;
      case "viewScm":
        this.sendMessage({
          command: "viewScm",
          error: await viewScm(),
        });
        break;
    }
  }

  /**
   * Send a message to the front-end.
   * @param msg The message to be sent.
   */
  private sendMessage(msg: ResponseMessage) {
    if (this.isDisposed()) {
      this.logger.log('The JJ Graph View has already been disposed, ignored sending "' + msg.command + '" message.');
    } else {
      this.panel.webview.postMessage(msg).then(
        () => {},
        () => {
          if (this.isDisposed()) {
            this.logger.log('The JJ Graph View was disposed while sending "' + msg.command + '" message.');
          } else {
            this.logger.logError('Unable to send "' + msg.command + '" message to the JJ Graph View.');
          }
        },
      );
    }
  }

  /**
   * Update the HTML document loaded in the Webview.
   */
  private update() {
    this.panel.webview.html = this.getHtmlForWebview();
  }

  /**
   * Get the set of repositories to provide to the front-end.
   * @returns The set of repositories.
   */
  private getRepoSet(): GitRepoSet {
    return this.extensionState.getReposForRoots(this.repoSource.getRepos());
  }

  /**
   * Get the HTML document to be loaded in the Webview.
   * @returns The HTML.
   */
  private getHtmlForWebview() {
    const config = getConfig(),
      nonce = getNonce();
    const initialState: GitGraphViewInitialState = {
      config: {
        commitDetailsView: config.commitDetailsView,
        commitOrdering: config.commitOrder,
        contextMenuActionsVisibility: config.contextMenuActionsVisibility,
        customBranchGlobPatterns: config.customBranchGlobPatterns,
        customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
        customPullRequestProviders: config.customPullRequestProviders,
        dateFormat: config.dateFormat,
        defaultColumnVisibility: config.defaultColumnVisibility,
        dialogDefaults: config.dialogDefaults,
        enhancedAccessibility: config.enhancedAccessibility,
        fetchAndPrune: config.fetchAndPrune,
        fetchAndPruneTags: config.fetchAndPruneTags,
        fetchAvatars: config.fetchAvatars,
        graph: config.graph,
        includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
        initialLoadCommits: config.initialLoadCommits,
        keybindings: config.keybindings,
        loadMoreCommits: config.loadMoreCommits,
        loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
        markdown: config.markdown,
        mute: config.muteCommits,
        onlyFollowFirstParent: config.onlyFollowFirstParent,
        onRepoLoad: config.onRepoLoad,
        referenceLabels: config.referenceLabels,
        repoDropdownOrder: config.repoDropdownOrder,
        showRemoteBranches: config.showRemoteBranches,
        showStashes: config.showStashes,
        showTags: config.showTags,
      },
      lastActiveRepo: this.extensionState.getLastActiveRepo() ?? this.repoSource.getSelectedRepo(),
      loadViewTo: this.loadViewTo,
      repos: this.getRepoSet(),
      loadRepoInfoRefreshId: this.loadRepoInfoRefreshId,
      loadCommitsRefreshId: this.loadCommitsRefreshId,
    };
    const globalState = this.extensionState.getGlobalViewState();
    const workspaceState = this.extensionState.getWorkspaceViewState();

    let body: string;
    const numRepos = Object.keys(initialState.repos).length;
    let colorVars = "",
      colorParams = "";
    for (let i = 0; i < initialState.config.graph.colours.length; i++) {
      colorVars += "--git-graph-color" + i + ":" + initialState.config.graph.colours[i] + "; ";
      colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ");} ";
    }

    if (this.dataSource.isJjExecutableUnknown()) {
      body = `<body class="unableToLoad">
			<h2>Unable to load JJ Graph</h2>
			<p class="unableToLoadMessage">${UNABLE_TO_FIND_JJ_MSG}</p>
			</body>`;
    } else if (numRepos > 0) {
      body = `<body>
			<div id="view" tabindex="-1">
				<div id="controls">
					<span id="repoControl"><span class="unselectable">Repo: </span><div id="repoDropdown" class="dropdown"></div></span>
					<span id="branchControl"><span class="unselectable">Bookmarks: </span><div id="branchDropdown" class="dropdown"></div></span>
					<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span>Show Remote Bookmarks</label>
					<label id="showWorkspacesControl"><input type="checkbox" id="showWorkspacesCheckbox" tabindex="-1"><span class="customCheckbox"></span>Workspaces</label>
					<div id="findBtn" title="Find"></div>
					<div id="terminalBtn" title="Open a Terminal for this Repository"></div>
					<div id="settingsBtn" title="Repository Settings"></div>
					<div id="fetchBtn"></div>
					<div id="refreshBtn"></div>
				</div>
				<div id="content">
					<div id="commitGraph"></div>
					<div id="commitTable"></div>
				</div>
				<div id="footer"></div>
			</div>
			<div id="scrollShadow"></div>
			<script nonce="${nonce}">var initialState = ${JSON.stringify(initialState)}, globalState = ${JSON.stringify(globalState)}, workspaceState = ${JSON.stringify(workspaceState)};</script>
			<script nonce="${nonce}" src="${this.getGraphUri("main.js")}"></script>
			</body>`;
    } else {
      body = `<body class="unableToLoad">
			<h2>Unable to load JJ Graph</h2>
			<p class="unableToLoadMessage">No JJ repositories were found in the current workspace when it was last scanned by JJ Graph.</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">Re-scan the current workspace for repositories</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
    }
    this.isGraphViewLoaded = numRepos > 0;
    this.loadViewTo = null;

    return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getGraphUri("main.css")}">
				<title>JJ Graph</title>
				<style>body{${colorVars}} ${colorParams}</style>
			</head>
			${body}
		</html>`;
  }

  /* URI Manipulation Methods */

  /**
   * Get a WebviewUri for a bundled graph web file.
   * @param file The file name in the `dist/graph` directory.
   * @returns The WebviewUri.
   */
  private getGraphUri(file: string) {
    return this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "graph", file))
      .toString();
  }

  /* Response Construction Methods */

  /**
   * Send the known repositories to the front-end.
   * @param repos The set of known repositories.
   * @param loadViewTo What to load the view to.
   */
  private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
    this.sendMessage({
      command: "loadRepos",
      repos: repos,
      lastActiveRepo: this.extensionState.getLastActiveRepo() ?? this.repoSource.getSelectedRepo(),
      loadViewTo: loadViewTo,
    });
  }
}
