import * as vscode from "vscode";
import path from "path";
import { toJJUri, type JJUriParams } from "./uri";
import type { BranchDiff, Change, FileStatus } from "./types";
import type { RepoState } from "./services/RepoState";

export type ChangesViewMode = "commits" | "branch";

export interface RenderData {
  workingCopy: Change;
  workingCopyFileStatuses: FileStatus[];
  parentChanges: { change: Change; fileStatuses: FileStatus[] }[];
  branchDiff: BranchDiff | undefined;
  totalFileCount: number;
}

export function computeRenderData(state: RepoState): RenderData | null {
  if (!state.status?.workingCopy) {
    return null;
  }

  const parentChanges = state.status.parentChanges.map((parentChange) => {
    const show = state.parentShowResults.get(parentChange.changeId);
    return {
      change: parentChange,
      fileStatuses: show ? show.fileStatuses : [],
    };
  });

  return {
    workingCopy: state.status.workingCopy,
    workingCopyFileStatuses: state.status.fileStatuses,
    parentChanges,
    branchDiff: state.branchDiff,
    totalFileCount: state.status.fileStatuses.length,
  };
}

export function computeStateSignature(state: RepoState): string {
  const status = state.status;
  if (!status) {
    return "";
  }
  const fileSignature = (files: FileStatus[]) =>
    files.map((file) => [file.type, file.path, file.renamedFrom ?? ""]);
  return JSON.stringify([
    [
      status.workingCopy.changeId,
      status.workingCopy.commitId,
      status.workingCopy.description,
      status.workingCopy.isEmpty,
      status.workingCopy.isConflict,
      status.workingCopy.isDivergent ?? false,
    ],
    fileSignature(status.fileStatuses),
    status.parentChanges.map((change) => {
      const show = state.parentShowResults.get(change.changeId);
      return [
        change.changeId,
        change.commitId,
        change.description,
        change.isEmpty,
        change.isConflict,
        change.isDivergent ?? false,
        fileSignature(show?.fileStatuses ?? []),
        show ? [...show.conflictedFiles].sort() : [],
      ];
    }),
    state.branchDiff
      ? [
          state.branchDiff.fromRev,
          state.branchDiff.toRev,
          fileSignature(state.branchDiff.fileStatuses),
        ]
      : null,
  ]);
}

function getLabel(prefix: string, change: Change) {
  return `${prefix} [${change.changeId.substring(0, 8)}]${
    change.description ? ` • ${change.description}` : ""
  }${change.isEmpty ? " (empty)" : ""}${
    change.isConflict ? " (conflict)" : ""
  }${change.isDivergent ? " (divergent)" : ""}${
    change.description ? "" : " (no description)"
  }`;
}

function getResourceStateCommand(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
  diffTitleSuffix: string,
): vscode.Command {
  if (fileStatus.type === "A") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [afterUri],
    };
  } else if (fileStatus.type === "D") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [
        beforeUri,
        {} satisfies vscode.TextDocumentShowOptions,
        `${fileStatus.file} (Deleted)`,
      ],
    };
  }
  return {
    title: "Open",
    command: "vscode.diff",
    arguments: [
      beforeUri,
      afterUri,
      (fileStatus.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
        `${fileStatus.file} ${diffTitleSuffix}`,
    ],
  };
}

export function applyRenderData(
  renderData: RenderData,
  sourceControl: vscode.SourceControl,
  workingCopyGroup: vscode.SourceControlResourceGroup,
  branchDiffGroup: vscode.SourceControlResourceGroup,
  parentGroups: vscode.SourceControlResourceGroup[],
  workspace?: { name: string; root: string; repositoryRoot: string },
  viewMode: ChangesViewMode = "commits",
): vscode.SourceControlResourceGroup[] {
  const revParams = (rev: string, filePath: string): JJUriParams =>
    workspace
      ? {
          rev,
          repo: workspace.repositoryRoot,
          path: path.relative(workspace.root, filePath),
        }
      : { rev };
  const diffOriginalParams = (rev: string, filePath: string): JJUriParams =>
    workspace
      ? {
          diffOriginalRev: rev,
          repo: workspace.repositoryRoot,
          path: path.relative(workspace.root, filePath),
        }
      : { diffOriginalRev: rev };

  workingCopyGroup.hideWhenEmpty = viewMode === "branch";
  branchDiffGroup.hideWhenEmpty = viewMode !== "branch";
  if (viewMode === "branch") {
    const fromRev = renderData.branchDiff?.fromRev ?? "";
    const fileStatuses = renderData.branchDiff?.fileStatuses ?? [];
    workingCopyGroup.resourceStates = [];
    branchDiffGroup.label = workspace
      ? `Branch Diff (${workspace.name})`
      : "Branch Diff";
    branchDiffGroup.resourceStates = fileStatuses.map((fileStatus) => {
      const originalPath =
        fileStatus.renamedFrom &&
        (workspace?.root ?? sourceControl.rootUri?.fsPath)
          ? path.join(
              workspace?.root ?? sourceControl.rootUri!.fsPath,
              fileStatus.renamedFrom,
            )
          : fileStatus.path;
      const afterUri = vscode.Uri.file(fileStatus.path);
      return {
        resourceUri: afterUri,
        decorations: {
          strikeThrough: fileStatus.type === "D",
          tooltip: path.basename(fileStatus.file),
        },
        command: getResourceStateCommand(
          fileStatus,
          toJJUri(
            vscode.Uri.file(originalPath),
            revParams(fromRev, originalPath),
          ),
          afterUri,
          "(Branch Diff)",
        ),
      };
    });
    sourceControl.count = fileStatuses.length;
    for (const group of parentGroups) {
      group.dispose();
    }
    return [];
  }

  branchDiffGroup.resourceStates = [];
  workingCopyGroup.label = getLabel(
    workspace ? `Working Copy (${workspace.name})` : "Working Copy",
    renderData.workingCopy,
  );
  workingCopyGroup.resourceStates = renderData.workingCopyFileStatuses.map(
    (fileStatus) => ({
      resourceUri: vscode.Uri.file(fileStatus.path),
      decorations: {
        strikeThrough: fileStatus.type === "D",
        tooltip: path.basename(fileStatus.file),
      },
      command: getResourceStateCommand(
        fileStatus,
        toJJUri(
          vscode.Uri.file(`${fileStatus.path}`),
          diffOriginalParams(
            workspace ? renderData.workingCopy.commitId : "@",
            fileStatus.path,
          ),
        ),
        vscode.Uri.file(fileStatus.path),
        workspace ? `(${workspace.name}@)` : "(Working Copy)",
      ),
    }),
  );
  sourceControl.count = renderData.totalFileCount;

  const updatedGroups: vscode.SourceControlResourceGroup[] = [];
  for (const [
    parentIndex,
    { change: parentChange, fileStatuses },
  ] of renderData.parentChanges.entries()) {
    const groupId = `@${parentIndex + 1}`;
    const group =
      parentGroups.find((group) => group.id === groupId) ??
      sourceControl.createResourceGroup(groupId, "");
    group.label = getLabel(groupId, parentChange);
    group.resourceStates = fileStatuses.map(
      (parentStatus) => ({
        resourceUri: toJJUri(
          vscode.Uri.file(parentStatus.path),
          revParams(parentChange.commitId, parentStatus.path),
        ),
        decorations: {
          strikeThrough: parentStatus.type === "D",
          tooltip: path.basename(parentStatus.file),
        },
        command: getResourceStateCommand(
          parentStatus,
          toJJUri(
            vscode.Uri.file(parentStatus.path),
            diffOriginalParams(parentChange.commitId, parentStatus.path),
          ),
          toJJUri(
            vscode.Uri.file(parentStatus.path),
            revParams(parentChange.commitId, parentStatus.path),
          ),
          `(${parentChange.changeId})`,
        ),
      }),
    );
    updatedGroups.push(group);
  }
  for (const group of parentGroups) {
    if (!updatedGroups.includes(group)) {
      group.dispose();
    }
  }

  return updatedGroups;
}
