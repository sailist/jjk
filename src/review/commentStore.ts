import path from "path";
import os from "os";
import fs from "fs/promises";

export type DiffSide = "LEFT" | "RIGHT";

export type StoredComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredThread = {
  id: string;
  filePath: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  selectedText: string;
  createdAt: string;
  comments: StoredComment[];
};

export type ReviewFile = {
  version: 1;
  changeId: string;
  repoRoot: string;
  threads: StoredThread[];
  reviewedFiles: string[];
};

export class ReviewCommentStore {
  private readonly dir: string;
  private readonly cache = new Map<string, ReviewFile>();

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), ".jjk", "reviews");
  }

  async load(changeId: string, repoRoot: string): Promise<ReviewFile> {
    const cached = this.cache.get(changeId);
    if (cached) {
      return cached;
    }
    let review: ReviewFile;
    try {
      const raw = await fs.readFile(this.filePath(changeId), "utf8");
      const parsed = JSON.parse(raw) as ReviewFile;
      review = {
        version: 1,
        changeId,
        repoRoot: parsed.repoRoot ?? repoRoot,
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        reviewedFiles: Array.isArray(parsed.reviewedFiles)
          ? parsed.reviewedFiles
          : [],
      };
    } catch {
      review = { version: 1, changeId, repoRoot, threads: [], reviewedFiles: [] };
    }
    this.cache.set(changeId, review);
    return review;
  }

  async save(review: ReviewFile): Promise<void> {
    this.cache.set(review.changeId, review);
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(review.changeId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(review, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  private filePath(changeId: string): string {
    const safe = changeId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }
}

export const newId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
