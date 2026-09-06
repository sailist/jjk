import * as cp from "child_process";
import * as vscode from "vscode";
import { getConfig } from "./config";
import {
  CommitOrdering,
  DateType,
  DeepWriteable,
  ErrorInfo,
  GitCommit,
  GitCommitDetails,
  GitCommitRemote,
  GitConfigLocation,
  GitFileChange,
  GitFileStatus,
  GitPushBranchMode,
  GitRepoConfig,
  GitStash,
  GitTagDetails,
  MergeActionOn,
  RebaseActionOn,
  TagType,
} from "./types";
import { NOT_SUPPORTED_MSG, resolveSpawnOutput } from "./utils";

export const enum JJConfigKey {
  UserName = "user.name",
  UserEmail = "user.email",
}

export interface JJGraphLogger {
  log(message: string): void;
  logError(message: string): void;
}

const FIELD_SEPARATOR = "\\x1f";
const RECORD_SEPARATOR = "\\x1e";
const ROOT_CHANGE_ID = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
const ROOT_COMMIT_ID = "0000000000000000000000000000000000000000";

function commitGraphHash(
  changeId: string,
  commitId: string,
  divergent: boolean,
) {
  return divergent ? changeId + "+" + commitId.slice(0, 8) : changeId;
}

function normalizeGraphHash(hash: string) {
  const plusIndex = hash.indexOf("+");
  return plusIndex > -1
    ? hash.substring(0, plusIndex + 1) +
        hash.substring(plusIndex + 1, plusIndex + 9)
    : hash;
}

const COMMIT_RECORD_TEMPLATE =
  [
    "change_id",
    "commit_id",
    'parents.map(|p| if(p.divergent(), p.change_id() ++ "+" ++ p.commit_id(), p.change_id())).join(",")',
    'local_bookmarks.map(|b| b.name()).join(",")',
    'remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(",")',
    'tags.map(|t| t.name()).join(",")',
    "author.name()",
    "author.email()",
    'author.timestamp().format("%s")',
    'committer.timestamp().format("%s")',
    "description.first_line()",
    'if(divergent,"1","")',
  ].join(` ++ "${FIELD_SEPARATOR}" ++ `) + ` ++ "${RECORD_SEPARATOR}"`;

const COMMIT_DETAILS_TEMPLATE =
  [
    "change_id",
    "commit_id",
    'parents.map(|p| if(p.divergent(), p.change_id() ++ "+" ++ p.commit_id(), p.change_id())).join(",")',
    "author.name()",
    "author.email()",
    'author.timestamp().format("%s")',
    "committer.name()",
    "committer.email()",
    'committer.timestamp().format("%s")',
    "description",
  ].join(` ++ "${FIELD_SEPARATOR}" ++ `) + ` ++ "${RECORD_SEPARATOR}"`;

/**
 * Resolve a change hash used by the JJ Graph View to a jj revset expression.
 * Divergent changes are identified by `change_id "+" commit_id_prefix`; jj
 * commands are run against the commit id in that case.
 */
function resolveRev(hash: string) {
  const plusIndex = hash.indexOf("+");
  return plusIndex > -1 ? hash.substring(plusIndex + 1) : hash;
}

/**
 * Quote a string for use as a jj revset string literal.
 */
function quoteRevsetString(value: string) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Get the error message from a rejected jj command.
 */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Provides access to jj data and operations for the JJ Graph View.
 */
export class JJDataSource {
  private readonly configTomlPath: string;
  private readonly getJjPath: (repo: string) => string;
  private readonly getProbeJjPath: () => string;
  private readonly logger: JJGraphLogger;
  private jjExecutableKnown: boolean = false;

  /**
   * Creates the JJ Graph Data Source.
   * @param configTomlPath The path of the jjk config.toml (enforces color=never / paginate=never).
   * @param getJjPath Resolves the jj executable path for a repository.
   * @param getProbeJjPath Resolves a jj executable path used to probe jj availability.
   * @param logger The logger instance.
   */
  constructor(
    configTomlPath: string,
    getJjPath: (repo: string) => string,
    getProbeJjPath: () => string,
    logger: JJGraphLogger,
  ) {
    this.configTomlPath = configTomlPath;
    this.getJjPath = getJjPath;
    this.getProbeJjPath = getProbeJjPath;
    this.logger = logger;
  }

  /**
   * Is the jj executable unknown.
   */
  public isJjExecutableUnknown() {
    if (this.jjExecutableKnown) {
      return false;
    }
    try {
      const result = cp.spawnSync(this.getProbeJjPath(), ["--version"]);
      if (result.status === 0) {
        this.jjExecutableKnown = true;
        return false;
      }
    } catch (_) {
      void _;
    }
    return true;
  }

  /* Get Data Methods - Core */

  /**
   * Get the high-level information of a repository.
   * @param repo The path of the repository.
   * @param _showRemoteBranches Are remote branches shown (handled by the front-end).
   * @param _showStashes Are stashes shown (not supported in JJ Graph).
   * @param _hideRemotes An array of hidden remotes (handled by the front-end).
   * @returns The repositories information.
   */
  public getRepoInfo(
    repo: string,
    _showRemoteBranches: boolean,
    _showStashes: boolean,
    _hideRemotes: ReadonlyArray<string>,
  ): Promise<GitRepoInfo> {
    return this.getRemotes(repo)
      .then((remotes) =>
        Promise.all([this.getBookmarks(repo, remotes), this.getHead(repo)]).then((results) => {
          return {
            branches: results[0],
            head: results[1],
            remotes: remotes,
            stashes: [],
            error: null,
          };
        }),
      )
      .catch((error: unknown) => {
        return {
          branches: [],
          head: null,
          remotes: [],
          stashes: [],
          error: errorMessageOf(error),
        };
      });
  }

  /**
   * Get the commits in a repository.
   * @param repo The path of the repository.
   * @param branches The list of bookmark names to display, or NULL (show all).
   * @param maxCommits The maximum number of commits to return.
   * @param showTags Are tags shown.
   * @param showRemoteBranches Are remote branches shown.
   * @param _includeCommitsMentionedByReflogs Not supported in JJ Graph.
   * @param _onlyFollowFirstParent Not supported in JJ Graph.
   * @param _commitOrdering The order for commits to be returned (always date in JJ Graph).
   * @param remotes An array of known remotes.
   * @param hideRemotes An array of hidden remotes.
   * @param _stashes Not supported in JJ Graph (always empty).
   * @returns The commits in the repository.
   */
  public getCommits(
    repo: string,
    branches: ReadonlyArray<string> | null,
    maxCommits: number,
    showTags: boolean,
    showRemoteBranches: boolean,
    _includeCommitsMentionedByReflogs: boolean,
    _onlyFollowFirstParent: boolean,
    _commitOrdering: CommitOrdering,
    remotes: ReadonlyArray<string>,
    hideRemotes: ReadonlyArray<string>,
    _stashes: ReadonlyArray<GitStash>,
    showWorkspaces?: boolean,
  ): Promise<GitCommitData> {
    if (showWorkspaces) {
      return this.getWorkspaceCommits(repo, showTags);
    }
    const revset =
      branches === null || branches.length === 0
        ? ":: ~ root()"
        : "::(" +
          branches
            .map((branch) => {
              if (branch.startsWith("remotes/")) {
                const slashIndex = branch.indexOf("/", 8);
                const remote = branch.substring(8, slashIndex);
                const bookmark = branch.substring(slashIndex + 1);
                return `remote_bookmarks(exact:${quoteRevsetString(bookmark)}, exact:${quoteRevsetString(remote)})`;
              }
              return `bookmarks(exact:${quoteRevsetString(branch)})`;
            })
            .join("|") +
          ") ~ root()";
    const dateType = getConfig(repo).dateType;

    return Promise.all([
      this.runJJ(repo, [
        "log",
        "--no-graph",
        "-r",
        revset,
        "-n",
        (maxCommits + 1).toString(),
        "-T",
        COMMIT_RECORD_TEMPLATE,
      ]),
      this.getHead(repo),
      this.getWorkspaces(repo),
    ])
      .then((results) => {
        const records = results[0].split("\x1e").filter((record) => record !== "");
        const head = results[1];
        const workspacesByChangeId = results[2];
        const moreCommitsAvailable = records.length === maxCommits + 1;
        if (moreCommitsAvailable) {
          records.pop();
        }

        const commits: DeepWriteable<GitCommit>[] = [];
        const tags: string[] = [];
        for (let i = 0; i < records.length; i++) {
          const fields = records[i].split("\x1f");
          const changeId = fields[0];
          const commitId = fields[1];
          const divergent = fields[11] === "1";
          const remoteRefs: GitCommitRemote[] = [];
          if (showRemoteBranches && fields[4] !== "") {
            for (const remoteRef of fields[4].split(",")) {
              const atIndex = remoteRef.lastIndexOf("@");
              if (atIndex < 0) {
                continue;
              }
              const name = remoteRef.substring(0, atIndex);
              const remote = remoteRef.substring(atIndex + 1);
              if (hideRemotes.includes(remote)) {
                continue;
              }
              if (remote === "git" && !remotes.includes("git")) {
                continue;
              }
              remoteRefs.push({
                name: remote + "/" + name,
                remote: remotes.includes(remote) ? remote : null,
              });
            }
          }
          if (showTags && fields[5] !== "") {
            for (const tag of fields[5].split(",")) {
              if (!tags.includes(tag)) {
                tags.push(tag);
              }
            }
          }
          commits.push({
            hash: commitGraphHash(changeId, commitId, divergent),
            commitId: commitId,
            parents:
              fields[2] === ""
                ? []
                : fields[2]
                    .split(",")
                    .filter((parent) => parent !== ROOT_CHANGE_ID)
                    .map(normalizeGraphHash),
            author: fields[6],
            email: fields[7],
            date: parseInt(dateType === DateType.Commit ? fields[9] : fields[8]),
            message: fields[10],
            heads: fields[3] === "" ? [] : fields[3].split(","),
            tags:
              showTags && fields[5] !== ""
                ? fields[5].split(",").map((name) => ({ name: name, annotated: false }))
                : [],
            remotes: remoteRefs,
            workspaces: (workspacesByChangeId.get(changeId) ?? [])
              .filter((workspace) => workspace.commitId === commitId)
              .map((workspace) => workspace.name),
            stash: null,
          });
        }

        return {
          commits: commits,
          head: head,
          tags: tags,
          moreCommitsAvailable: moreCommitsAvailable,
          error: null,
        };
      })
      .catch((error: unknown) => {
        return {
          commits: [],
          head: null,
          tags: [],
          moreCommitsAvailable: false,
          error: errorMessageOf(error),
        };
      });
  }

  private async getWorkspaceCommits(
    repo: string,
    showTags: boolean,
  ): Promise<GitCommitData> {
    try {
      const workspaces = await this.getWorkspaces(repo);
      const namesByCommitId = new Map<string, string[]>();
      for (const entries of workspaces.values()) {
        for (const entry of entries) {
          const names = namesByCommitId.get(entry.commitId) ?? [];
          names.push(entry.name);
          namesByCommitId.set(entry.commitId, names);
        }
      }
      const tips = [...namesByCommitId.keys()];
      const head = await this.getHead(repo);
      if (tips.length === 0) {
        return {
          commits: [],
          head: head,
          tags: [],
          moreCommitsAvailable: false,
          error: null,
        };
      }

      const trunk = await this.runJJ(
        repo,
        ["log", "--no-graph", "-r", "trunk()", "-T", "change_id"],
        true,
      ).then(
        (output) => output.trim() || null,
        () => null,
      );

      const forkPointByTip = new Map<string, string>();
      const startPointsByCommit = new Map<string, string[]>();
      await Promise.all(
        tips.map(async (tip) => {
          const others = tips.filter((other) => other !== tip);
          const forkRevset =
            trunk !== null
              ? `fork_point(${tip} | trunk())`
              : others.length > 0
                ? `fork_point(${tip} | ${others.join(" | ")})`
                : "root()";
          const forkPoint = await this.runJJ(
            repo,
            ["log", "--no-graph", "-r", forkRevset, "-T", "commit_id"],
            true,
          ).then(
            (output) => output.trim(),
            () => "",
          );
          if (forkPoint === "" || forkPoint === tip) {
            return;
          }
          forkPointByTip.set(tip, forkPoint);
          if (forkPoint !== ROOT_COMMIT_ID) {
            startPointsByCommit.set(forkPoint, [
              ...(startPointsByCommit.get(forkPoint) ?? []),
              ...namesByCommitId.get(tip)!,
            ]);
          }
        }),
      );

      const revset = tips
        .map((tip) => {
          const forkPoint = forkPointByTip.get(tip);
          if (forkPoint === undefined) {
            return `(${tip})`;
          }
          return forkPoint === ROOT_COMMIT_ID
            ? `(${forkPoint}..${tip})`
            : `((${forkPoint}..${tip}) | ${forkPoint})`;
        })
        .join(" | ");

      const output = await this.runJJ(repo, [
        "log",
        "--no-graph",
        "-r",
        revset,
        "-T",
        COMMIT_RECORD_TEMPLATE,
      ]);
      const dateType = getConfig(repo).dateType;
      const records = output.split("\x1e").filter((record) => record !== "");
      const commits: DeepWriteable<GitCommit>[] = [];
      const tags: string[] = [];
      for (let i = 0; i < records.length; i++) {
        const fields = records[i].split("\x1f");
        const changeId = fields[0];
        const commitId = fields[1];
        const divergent = fields[11] === "1";
        if (showTags && fields[5] !== "") {
          for (const tag of fields[5].split(",")) {
            if (!tags.includes(tag)) {
              tags.push(tag);
            }
          }
        }
        commits.push({
          hash: commitGraphHash(changeId, commitId, divergent),
          commitId: commitId,
          parents:
            fields[2] === ""
              ? []
              : fields[2]
                  .split(",")
                  .filter((parent) => parent !== ROOT_CHANGE_ID)
                  .map(normalizeGraphHash),
          author: fields[6],
          email: fields[7],
          date: parseInt(dateType === DateType.Commit ? fields[9] : fields[8]),
          message: fields[10],
          heads: [],
          tags:
            showTags && fields[5] !== ""
              ? fields[5].split(",").map((name) => ({ name: name, annotated: false }))
              : [],
          remotes: [],
          workspaces: (workspaces.get(changeId) ?? [])
            .filter((workspace) => workspace.commitId === commitId)
            .map((workspace) => workspace.name),
          workspaceStartPoints: startPointsByCommit.get(commitId) ?? [],
          stash: null,
        });
      }
      return {
        commits: commits,
        head: head,
        tags: tags,
        moreCommitsAvailable: false,
        error: null,
      };
    } catch (error: unknown) {
      return {
        commits: [],
        head: null,
        tags: [],
        moreCommitsAvailable: false,
        error: errorMessageOf(error),
      };
    }
  }

  /**
   * Get various jj config variables for a repository that are consumed by the JJ Graph View.
   * @param repo The path of the repository.
   * @param remotes An array of known remotes.
   * @returns The config data.
   */
  public getConfig(
    repo: string,
    remotes: ReadonlyArray<string>,
  ): Promise<GitRepoConfigData> {
    return Promise.all([
      this.getRemoteDetails(repo),
      this.getConfigValue(repo, JJConfigKey.UserName, "--repo"),
      this.getConfigValue(repo, JJConfigKey.UserName, "--user"),
      this.getConfigValue(repo, JJConfigKey.UserEmail, "--repo"),
      this.getConfigValue(repo, JJConfigKey.UserEmail, "--user"),
    ])
      .then((results) => {
        const remoteDetails = results[0];
        const config: GitRepoConfig = {
          branches: {},
          diffTool: null,
          guiDiffTool: null,
          pushDefault: null,
          remotes: remotes.map((remote) => ({
            name: remote,
            url:
              typeof remoteDetails[remote] !== "undefined"
                ? remoteDetails[remote]
                : null,
            pushUrl: null,
          })),
          user: {
            name: { local: results[1], global: results[2] },
            email: { local: results[3], global: results[4] },
          },
        };
        return { config: config, error: null };
      })
      .catch((error: unknown) => {
        return { config: null, error: errorMessageOf(error) };
      });
  }

  /* Get Data Methods - Commit Details View */

  /**
   * Get the commit details for the Commit Details View.
   * @param repo The path of the repository.
   * @param commitHash The hash of the commit open in the Commit Details View.
   * @param _hasParents Does the commit have parents (`jj show` handles parentless commits).
   * @returns The commit details.
   */
  public getCommitDetails(
    repo: string,
    commitHash: string,
    _hasParents: boolean,
  ): Promise<GitCommitDetailsData> {
    const rev = resolveRev(commitHash);
    return Promise.all([
      this.runJJ(repo, ["log", "--no-graph", "-r", rev, "-T", COMMIT_DETAILS_TEMPLATE]),
      this.runJJ(repo, ["show", "-T", "", "--summary", rev]),
      this.runJJ(repo, ["show", "-T", "", "--git", rev]),
    ])
      .then((results) => {
        const fields = results[0].split("\x1e")[0].split("\x1f");
        const description = fields[9];
        const firstLineEnd = description.indexOf("\n");
        const commitDetails: GitCommitDetails = {
          hash: commitHash,
          changeId: fields[0],
          commitId: fields[1],
          parents:
            fields[2] === ""
              ? []
              : fields[2].split(",").filter((parent) => parent !== ROOT_CHANGE_ID),
          author: fields[3],
          authorEmail: fields[4],
          authorDate: parseInt(fields[5]),
          committer: fields[6],
          committerEmail: fields[7],
          committerDate: parseInt(fields[8]),
          signature: null,
          body:
            firstLineEnd === -1
              ? ""
              : description.substring(firstLineEnd + 1).replace(/^\n/, ""),
          fileChanges: applyDiffGitStats(parseFileChanges(results[1]), results[2]),
        };
        return { commitDetails: commitDetails, error: null };
      })
      .catch((error: unknown) => {
        return { commitDetails: null, error: errorMessageOf(error) };
      });
  }

  /**
   * Get the file changes between two commits for the Commit Details View.
   * @param repo The path of the repository.
   * @param fromHash The base revision of the comparison.
   * @param toHash The target revision of the comparison.
   * @returns The comparison data.
   */
  public getCommitComparison(
    repo: string,
    fromHash: string,
    toHash: string,
  ): Promise<GitCommitComparisonData> {
    return Promise.all([
      this.runJJ(repo, [
        "diff",
        "--from",
        resolveRev(fromHash),
        "--to",
        resolveRev(toHash),
        "--summary",
      ]),
      this.runJJ(repo, [
        "diff",
        "--from",
        resolveRev(fromHash),
        "--to",
        resolveRev(toHash),
        "--git",
      ]),
    ])
      .then((results) => {
        return {
          fileChanges: applyDiffGitStats(parseFileChanges(results[0]), results[1]),
          error: null,
        };
      })
      .catch((error: unknown) => {
        return { fileChanges: [], error: errorMessageOf(error) };
      });
  }

  /**
   * Get the contents of a file at a specific revision.
   * @param repo The path of the repository.
   * @param commitHash The revision of the file.
   * @param filePath The relative path of the file within the repository.
   * @returns The file contents.
   */
  public getCommitFile(repo: string, commitHash: string, filePath: string) {
    return this.runJJ(repo, [
      "file",
      "show",
      "-r",
      resolveRev(commitHash),
      "--",
      filePath,
    ]);
  }

  /**
   * Get the subject of a commit.
   * @param repo The path of the repository.
   * @param commitHash The hash of the commit.
   * @returns The subject, or NULL if it couldn't be retrieved.
   */
  public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
    return this.runJJ(repo, [
      "log",
      "--no-graph",
      "-r",
      resolveRev(commitHash),
      "-T",
      "description.first_line()",
    ]).then(
      (subject) => subject,
      () => null,
    );
  }

  /**
   * Rename tracking is not supported in JJ Graph.
   */
  public getNewPathOfRenamedFile(
    _repo: string,
    _commitHash: string,
    _oldFilePath: string,
  ): Promise<string | null> {
    return Promise.resolve(null);
  }

  /**
   * Get the details of a tag.
   * @param repo The path of the repository.
   * @param tagName The name of the tag.
   * @returns The tag details.
   */
  public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
    return Promise.all([
      this.runJJ(repo, ["log", "--no-graph", "-r", tagName, "-T", "change_id"]),
      this.runJJ(repo, ["show", tagName]),
    ])
      .then((results) => {
        const details: GitTagDetails = {
          hash: results[0].trim(),
          taggerName: "",
          taggerEmail: "",
          taggerDate: 0,
          message: results[1],
          signature: null,
        };
        return { details: details, error: null };
      })
      .catch((error: unknown) => {
        return { details: null, error: errorMessageOf(error) };
      });
  }

  /**
   * Get the root directory of the repository containing the provided path, or NULL if the path is not in a jj repository.
   * @param pathOfPotentialRepo A path that may be within a jj repository.
   * @returns The repository root, or NULL.
   */
  public repoRoot(pathOfPotentialRepo: string) {
    return this.runJJ(pathOfPotentialRepo, ["root"], false).then(
      (root) => root.trim(),
      () => null,
    );
  }

  /* Reference Action Methods */

  /**
   * Add a remote to a repository.
   */
  public async addRemote(
    repo: string,
    name: string,
    url: string,
    _pushUrl: string | null,
    fetch: boolean,
  ) {
    const error = await this.runAction(repo, ["git", "remote", "add", name, url]);
    if (error === null && fetch) {
      return await this.runAction(repo, ["git", "fetch", "--remote", name]);
    }
    return error;
  }

  /**
   * Remove a remote from a repository.
   */
  public deleteRemote(repo: string, name: string) {
    return this.runAction(repo, ["git", "remote", "remove", name]);
  }

  /**
   * Edit a remote of a repository.
   */
  public async editRemote(
    repo: string,
    nameOld: string,
    nameNew: string,
    urlOld: string | null,
    urlNew: string | null,
    _pushUrlOld: string | null,
    _pushUrlNew: string | null,
  ) {
    if (nameOld !== nameNew) {
      const error = await this.runAction(repo, [
        "git",
        "remote",
        "rename",
        nameOld,
        nameNew,
      ]);
      if (error !== null) {
        return error;
      }
    }
    if (urlNew !== null && urlNew !== urlOld) {
      const error = await this.runAction(repo, [
        "git",
        "remote",
        "set-url",
        nameNew,
        urlNew,
      ]);
      if (error !== null) {
        return error;
      }
    }
    return null;
  }

  /**
   * Pruning a remote is not supported in JJ Graph.
   */
  public pruneRemote(_repo: string, _name: string) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * Add a tag to a commit.
   */
  public addTag(
    repo: string,
    tagName: string,
    commitHash: string,
    _type: TagType,
    _message: string,
    _force: boolean,
  ) {
    return this.runAction(repo, ["tag", "set", tagName, "-r", resolveRev(commitHash)]);
  }

  /**
   * Delete a tag from a repository.
   */
  public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
    const error = await this.runAction(repo, ["tag", "delete", tagName]);
    if (error === null && deleteOnRemote !== null) {
      return await this.runAction(repo, [
        "git",
        "push",
        "--deleted",
        "--remote",
        deleteOnRemote,
      ]);
    }
    return error;
  }

  /**
   * Fetch from one or all remotes of a repository.
   */
  public fetch(repo: string, remote: string | null, _prune: boolean, _pruneTags: boolean) {
    return this.runAction(
      repo,
      remote === null
        ? ["git", "fetch", "--all-remotes"]
        : ["git", "fetch", "--remote", remote],
    );
  }

  /**
   * Push a bookmark to a remote.
   */
  public pushBranch(
    repo: string,
    branchName: string,
    remote: string,
    _setUpstream: boolean,
    _mode: GitPushBranchMode,
  ) {
    return this.runAction(repo, [
      "git",
      "push",
      "--bookmark",
      branchName,
      "--remote",
      remote,
    ]);
  }

  /**
   * Push a bookmark to multiple remotes.
   */
  public async pushBranchToMultipleRemotes(
    repo: string,
    branchName: string,
    remotes: string[],
    setUpstream: boolean,
    mode: GitPushBranchMode,
  ): Promise<ErrorInfo[]> {
    const errorInfos: ErrorInfo[] = [];
    for (let i = 0; i < remotes.length; i++) {
      errorInfos.push(
        await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode),
      );
      if (errorInfos[i] !== null) {
        break;
      }
    }
    return errorInfos;
  }

  /**
   * Push a tag to multiple remotes.
   */
  public async pushTag(
    repo: string,
    tagName: string,
    remotes: string[],
    _commitHash: string,
    _skipRemoteCheck: boolean,
  ): Promise<ErrorInfo[]> {
    const errorInfos: ErrorInfo[] = [];
    for (let i = 0; i < remotes.length; i++) {
      errorInfos.push(
        await this.runAction(repo, [
          "git",
          "push",
          "--tag",
          tagName,
          "--remote",
          remotes[i],
        ]),
      );
      if (errorInfos[i] !== null) {
        break;
      }
    }
    return errorInfos;
  }

  /**
   * Checkout a bookmark (start a new change on top of it).
   */
  public async checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
    if (remoteBranch === null) {
      return await this.runAction(repo, ["new", branchName]);
    } else {
      const slashIndex = remoteBranch.indexOf("/");
      const remote = remoteBranch.substring(0, slashIndex);
      const bookmark = remoteBranch.substring(slashIndex + 1);
      const remoteRef = bookmark + "@" + remote;
      const error = await this.runAction(
        repo,
        branchName === bookmark
          ? ["bookmark", "track", remoteRef]
          : ["bookmark", "set", branchName, "-r", remoteRef, "--allow-backwards"],
      );
      if (error !== null) {
        return error;
      }
      return await this.runAction(repo, ["new", branchName]);
    }
  }

  /**
   * Create a bookmark on a commit.
   */
  public async createBranch(
    repo: string,
    branchName: string,
    commitHash: string,
    checkout: boolean,
    force: boolean,
  ) {
    const errorInfos: ErrorInfo[] = [
      await this.runAction(
        repo,
        force
          ? ["bookmark", "set", branchName, "-r", resolveRev(commitHash), "--allow-backwards"]
          : ["bookmark", "create", branchName, "-r", resolveRev(commitHash)],
      ),
    ];
    if (errorInfos[0] === null && checkout) {
      errorInfos.push(await this.runAction(repo, ["new", branchName]));
    }
    return errorInfos;
  }

  /**
   * Delete a bookmark from a repository.
   */
  public deleteBranch(repo: string, branchName: string, _forceDelete: boolean) {
    return this.runAction(repo, ["bookmark", "delete", branchName]);
  }

  /**
   * Delete a bookmark on a remote, keeping the local bookmark.
   */
  public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
    const localTarget = await this.runJJ(
      repo,
      ["log", "--no-graph", "-r", branchName, "-T", "commit_id"],
      true,
    ).then(
      (target) => target.trim(),
      () => null,
    );
    if (localTarget === null) {
      const trackError = await this.runAction(repo, [
        "bookmark",
        "track",
        branchName + "@" + remote,
      ]);
      if (trackError !== null) {
        return trackError;
      }
    }
    const deleteError = await this.runAction(repo, ["bookmark", "delete", branchName]);
    if (deleteError !== null) {
      return deleteError;
    }
    const pushError = await this.runAction(repo, [
      "git",
      "push",
      "--deleted",
      "--remote",
      remote,
    ]);
    if (pushError !== null) {
      return pushError;
    }
    if (localTarget !== null) {
      return await this.runAction(repo, ["bookmark", "create", branchName, "-r", localTarget]);
    }
    return null;
  }

  /**
   * Fetch a remote bookmark into a local bookmark.
   */
  public async fetchIntoLocalBranch(
    repo: string,
    remote: string,
    remoteBranch: string,
    localBranch: string,
    _force: boolean,
  ) {
    const error = await this.runAction(repo, [
      "bookmark",
      "track",
      remoteBranch + "@" + remote,
    ]);
    if (error !== null) {
      return error;
    }
    if (localBranch !== remoteBranch) {
      return await this.runAction(repo, [
        "bookmark",
        "set",
        localBranch,
        "-r",
        remoteBranch + "@" + remote,
        "--allow-backwards",
      ]);
    }
    return null;
  }

  /**
   * Pull a bookmark from a remote (fetch updates tracked bookmarks in jj).
   */
  public pullBranch(
    repo: string,
    _branchName: string,
    remote: string,
    _createNewCommit: boolean,
    _squash: boolean,
  ) {
    return this.runAction(repo, ["git", "fetch", "--remote", remote]);
  }

  /**
   * Rename a bookmark.
   */
  public renameBranch(repo: string, oldName: string, newName: string) {
    return this.runAction(repo, ["bookmark", "rename", oldName, newName]);
  }

  /**
   * Merge a reference into the current change (create a new change with both as parents).
   */
  public merge(
    repo: string,
    obj: string,
    _actionOn: MergeActionOn,
    _createNewCommit: boolean,
    _squash: boolean,
    _noCommit: boolean,
  ) {
    return this.runAction(repo, ["new", "@", obj]);
  }

  /**
   * Rebase the current change onto a reference.
   */
  public rebase(
    repo: string,
    obj: string,
    _actionOn: RebaseActionOn,
    _ignoreDate: boolean,
    _interactive: boolean,
  ) {
    return this.runAction(repo, ["rebase", "-b", "@", "-d", obj]);
  }

  /* Commit Action Methods */

  /**
   * Checkout a commit (edit the change).
   */
  public checkoutCommit(repo: string, commitHash: string) {
    return this.runAction(repo, ["edit", resolveRev(commitHash)]);
  }

  /**
   * Create a new change on top of a change.
   */
  public newChange(repo: string, changeId: string) {
    return this.runAction(repo, ["new", resolveRev(changeId)]);
  }

  /**
   * Describe a change.
   */
  public describeChange(repo: string, changeId: string, message: string) {
    return this.runAction(repo, ["describe", resolveRev(changeId), "-m", message]);
  }

  /**
   * Squash a change into its parent.
   */
  public squashChange(repo: string, changeId: string) {
    const rev = resolveRev(changeId);
    return this.runAction(repo, ["squash", "--from", rev, "--into", rev + "-"]);
  }

  /**
   * Cherrypick a commit (duplicate it onto the current change).
   */
  public cherrypickCommit(
    repo: string,
    commitHash: string,
    _parentIndex: number,
    _recordOrigin: boolean,
    _noCommit: boolean,
  ) {
    return this.runAction(repo, ["duplicate", resolveRev(commitHash), "--onto", "@"]);
  }

  /**
   * Drop a commit (abandon the change).
   */
  public dropCommit(repo: string, commitHash: string) {
    return this.runAction(repo, ["abandon", resolveRev(commitHash)]);
  }

  /**
   * Resetting to a commit is not supported in JJ Graph.
   */
  public resetToCommit(_repo: string, _commit: string, _resetMode: string) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * Reverting a commit is not supported in JJ Graph.
   */
  public revertCommit(_repo: string, _commitHash: string, _parentIndex: number) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * Set a jj config value.
   */
  public setConfigValue(
    repo: string,
    key: JJConfigKey,
    value: string,
    location: GitConfigLocation,
  ) {
    return this.runAction(repo, [
      "config",
      "set",
      location === GitConfigLocation.Global ? "--user" : "--repo",
      key,
      value,
    ]);
  }

  /**
   * Unset a jj config value.
   */
  public unsetConfigValue(repo: string, key: JJConfigKey, location: GitConfigLocation) {
    return this.runAction(repo, [
      "config",
      "unset",
      location === GitConfigLocation.Global ? "--user" : "--repo",
      key,
    ]);
  }

  /* File Action Methods */

  /**
   * Cleaning untracked files is not supported in JJ Graph.
   */
  public cleanUntrackedFiles(_repo: string, _directories: boolean) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * Reset a file in the working copy to its state at a specific revision.
   */
  public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
    return this.runAction(repo, [
      "restore",
      "--from",
      resolveRev(commitHash),
      "--",
      filePath,
    ]);
  }

  /* Stash Action Methods (not supported in JJ Graph) */

  public applyStash(_repo: string, _selector: string, _reinstateIndex: boolean) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  public branchFromStash(_repo: string, _selector: string, _branchName: string) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  public dropStash(_repo: string, _selector: string) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  public popStash(_repo: string, _selector: string, _reinstateIndex: boolean) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  public pushStash(_repo: string, _message: string, _includeUntracked: boolean) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /* Other Action Methods */

  /**
   * Creating an archive is not supported in JJ Graph.
   */
  public archive(_repo: string, _ref: string, _outputFilePath: string, _type: "tar" | "zip") {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * External directory diffs are not supported in JJ Graph.
   */
  public openExternalDirDiff(_repo: string, _fromHash: string, _toHash: string, _isGui: boolean) {
    return Promise.resolve(NOT_SUPPORTED_MSG);
  }

  /**
   * Open a new terminal at the repository.
   */
  public openJjTerminal(repo: string, command: string | null, name: string) {
    const terminal = vscode.window.createTerminal({
      cwd: repo,
      name: "JJ Graph: " + name,
    });
    if (command !== null) {
      terminal.sendText("jj " + command);
    }
    terminal.show();
    return Promise.resolve(null);
  }

  /* Private Methods */

  /**
   * Get the names of the local bookmarks in a repository.
   */
  private getWorkspaces(
    repo: string,
  ): Promise<Map<string, { name: string; commitId: string }[]>> {
    return this.runJJ(repo, [
      "workspace",
      "list",
      "-T",
      'name ++ "\\x1f" ++ target.change_id() ++ "\\x1f" ++ target.commit_id() ++ "\\x1e"',
    ]).then((output) => {
      const workspaces = new Map<
        string,
        { name: string; commitId: string }[]
      >();
      for (const record of output.split("\x1e")) {
        if (record === "") {
          continue;
        }
        const fields = record.split("\x1f");
        if (fields.length < 3) {
          continue;
        }
        const entry = { name: fields[0], commitId: fields[2] };
        const existing = workspaces.get(fields[1]);
        if (existing) {
          existing.push(entry);
        } else {
          workspaces.set(fields[1], [entry]);
        }
      }
      return workspaces;
    });
  }

  private getBookmarks(repo: string, remotes: ReadonlyArray<string>): Promise<string[]> {
    return this.runJJ(repo, [
      "bookmark",
      "list",
      "--all",
      "-T",
      'if(remote, "remotes/" ++ remote ++ "/" ++ name, name) ++ "\\x1e"',
    ]).then((output) => {
      const bookmarks = output
        .split("\x1e")
        .filter(
          (bookmark) =>
            bookmark !== "" &&
            (!bookmark.startsWith("remotes/git/") || remotes.includes("git")),
        );
      return [...new Set(bookmarks)];
    });
  }

  /**
   * Get the change id of the current working copy change (@) of a repository.
   */
  private getHead(repo: string): Promise<string | null> {
    return this.runJJ(repo, [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'if(divergent, change_id ++ "+" ++ commit_id(), change_id)',
    ]).then(
      (head) => {
        const trimmed = head.trim();
        return trimmed === "" ? null : normalizeGraphHash(trimmed);
      },
      () => null,
    );
  }

  /**
   * Get the names of the git remotes of a repository (empty for repositories without a git backend).
   */
  private getRemotes(repo: string): Promise<string[]> {
    return this.getRemoteDetails(repo).then((details) => Object.keys(details));
  }

  /**
   * Get the names and urls of the git remotes of a repository.
   */
  private getRemoteDetails(repo: string): Promise<{ [name: string]: string }> {
    return this.runJJ(repo, ["git", "remote", "list"]).then(
      (output) => {
        const details: { [name: string]: string } = {};
        const lines = output.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === "") {
            continue;
          }
          const spaceIndex = line.indexOf(" ");
          if (spaceIndex === -1) {
            details[line] = "";
          } else {
            details[line.substring(0, spaceIndex)] = line.substring(spaceIndex + 1).trim();
          }
        }
        return details;
      },
      () => ({}),
    );
  }

  /**
   * Get a jj config value at a specific scope.
   */
  private getConfigValue(
    repo: string,
    key: JJConfigKey,
    scope: "--repo" | "--user",
  ): Promise<string | null> {
    return this.runJJ(repo, ["config", "list", scope, key]).then(
      (output) => {
        const line = output.split("\n")[0].trim();
        const match = /^[^=]+=\s*(.*)$/.exec(line);
        if (match === null) {
          return null;
        }
        const rawValue = match[1].trim();
        if (rawValue.startsWith('"')) {
          try {
            return JSON.parse(rawValue) as string;
          } catch (_) {
            void _;
          }
        }
        return rawValue === "" ? null : rawValue;
      },
      () => null,
    );
  }

  /**
   * Run a jj action command, resolving to the ErrorInfo that resulted.
   */
  private runAction(repo: string, args: string[]): Promise<ErrorInfo> {
    return this.runJJ(repo, args, false).then(
      () => null,
      (error: unknown) => errorMessageOf(error),
    );
  }

  /**
   * Run a jj command, resolving with stdout on success and rejecting with the error message on failure.
   */
  private runJJ(
    repo: string,
    args: string[],
    ignoreWorkingCopy: boolean = true,
  ): Promise<string> {
    const allArgs = [
      ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "--config-file",
      this.configTomlPath,
      ...args,
    ];
    this.logger.log("spawn: " + JSON.stringify([this.getJjPath(repo), ...allArgs]));
    return resolveSpawnOutput(cp.spawn(this.getJjPath(repo), allArgs, { cwd: repo })).then(
      ([status, stdout, stderr]) => {
        if (status.code === 0) {
          return stdout.toString();
        } else {
          const message = stderr.trim() !== "" ? stderr.trim() : stdout.toString().trim();
          throw new Error(
            message !== ""
              ? message
              : status.error !== null
                ? status.error.message
                : "jj exited with code " + status.code,
          );
        }
      },
    );
  }
}

/**
 * Parse the output of `jj show --summary` / `jj diff --summary` into an array of file changes.
 */
function parseDiffGitStats(
  output: string,
): Map<string, { additions: number; deletions: number } | null> {
  const stats = new Map<string, { additions: number; deletions: number } | null>();
  const lines = output.split("\n");
  let path: string | null = null;
  let binary = false;
  let additions = 0;
  let deletions = 0;
  const flush = () => {
    if (path !== null) {
      stats.set(path, binary ? null : { additions, deletions });
    }
    path = null;
    binary = false;
    additions = 0;
    deletions = 0;
  };
  const unquote = (value: string) =>
    value.startsWith('"') && value.endsWith('"') ? value.substring(1, value.length - 1) : value;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      flush();
    } else if (line.startsWith("Binary files ")) {
      binary = true;
    } else if (line.startsWith("+++ ")) {
      const target = line.substring(4);
      path = target === "/dev/null" ? path : unquote(target.substring(2));
    } else if (line.startsWith("--- ")) {
      const target = line.substring(4);
      if (path === null && target !== "/dev/null") {
        path = unquote(target.substring(2));
      }
    } else if (line.startsWith("+")) {
      additions++;
    } else if (line.startsWith("-")) {
      deletions++;
    }
  }
  flush();
  return stats;
}

function applyDiffGitStats(fileChanges: GitFileChange[], diffGit: string): GitFileChange[] {
  const stats = parseDiffGitStats(diffGit);
  return fileChanges.map((fileChange) => {
    const fileStats =
      stats.get(fileChange.newFilePath) ?? stats.get(fileChange.oldFilePath);
    if (fileStats === undefined) {
      return fileChange;
    }
    return {
      ...fileChange,
      additions: fileStats === null ? null : fileStats.additions,
      deletions: fileStats === null ? null : fileStats.deletions,
    };
  });
}

function parseFileChanges(output: string): GitFileChange[] {
  const fileChanges: GitFileChange[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 3) {
      continue;
    }
    const type = line[0];
    if (type !== "A" && type !== "M" && type !== "D" && type !== "R") {
      continue;
    }
    if (line[1] !== " ") {
      continue;
    }
    const filePath = line.substring(2);
    if (type === "R") {
      const renameMatch = /^\{(.*) => (.*)\}$/.exec(filePath);
      if (renameMatch !== null) {
        fileChanges.push({
          oldFilePath: renameMatch[1],
          newFilePath: renameMatch[2],
          type: GitFileStatus.Renamed,
          additions: null,
          deletions: null,
        });
      }
    } else {
      fileChanges.push({
        oldFilePath: filePath,
        newFilePath: filePath,
        type:
          type === "A"
            ? GitFileStatus.Added
            : type === "M"
              ? GitFileStatus.Modified
              : GitFileStatus.Deleted,
        additions: null,
        deletions: null,
      });
    }
  }
  return fileChanges;
}

interface GitCommitData {
  commits: GitCommit[];
  head: string | null;
  tags: string[];
  moreCommitsAvailable: boolean;
  error: ErrorInfo;
}

export interface GitCommitDetailsData {
  commitDetails: GitCommitDetails | null;
  error: ErrorInfo;
}

interface GitCommitComparisonData {
  fileChanges: GitFileChange[];
  error: ErrorInfo;
}

interface GitRepoInfo {
  branches: string[];
  head: string | null;
  remotes: string[];
  stashes: GitStash[];
  error: ErrorInfo;
}

interface GitRepoConfigData {
  config: GitRepoConfig | null;
  error: ErrorInfo;
}

interface GitTagDetailsData {
  details: GitTagDetails | null;
  error: ErrorInfo;
}
