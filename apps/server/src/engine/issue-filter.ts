/**
 * The issue label filter (`issueFilter:` in the config).
 *
 * An operator sets `issueFilter.requiredLabels` to stop Last Light on the
 * issues that do not have one of the labels. For example, `[bug]` stops the
 * triage and the build of a feature request. The filter governs only the
 * workflows in `issueFilter.workflows` (default: `issue-triage` and `build`),
 * and only a run that has an issue number. A repo-wide triage scan has no
 * issue number, so the filter does not apply to it.
 *
 * `dispatchWorkflow` reads the filter, because every trigger path crosses it:
 * the webhook, the `@bot` comment, Slack, the autonomy sweep and `/api/run`.
 */

import type { IssueFilterConfig } from "../config/config.js";

/** The subject of one dispatch, as far as the filter needs to know it. */
export interface IssueFilterSubject {
  workflowName: string;
  issueNumber?: number;
  prNumber?: number;
}

/**
 * True when the filter must examine the labels of this dispatch. False when
 * the filter is off, when the workflow is not governed, or when the run has
 * no issue to examine (a PR run, or a repo-wide scan).
 */
export function issueFilterApplies(filter: IssueFilterConfig, subject: IssueFilterSubject): boolean {
  if (filter.requiredLabels.length === 0) return false;
  if (!filter.workflows.includes(subject.workflowName)) return false;
  if (typeof subject.prNumber === "number") return false;
  return typeof subject.issueNumber === "number" && subject.issueNumber > 0;
}

/**
 * The reason to refuse the dispatch, or `null` when the issue has one of the
 * required labels. The label comparison ignores the case, the same as GitHub.
 */
export function issueFilterRefusal(filter: IssueFilterConfig, labels: readonly string[]): string | null {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  if (filter.requiredLabels.some((l) => have.has(l.toLowerCase()))) return null;
  const want = filter.requiredLabels.map((l) => `\`${l}\``).join(", ");
  return `the issue has none of the required labels (${want})`;
}
