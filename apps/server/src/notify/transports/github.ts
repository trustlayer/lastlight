/**
 * GitHub binding for the progress notifier. Owns a single comment id and edits
 * it in place on every `publish()`; `note()` posts a fresh comment for moments
 * that deserve a real notification (approval prompts, terminal summary).
 *
 * With a `sticky` key, the status comment is also kept across runs. The
 * transport adds a hidden marker to the body. On the first publish of a run, it
 * finds the comment of the bot with that marker and edits it. It posts a new
 * comment only when it finds none.
 */
import type { GitHubClient } from "../../engine/github/github.js";
import type { NotifierTransport, ProgressModel } from "../types.js";

export interface GitHubTransportDeps {
  github: GitHubClient;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Existing status-comment id from a resumed run, if any. */
  commentId?: number;
  /** Persist the comment id the first time it's created (so resume re-attaches). */
  save?: (commentId: number) => void;
  /**
   * Keep one status comment for each issue or PR and each `workflow`, across
   * runs. Only a comment that `botLogin` wrote can be adopted.
   */
  sticky?: { workflow: string; botLogin: string };
}

/** The hidden marker that identifies the sticky status comment of a workflow. */
export function statusCommentMarker(workflow: string): string {
  return `<!-- lastlight:status:${workflow} -->`;
}

export class GitHubTransport implements NotifierTransport {
  /** No terminal ping — the finished checklist + the PR-opened event suffice. */
  readonly terminalPing = false;
  private commentId?: number;

  constructor(private readonly deps: GitHubTransportDeps) {
    this.commentId = deps.commentId;
  }

  async publish(markdown: string, _model?: ProgressModel): Promise<void> {
    // GitHub renders markdown natively — the structured model is Slack-only.
    const { github, owner, repo, issueNumber, sticky } = this.deps;
    const marker = sticky ? statusCommentMarker(sticky.workflow) : undefined;
    const body = marker ? `${markdown}\n\n${marker}` : markdown;
    if (this.commentId === undefined && sticky && marker) {
      // A failed lookup must not stop the status update, so it posts a new comment.
      const found = await github
        .findBotCommentWithMarker(owner, repo, issueNumber, marker, sticky.botLogin)
        .catch(() => undefined);
      if (found !== undefined) {
        this.commentId = found;
        this.deps.save?.(found);
      }
    }
    if (this.commentId !== undefined) {
      await github.updateComment(owner, repo, this.commentId, body);
    } else {
      const id = await github.postComment(owner, repo, issueNumber, body);
      this.commentId = id;
      this.deps.save?.(id);
    }
  }

  async note(markdown: string): Promise<void> {
    const { github, owner, repo, issueNumber } = this.deps;
    await github.postComment(owner, repo, issueNumber, markdown);
  }
}
