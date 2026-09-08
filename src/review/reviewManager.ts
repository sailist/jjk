import * as vscode from "vscode";
import path from "path";
import { getParams, toJJUri } from "../uri";
import { emptyReviewDocUri } from "./emptyDocProvider";
import {
  newId,
  ReviewCommentStore,
  type DiffSide,
  type ReviewFile,
  type StoredComment,
  type StoredThread,
} from "./commentStore";

export const REVIEW_COMMENT_CONTROLLER_ID = "jjk-review";

export type ReviewFileInput = {
  filePath: string;
  absPath: string;
  status: "A" | "M" | "D" | "R" | "C";
};

type ReviewResource = {
  originalUri: vscode.Uri | undefined;
  modifiedUri: vscode.Uri | undefined;
};

export type ReviewSession = {
  repoRoot: string;
  changeId: string;
  rev: string;
  files: ReviewFileInput[];
  fileSet: Set<string>;
  review: ReviewFile;
  resources: ReviewResource[];
  title: string;
  threads: Map<string, vscode.CommentThread>;
};

export type DocumentMatch = {
  session: ReviewSession;
  side: DiffSide;
  filePath: string;
};

class ReviewComment implements vscode.Comment {
  savedBody: string | vscode.MarkdownString;

  constructor(
    public readonly id: string,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public parent: vscode.CommentThread | undefined,
    public timestamp?: Date,
  ) {
    this.savedBody = body;
  }
}

const commentText = (body: string | vscode.MarkdownString): string =>
  typeof body === "string" ? body : body.value;

const sessionKey = (repoRoot: string, changeId: string): string =>
  `${repoRoot}\n${changeId}`;

export class ReviewManager implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private currentSessionKey: string | undefined;

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly store: ReviewCommentStore) {
    this.controller = vscode.comments.createCommentController(
      REVIEW_COMMENT_CONTROLLER_ID,
      "JJ Review",
    );
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        if (!this.matchDocument(document)) {
          return [];
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };

    this.disposables.push(
      this.controller,
      vscode.commands.registerCommand(
        "jj.review.addComment",
        (reply: vscode.CommentReply) => this.addComment(reply),
      ),
      vscode.commands.registerCommand(
        "jj.review.replyComment",
        (reply: vscode.CommentReply) => this.addComment(reply),
      ),
      vscode.commands.registerCommand(
        "jj.review.editComment",
        (comment: ReviewComment) =>
          this.updateCommentMode(comment, vscode.CommentMode.Editing),
      ),
      vscode.commands.registerCommand(
        "jj.review.saveComment",
        (comment: ReviewComment) => this.saveComment(comment),
      ),
      vscode.commands.registerCommand(
        "jj.review.cancelEditComment",
        (comment: ReviewComment) => this.cancelEditComment(comment),
      ),
      vscode.commands.registerCommand(
        "jj.review.deleteComment",
        (comment: ReviewComment) => this.deleteComment(comment),
      ),
      vscode.commands.registerCommand(
        "jj.review.deleteThread",
        (thread: vscode.CommentThread) => this.deleteThread(thread),
      ),
    );
  }

  async show(input: {
    repoRoot: string;
    changeId: string;
    rev: string;
    files: ReviewFileInput[];
  }): Promise<void> {
    const key = sessionKey(input.repoRoot, input.changeId);
    const resources: ReviewResource[] = input.files.map((file) => {
      const fileUri = vscode.Uri.file(file.absPath);
      return {
        originalUri:
          file.status === "A"
            ? undefined
            : toJJUri(fileUri, { diffOriginalRev: input.rev }),
        modifiedUri:
          file.status === "D"
            ? emptyReviewDocUri(fileUri)
            : toJJUri(fileUri, { rev: input.rev }),
      };
    });
    const review = await this.store.load(input.changeId, input.repoRoot);
    const session: ReviewSession = {
      repoRoot: input.repoRoot,
      changeId: input.changeId,
      rev: input.rev,
      files: input.files,
      fileSet: new Set(input.files.map((file) => file.filePath)),
      review,
      resources,
      title: `Review ${input.changeId.substring(0, 8)}`,
      threads: new Map(),
    };
    const existing = this.sessions.get(key);
    if (existing) {
      for (const thread of existing.threads.values()) {
        thread.dispose();
      }
    }
    this.sessions.set(key, session);
    this.currentSessionKey = key;

    for (const storedThread of review.threads) {
      this.createThread(session, storedThread);
    }
    this.onDidChangeEmitter.fire();

    await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
      title: session.title,
      resources,
    });
  }

  getCurrentSession(): ReviewSession | undefined {
    return this.currentSessionKey
      ? this.sessions.get(this.currentSessionKey)
      : undefined;
  }

  isFileReviewed(filePath: string): boolean {
    const session = this.getCurrentSession();
    return session?.review.reviewedFiles.includes(filePath) ?? false;
  }

  async setFileReviewed(filePath: string, reviewed: boolean): Promise<void> {
    const session = this.getCurrentSession();
    if (!session) {
      return;
    }
    const reviewedFiles = new Set(session.review.reviewedFiles);
    if (reviewed) {
      reviewedFiles.add(filePath);
    } else {
      reviewedFiles.delete(filePath);
    }
    session.review.reviewedFiles = [...reviewedFiles].sort();
    await this.store.save(session.review);
    this.onDidChangeEmitter.fire();
  }

  async revealFile(file: ReviewFileInput): Promise<void> {
    const session = this.getCurrentSession();
    if (!session) {
      return;
    }
    const index = session.files.indexOf(file);
    const resource = index >= 0 ? session.resources[index] : undefined;
    await vscode.commands.executeCommand("_workbench.openMultiDiffEditor", {
      title: session.title,
      resources: session.resources,
      ...(resource?.modifiedUri
        ? { reveal: { modifiedUri: resource.modifiedUri } }
        : {}),
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  matchDocument(document: vscode.TextDocument): DocumentMatch | undefined {
    if (document.uri.scheme !== "jj" || document.uri.query === "") {
      return undefined;
    }
    let rev: string;
    let side: DiffSide;
    try {
      const params = getParams(document.uri);
      if ("diffOriginalRev" in params) {
        rev = params.diffOriginalRev;
        side = "LEFT";
      } else {
        rev = params.rev;
        side = "RIGHT";
      }
    } catch {
      return undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.rev !== rev) {
        continue;
      }
      const relative = path
        .relative(session.repoRoot, document.uri.fsPath)
        .replaceAll("\\", "/");
      if (relative.startsWith("..") || !session.fileSet.has(relative)) {
        continue;
      }
      return { session, side, filePath: relative };
    }
    return undefined;
  }

  private threadUri(session: ReviewSession, stored: StoredThread): vscode.Uri {
    const fileUri = vscode.Uri.file(
      path.join(session.repoRoot, stored.filePath),
    );
    return stored.side === "LEFT"
      ? toJJUri(fileUri, { diffOriginalRev: session.rev })
      : toJJUri(fileUri, { rev: session.rev });
  }

  private toVsComment(
    stored: StoredComment,
    parent: vscode.CommentThread | undefined,
  ): ReviewComment {
    return new ReviewComment(
      stored.id,
      stored.body,
      vscode.CommentMode.Preview,
      { name: "Me" },
      parent,
      new Date(stored.createdAt),
    );
  }

  private createThread(session: ReviewSession, stored: StoredThread): void {
    if (!session.fileSet.has(stored.filePath)) {
      return;
    }
    const thread = this.controller.createCommentThread(
      this.threadUri(session, stored),
      new vscode.Range(stored.startLine - 1, 0, stored.endLine - 1, 0),
      [],
    );
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.comments = stored.comments.map((comment) =>
      this.toVsComment(comment, thread),
    );
    session.threads.set(stored.id, thread);
  }

  private findStoredThreadId(
    session: ReviewSession,
    thread: vscode.CommentThread,
  ): string | undefined {
    for (const [id, candidate] of session.threads) {
      if (candidate === thread) {
        return id;
      }
    }
    return undefined;
  }

  private sessionAndThread(
    thread: vscode.CommentThread,
  ):
    | { session: ReviewSession; storedThreadId: string | undefined }
    | undefined {
    for (const session of this.sessions.values()) {
      const storedThreadId = this.findStoredThreadId(session, thread);
      if (storedThreadId !== undefined) {
        return { session, storedThreadId };
      }
    }
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === thread.uri.toString(),
    );
    const match = document ? this.matchDocument(document) : undefined;
    return match ? { session: match.session, storedThreadId: undefined } : undefined;
  }

  private async addComment(reply: vscode.CommentReply): Promise<void> {
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === reply.thread.uri.toString(),
    );
    const match = document ? this.matchDocument(document) : undefined;
    if (!match) {
      return;
    }
    const { session, side, filePath } = match;
    const review = await this.store.load(session.changeId, session.repoRoot);
    const now = new Date().toISOString();

    let storedThreadId = this.findStoredThreadId(session, reply.thread);
    if (!storedThreadId) {
      const storedThread: StoredThread = {
        id: newId(),
        filePath,
        side,
        startLine: reply.thread.range.start.line + 1,
        endLine: reply.thread.range.end.line + 1,
        selectedText: document?.getText(reply.thread.range) ?? "",
        createdAt: now,
        comments: [],
      };
      review.threads.push(storedThread);
      storedThreadId = storedThread.id;
      session.threads.set(storedThread.id, reply.thread);
    }

    const storedThread = review.threads.find(
      (thread) => thread.id === storedThreadId,
    );
    if (!storedThread) {
      return;
    }
    const storedComment: StoredComment = {
      id: newId(),
      body: reply.text,
      createdAt: now,
      updatedAt: now,
    };
    storedThread.comments.push(storedComment);
    await this.store.save(review);
    reply.thread.comments = [
      ...reply.thread.comments,
      this.toVsComment(storedComment, reply.thread),
    ];
  }

  private mutateComment(
    comment: ReviewComment,
    mutate: (target: ReviewComment) => void,
  ): void {
    const parent = comment.parent;
    if (!parent) {
      return;
    }
    parent.comments = parent.comments.map((candidate) => {
      if (candidate instanceof ReviewComment && candidate.id === comment.id) {
        mutate(candidate);
      }
      return candidate;
    });
  }

  private updateCommentMode(
    comment: ReviewComment,
    mode: vscode.CommentMode,
  ): void {
    this.mutateComment(comment, (target) => {
      target.mode = mode;
    });
  }

  private async saveComment(comment: ReviewComment): Promise<void> {
    const parent = comment.parent;
    const found = parent && this.sessionAndThread(parent);
    if (!parent || !found || !found.storedThreadId) {
      return;
    }
    this.mutateComment(comment, (target) => {
      target.savedBody = target.body;
      target.mode = vscode.CommentMode.Preview;
    });
    const { session, storedThreadId } = found;
    const review = await this.store.load(session.changeId, session.repoRoot);
    const storedThread = review.threads.find(
      (thread) => thread.id === storedThreadId,
    );
    const storedComment = storedThread?.comments.find(
      (candidate) => candidate.id === comment.id,
    );
    if (storedComment) {
      storedComment.body = commentText(comment.body);
      storedComment.updatedAt = new Date().toISOString();
      await this.store.save(review);
    }
  }

  private cancelEditComment(comment: ReviewComment): void {
    this.mutateComment(comment, (target) => {
      target.body = target.savedBody;
      target.mode = vscode.CommentMode.Preview;
    });
  }

  private async deleteComment(comment: ReviewComment): Promise<void> {
    const parent = comment.parent;
    const found = parent && this.sessionAndThread(parent);
    if (!parent || !found || !found.storedThreadId) {
      return;
    }
    const { session, storedThreadId } = found;
    const review = await this.store.load(session.changeId, session.repoRoot);
    const storedThread = review.threads.find(
      (thread) => thread.id === storedThreadId,
    );
    if (!storedThread) {
      return;
    }
    storedThread.comments = storedThread.comments.filter(
      (candidate) => candidate.id !== comment.id,
    );
    if (storedThread.comments.length === 0) {
      review.threads = review.threads.filter(
        (thread) => thread.id !== storedThreadId,
      );
      session.threads.delete(storedThreadId);
      parent.dispose();
    } else {
      parent.comments = parent.comments.filter(
        (candidate) =>
          !(candidate instanceof ReviewComment && candidate.id === comment.id),
      );
    }
    await this.store.save(review);
  }

  private async deleteThread(thread: vscode.CommentThread): Promise<void> {
    const found = this.sessionAndThread(thread);
    if (!found || !found.storedThreadId) {
      return;
    }
    const { session, storedThreadId } = found;
    const review = await this.store.load(session.changeId, session.repoRoot);
    review.threads = review.threads.filter(
      (stored) => stored.id !== storedThreadId,
    );
    session.threads.delete(storedThreadId);
    thread.dispose();
    await this.store.save(review);
  }
}
