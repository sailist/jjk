import * as vscode from "vscode";
import {
  CommitDetailsViewConfig,
  CommitDetailsViewLocation,
  CommitOrdering,
  ContextMenuActionsVisibility,
  CustomBranchGlobPattern,
  CustomEmojiShortcodeMapping,
  CustomPullRequestProvider,
  DateFormat,
  DateFormatType,
  DateType,
  DefaultColumnVisibility,
  DialogDefaults,
  FileViewType,
  GitResetMode,
  GraphConfig,
  GraphStyle,
  GraphUncommittedChangesStyle,
  KeybindingConfig,
  MuteCommitsConfig,
  OnRepoLoadConfig,
  RefLabelAlignment,
  ReferenceLabelsConfig,
  RepoDropdownOrder,
  TabIconColourTheme,
  TagType,
} from "./types";

/**
 * Represents the users configuration of JJ Graph Extension Settings.
 */
class Config {
  private readonly config: vscode.WorkspaceConfiguration;

  private static readonly KEYBINDING_REGEXP = /^CTRL\/CMD \+ [A-Z]$/;

  /**
   * Creates a Config instance.
   * @param repo An option path of a repository (to be used for Workspace Folder Scoped Configuration Values).
   * @returns A Config instance.
   */
  constructor(repo?: string) {
    this.config = vscode.workspace.getConfiguration(
      "jjk.graph",
      repo ? vscode.Uri.file(repo) : undefined,
    );
  }

  /**
   * Get the Commit Details View configuration from the Extension Settings.
   */
  get commitDetailsView(): CommitDetailsViewConfig {
    return {
      autoCenter: !!this.config.get("commitDetailsView.autoCenter", true),
      fileTreeCompactFolders: !!this.config.get(
        "commitDetailsView.fileView.fileTree.compactFolders",
        true,
      ),
      fileViewType:
        this.config.get<string>("commitDetailsView.fileView.type", "File Tree") ===
        "File List"
          ? FileViewType.List
          : FileViewType.Tree,
      location:
        this.config.get<string>("commitDetailsView.location", "Inline") ===
        "Docked to Bottom"
          ? CommitDetailsViewLocation.DockedToBottom
          : CommitDetailsViewLocation.Inline,
    };
  }

  /**
   * Get the value of the `jjk.graph.contextMenuActionsVisibility` Extension Setting.
   */
  get contextMenuActionsVisibility(): ContextMenuActionsVisibility {
    const userConfig: unknown = this.config.get("contextMenuActionsVisibility", {});
    const config: ContextMenuActionsVisibility = {
      branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
      commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, copyHash: true, copySubject: true },
      commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
      remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
      stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
      tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
      uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true },
    };
    mergeConfigObjects(
      config as unknown as { [key: string]: unknown },
      userConfig as { [key: string]: unknown },
    );
    return config;
  }

  /**
   * Get the value of the `jjk.graph.customBranchGlobPatterns` Extension Setting.
   */
  get customBranchGlobPatterns(): CustomBranchGlobPattern[] {
    const inPatterns: unknown = this.config.get("customBranchGlobPatterns", []);
    const outPatterns: CustomBranchGlobPattern[] = [];
    if (Array.isArray(inPatterns)) {
      for (let i = 0; i < inPatterns.length; i++) {
        const pattern: unknown = inPatterns[i];
        if (
          typeof pattern === "object" &&
          pattern !== null &&
          "name" in pattern &&
          "glob" in pattern &&
          typeof pattern.name === "string" &&
          typeof pattern.glob === "string"
        ) {
          outPatterns.push({ name: pattern.name, glob: pattern.glob });
        }
      }
    }
    return outPatterns;
  }

  /**
   * Get the value of the `jjk.graph.customEmojiShortcodeMappings` Extension Setting.
   */
  get customEmojiShortcodeMappings(): CustomEmojiShortcodeMapping[] {
    const inMappings: unknown = this.config.get("customEmojiShortcodeMappings", []);
    const outMappings: CustomEmojiShortcodeMapping[] = [];
    if (Array.isArray(inMappings)) {
      for (let i = 0; i < inMappings.length; i++) {
        const mapping: unknown = inMappings[i];
        if (
          typeof mapping === "object" &&
          mapping !== null &&
          "shortcode" in mapping &&
          "emoji" in mapping &&
          typeof mapping.shortcode === "string" &&
          typeof mapping.emoji === "string"
        ) {
          outMappings.push({
            shortcode: mapping.shortcode,
            emoji: mapping.emoji,
          });
        }
      }
    }
    return outMappings;
  }

  /**
   * Custom Pull Request Providers are not supported in JJ Graph.
   */
  get customPullRequestProviders(): CustomPullRequestProvider[] {
    return [];
  }

  /**
   * Get the value of the `jjk.graph.date.format` Extension Setting.
   */
  get dateFormat(): DateFormat {
    const configValue = this.config.get<string>("date.format", "Date & Time");
    let type = DateFormatType.DateAndTime,
      iso = false;
    if (configValue === "Relative") {
      type = DateFormatType.Relative;
    } else {
      if (configValue.endsWith("Date Only")) {
        type = DateFormatType.DateOnly;
      }
      if (configValue.startsWith("ISO")) {
        iso = true;
      }
    }
    return { type: type, iso: iso };
  }

  /**
   * Get the value of the `jjk.graph.date.type` Extension Setting.
   */
  get dateType() {
    return this.config.get<string>("date.type", "Author Date") === "Commit Date"
      ? DateType.Commit
      : DateType.Author;
  }

  /**
   * Get the value of the `jjk.graph.defaultColumnVisibility` Extension Setting.
   */
  get defaultColumnVisibility(): DefaultColumnVisibility {
    const obj: unknown = this.config.get("defaultColumnVisibility", {});
    if (
      typeof obj === "object" &&
      obj !== null &&
      "Date" in obj &&
      "Author" in obj &&
      "Commit" in obj &&
      typeof obj.Date === "boolean" &&
      typeof obj.Author === "boolean" &&
      typeof obj.Commit === "boolean"
    ) {
      return { author: obj.Author, commit: obj.Commit, date: obj.Date };
    } else {
      return { author: true, commit: true, date: true };
    }
  }

  /**
   * Get the value of the `jjk.graph.dialog.*` Extension Settings.
   */
  get dialogDefaults(): DialogDefaults {
    const resetCommitMode = this.config.get<string>(
      "dialog.resetCurrentBranchToCommit.mode",
      "Mixed",
    );
    const resetUncommittedMode = this.config.get<string>(
      "dialog.resetUncommittedChanges.mode",
      "Mixed",
    );
    const refInputSpaceSubstitution = this.config.get<string>(
      "dialog.general.referenceInputSpaceSubstitution",
      "None",
    );

    return {
      addTag: {
        pushToRemote: !!this.config.get("dialog.addTag.pushToRemote", false),
        type:
          this.config.get<string>("dialog.addTag.type", "Annotated") === "Lightweight"
            ? TagType.Lightweight
            : TagType.Annotated,
      },
      applyStash: {
        reinstateIndex: !!this.config.get("dialog.applyStash.reinstateIndex", false),
      },
      cherryPick: {
        noCommit: !!this.config.get("dialog.cherryPick.noCommit", false),
        recordOrigin: !!this.config.get("dialog.cherryPick.recordOrigin", false),
      },
      createBranch: {
        checkout: !!this.config.get("dialog.createBranch.checkOut", false),
      },
      deleteBranch: {
        forceDelete: !!this.config.get("dialog.deleteBranch.forceDelete", false),
      },
      fetchIntoLocalBranch: {
        forceFetch: !!this.config.get("dialog.fetchIntoLocalBranch.forceFetch", false),
      },
      fetchRemote: {
        prune: !!this.config.get("dialog.fetchRemote.prune", false),
        pruneTags: !!this.config.get("dialog.fetchRemote.pruneTags", false),
      },
      general: {
        referenceInputSpaceSubstitution:
          refInputSpaceSubstitution === "Hyphen"
            ? "-"
            : refInputSpaceSubstitution === "Underscore"
              ? "_"
              : null,
      },
      merge: {
        noCommit: !!this.config.get("dialog.merge.noCommit", false),
        noFastForward: !!this.config.get("dialog.merge.noFastForward", true),
        squash: !!this.config.get("dialog.merge.squashCommits", false),
      },
      popStash: {
        reinstateIndex: !!this.config.get("dialog.popStash.reinstateIndex", false),
      },
      pullBranch: {
        noFastForward: !!this.config.get("dialog.pullBranch.noFastForward", false),
        squash: !!this.config.get("dialog.pullBranch.squashCommits", false),
      },
      rebase: {
        ignoreDate: !!this.config.get("dialog.rebase.ignoreDate", true),
        interactive: !!this.config.get("dialog.rebase.launchInteractiveRebase", false),
      },
      resetCommit: {
        mode:
          resetCommitMode === "Soft"
            ? GitResetMode.Soft
            : resetCommitMode === "Hard"
              ? GitResetMode.Hard
              : GitResetMode.Mixed,
      },
      resetUncommitted: {
        mode:
          resetUncommittedMode === "Hard" ? GitResetMode.Hard : GitResetMode.Mixed,
      },
      stashUncommittedChanges: {
        includeUntracked: !!this.config.get(
          "dialog.stashUncommittedChanges.includeUntracked",
          true,
        ),
      },
    };
  }

  /**
   * Get the value of the `jjk.graph.enhancedAccessibility` Extension Setting.
   */
  get enhancedAccessibility() {
    return !!this.config.get("enhancedAccessibility", false);
  }

  /**
   * Get the graph configuration from the Extension Settings.
   */
  get graph(): GraphConfig {
    const colours = this.config.get<string[]>("graph.colours", []);
    return {
      colours:
        Array.isArray(colours) && colours.length > 0
          ? colours.filter(
              (v) =>
                v.match(
                  /^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/,
                ) !== null,
            )
          : ["#0085d9", "#d9008f", "#00d90a", "#d98500", "#a300d9", "#ff0000", "#00d9cc", "#e138e8", "#85d900", "#dc5b23", "#6f24d6", "#ffcc00"],
      style:
        this.config.get<string>("graph.style", "rounded") === "angular"
          ? GraphStyle.Angular
          : GraphStyle.Rounded,
      grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
      uncommittedChanges:
        this.config.get<string>(
          "graph.uncommittedChanges",
          "Open Circle at the Uncommitted Changes",
        ) === "Open Circle at the Checked Out Commit"
          ? GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit
          : GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges,
    };
  }

  /**
   * Get the keybinding configuration from the `jjk.graph.keyboardShortcut.*` Extension Settings.
   */
  get keybindings(): KeybindingConfig {
    return {
      find: this.getKeybinding("keyboardShortcut.find", "f"),
      refresh: this.getKeybinding("keyboardShortcut.refresh", "r"),
      scrollToHead: this.getKeybinding("keyboardShortcut.scrollToHead", "h"),
      scrollToStash: this.getKeybinding("keyboardShortcut.scrollToStash", "s"),
    };
  }

  /**
   * Get the value of the `jjk.graph.markdown` Extension Setting.
   */
  get markdown() {
    return !!this.config.get("markdown", true);
  }

  /**
   * Get the reference label configuration from the Extension Settings.
   */
  get referenceLabels(): ReferenceLabelsConfig {
    const alignmentConfigValue = this.config.get<string>(
      "referenceLabels.alignment",
      "Normal",
    );
    const alignment =
      alignmentConfigValue === "Branches (on the left) & Tags (on the right)"
        ? RefLabelAlignment.BranchesOnLeftAndTagsOnRight
        : alignmentConfigValue === "Branches (aligned to the graph) & Tags (on the right)"
          ? RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight
          : RefLabelAlignment.Normal;
    return {
      branchLabelsAlignedToGraph:
        alignment === RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight,
      combineLocalAndRemoteBranchLabels: !!this.config.get(
        "referenceLabels.combineLocalAndRemoteBranchLabels",
        true,
      ),
      tagLabelsOnRight: alignment !== RefLabelAlignment.Normal,
    };
  }

  /**
   * Get the value of the `jjk.graph.repository.commits.fetchAvatars` Extension Setting.
   */
  get fetchAvatars() {
    return !!this.config.get("repository.commits.fetchAvatars", false);
  }

  /**
   * Get the value of the `jjk.graph.repository.commits.initialLoad` Extension Setting.
   */
  get initialLoadCommits() {
    return this.config.get("repository.commits.initialLoad", 300);
  }

  /**
   * Get the value of the `jjk.graph.repository.commits.loadMore` Extension Setting.
   */
  get loadMoreCommits() {
    return this.config.get("repository.commits.loadMore", 100);
  }

  /**
   * Get the value of the `jjk.graph.repository.commits.loadMoreAutomatically` Extension Setting.
   */
  get loadMoreCommitsAutomatically() {
    return !!this.config.get("repository.commits.loadMoreAutomatically", true);
  }

  /**
   * Get the mute commits configuration from the Extension Settings.
   */
  get muteCommits(): MuteCommitsConfig {
    return {
      commitsNotAncestorsOfHead: !!this.config.get(
        "repository.commits.mute.commitsThatAreNotAncestorsOfHead",
        false,
      ),
      mergeCommits: !!this.config.get("repository.commits.mute.mergeCommits", true),
    };
  }

  /**
   * The commit ordering is fixed to date in JJ Graph.
   */
  get commitOrder() {
    return CommitOrdering.Date;
  }

  /**
   * Fetch and prune is not supported in JJ Graph.
   */
  get fetchAndPrune() {
    return false;
  }

  /**
   * Fetch and prune tags is not supported in JJ Graph.
   */
  get fetchAndPruneTags() {
    return false;
  }

  /**
   * Reflog commits are not supported in JJ Graph.
   */
  get includeCommitsMentionedByReflogs() {
    return false;
  }

  /**
   * Get the On Repo Load configuration from the Extension Settings.
   */
  get onRepoLoad(): OnRepoLoadConfig {
    const branches = this.config.get("repository.onLoad.showSpecificBranches", []);
    return {
      scrollToHead: !!this.config.get("repository.onLoad.scrollToHead", false),
      showCheckedOutBranch: !!this.config.get(
        "repository.onLoad.showCheckedOutBranch",
        false,
      ),
      showSpecificBranches: Array.isArray(branches)
        ? branches.filter((branch) => typeof branch === "string")
        : [],
    };
  }

  /**
   * Only following the first parent is not supported in JJ Graph.
   */
  get onlyFollowFirstParent() {
    return false;
  }

  /**
   * Get the value of the `jjk.graph.repository.showRemoteBranches` Extension Setting.
   */
  get showRemoteBranches() {
    return !!this.config.get("repository.showRemoteBranches", true);
  }

  /**
   * Stashes are not supported in JJ Graph.
   */
  get showStashes() {
    return false;
  }

  /**
   * Get the value of the `jjk.graph.repository.showTags` Extension Setting.
   */
  get showTags() {
    return !!this.config.get("repository.showTags", true);
  }

  /**
   * Uncommitted changes are not shown in JJ Graph.
   */
  get showUncommittedChanges() {
    return false;
  }

  /**
   * Get the value of the `jjk.graph.repositoryDropdownOrder` Extension Setting.
   */
  get repoDropdownOrder(): RepoDropdownOrder {
    const order = this.config.get<string>(
      "repositoryDropdownOrder",
      "Workspace Full Path",
    );
    return order === "Full Path"
      ? RepoDropdownOrder.FullPath
      : order === "Name"
        ? RepoDropdownOrder.Name
        : RepoDropdownOrder.WorkspaceFullPath;
  }

  /**
   * Get the value of the `jjk.graph.retainContextWhenHidden` Extension Setting.
   */
  get retainContextWhenHidden() {
    return !!this.config.get("retainContextWhenHidden", true);
  }

  /**
   * Get the value of the `jjk.graph.tabIconColourTheme` Extension Setting.
   */
  get tabIconColourTheme() {
    return this.config.get<string>("tabIconColourTheme", "colour") === "grey"
      ? TabIconColourTheme.Grey
      : TabIconColourTheme.Colour;
  }

  /**
   * Get the normalised keybinding located by the provided section.
   * @param section The section locating the keybinding setting.
   * @param defaultValue The default keybinding.
   * @returns The normalised keybinding.
   */
  private getKeybinding(section: string, defaultValue: string) {
    const configValue = this.config.get<string>(section);
    if (typeof configValue === "string") {
      if (configValue === "UNASSIGNED") {
        return null;
      } else if (Config.KEYBINDING_REGEXP.test(configValue)) {
        return configValue.substring(11).toLowerCase();
      }
    }
    return defaultValue;
  }
}

/**
 * Get a Config instance for retrieving the users configuration of JJ Graph Extension Settings.
 * @param repo An optional path of a repository (to be used for Workspace Folder Scoped Configuration Values).
 * @returns A Config instance.
 */
export function getConfig(repo?: string) {
  return new Config(repo);
}

/**
 * Recursively apply the values in a user specified object to an object containing default values.
 * @param base An object containing the default values.
 * @param user An object specified by the user.
 */
function mergeConfigObjects(
  base: { [key: string]: unknown },
  user: { [key: string]: unknown },
) {
  if (typeof base !== typeof user) {
    return;
  }

  const keys = Object.keys(base);
  for (let i = 0; i < keys.length; i++) {
    if (typeof base[keys[i]] === "object") {
      if (typeof user[keys[i]] === "object") {
        mergeConfigObjects(
          base[keys[i]] as { [key: string]: unknown },
          user[keys[i]] as { [key: string]: unknown },
        );
      }
    } else if (typeof user[keys[i]] === typeof base[keys[i]]) {
      base[keys[i]] = user[keys[i]];
    }
  }
}
