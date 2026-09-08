import * as vscode from "vscode";
import type { ReviewFileInput, ReviewManager } from "./reviewManager";

type ReviewTreeNode =
  | { kind: "folder"; name: string; path: string; children: ReviewTreeNode[] }
  | { kind: "file"; name: string; file: ReviewFileInput };

const STATUS_LABELS: Record<ReviewFileInput["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
};

const buildTree = (files: ReviewFileInput[]): ReviewTreeNode[] => {
  const root: ReviewTreeNode[] = [];
  const folders = new Map<
    string,
    Extract<ReviewTreeNode, { kind: "folder" }>
  >();
  for (const file of files) {
    const parts = file.filePath.split("/");
    let children = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { kind: "folder", name: parts[i], path: prefix, children: [] };
        folders.set(prefix, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ kind: "file", name: parts[parts.length - 1], file });
  }
  const sortNodes = (nodes: ReviewTreeNode[]): void => {
    nodes.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "folder"
          ? -1
          : 1,
    );
    for (const node of nodes) {
      if (node.kind === "folder") {
        sortNodes(node.children);
      }
    }
  };
  sortNodes(root);
  return root;
};

class ReviewFilesProvider implements vscode.TreeDataProvider<ReviewTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly checkboxEmitter = new vscode.EventEmitter<
    vscode.TreeCheckboxChangeEvent<ReviewTreeNode>
  >();

  readonly onDidChangeTreeData = this.changeEmitter.event;
  readonly onDidChangeCheckboxState = this.checkboxEmitter.event;

  constructor(private readonly manager: ReviewManager) {}

  dispose(): void {
    this.changeEmitter.dispose();
    this.checkboxEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(node: ReviewTreeNode): vscode.TreeItem {
    if (node.kind === "folder") {
      const treeItem = new vscode.TreeItem(
        node.name,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      treeItem.id = `folder:${node.path}`;
      treeItem.contextValue = "jjReviewFolder";
      return treeItem;
    }
    const treeItem = new vscode.TreeItem(
      vscode.Uri.file(node.file.absPath),
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.id = `file:${node.file.filePath}`;
    treeItem.tooltip = `${node.file.filePath} — ${STATUS_LABELS[node.file.status]}`;
    treeItem.checkboxState = this.manager.isFileReviewed(node.file.filePath)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    treeItem.command = {
      command: "jj.review.revealFile",
      title: "Reveal in Review",
      arguments: [node],
    };
    treeItem.contextValue = "jjReviewFile";
    return treeItem;
  }

  getChildren(element?: ReviewTreeNode): ReviewTreeNode[] {
    if (element) {
      return element.kind === "folder" ? element.children : [];
    }
    const session = this.manager.getCurrentSession();
    return session ? buildTree(session.files) : [];
  }
}

class ReviewCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly manager: ReviewManager) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const match = this.manager.matchDocument(document);
    if (!match) {
      return [];
    }
    if (match.side === "LEFT") {
      const file = match.session.files.find(
        (candidate) => candidate.filePath === match.filePath,
      );
      if (file?.status !== "D") {
        return [];
      }
    }
    const reviewed = match.session.review.reviewedFiles.includes(
      match.filePath,
    );
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: reviewed ? "$(check) Reviewed" : "Mark as Reviewed",
        command: "jj.review.toggleFileReviewed",
        arguments: [match.filePath, !reviewed],
      }),
    ];
  }
}

export class ReviewFilesView implements vscode.Disposable {
  private readonly provider: ReviewFilesProvider;
  private readonly codeLensProvider: ReviewCodeLensProvider;
  private readonly view: vscode.TreeView<ReviewTreeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: ReviewManager) {
    this.provider = new ReviewFilesProvider(manager);
    this.codeLensProvider = new ReviewCodeLensProvider(manager);
    this.view = vscode.window.createTreeView("jjReviewFiles", {
      treeDataProvider: this.provider,
    });
    this.disposables.push(
      this.view,
      this.provider,
      this.codeLensProvider,
      vscode.languages.registerCodeLensProvider(
        { scheme: "jj" },
        this.codeLensProvider,
      ),
      manager.onDidChange(() => this.refresh()),
      vscode.commands.registerCommand(
        "jj.review.revealFile",
        (node: ReviewTreeNode) => {
          if (node.kind === "file") {
            void this.manager.revealFile(node.file);
          }
        },
      ),
      vscode.commands.registerCommand(
        "jj.review.toggleFileReviewed",
        (filePath: string, reviewed: boolean) =>
          this.manager.setFileReviewed(filePath, reviewed),
      ),
      this.provider.onDidChangeCheckboxState((event) => {
        for (const [node, state] of event.items) {
          if (node.kind === "file") {
            void this.manager.setFileReviewed(
              node.file.filePath,
              state === vscode.TreeItemCheckboxState.Checked,
            );
          }
        }
      }),
    );
    this.refresh();
  }

  private refresh(): void {
    const session = this.manager.getCurrentSession();
    this.view.title = session
      ? `Review ${session.changeId.substring(0, 8)} (${session.review.reviewedFiles.length}/${session.files.length})`
      : "Review Files";
    this.provider.refresh();
    this.codeLensProvider.refresh();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
