import { describe, it, expect } from "vitest";
import { normalizeIssueFilter } from "../../src/config/config.js";
import { issueFilterApplies, issueFilterRefusal } from "../../src/engine/issue-filter.js";

const bugOnly = normalizeIssueFilter({ requiredLabels: ["bug"] });

describe("normalizeIssueFilter", () => {
  it("is off when the block is missing", () => {
    expect(normalizeIssueFilter(undefined)).toEqual({
      requiredLabels: [],
      workflows: ["issue-triage", "build"],
    });
  });

  it("keeps the configured workflows and drops values that are not strings", () => {
    expect(normalizeIssueFilter({ requiredLabels: [" bug ", "", 3], workflows: ["build"] })).toEqual({
      requiredLabels: ["bug"],
      workflows: ["build"],
    });
  });
});

describe("issueFilterApplies", () => {
  it("does not apply when the filter is off", () => {
    expect(issueFilterApplies(normalizeIssueFilter({}), { workflowName: "build", issueNumber: 1 })).toBe(false);
  });

  it("applies to the triage and the build of an issue", () => {
    expect(issueFilterApplies(bugOnly, { workflowName: "issue-triage", issueNumber: 7 })).toBe(true);
    expect(issueFilterApplies(bugOnly, { workflowName: "build", issueNumber: 7 })).toBe(true);
  });

  it("does not apply to a workflow that is not governed", () => {
    expect(issueFilterApplies(bugOnly, { workflowName: "explore", issueNumber: 7 })).toBe(false);
  });

  it("does not apply to a PR run or to a repo-wide scan", () => {
    expect(issueFilterApplies(bugOnly, { workflowName: "build", issueNumber: 7, prNumber: 8 })).toBe(false);
    expect(issueFilterApplies(bugOnly, { workflowName: "issue-triage" })).toBe(false);
  });
});

describe("issueFilterRefusal", () => {
  it("lets through an issue that has a required label, in any case", () => {
    expect(issueFilterRefusal(bugOnly, ["Bug", "p1"])).toBeNull();
  });

  it("refuses an issue that has none of the required labels", () => {
    expect(issueFilterRefusal(bugOnly, ["enhancement"])).toBe(
      "the issue has none of the required labels (`bug`)",
    );
    expect(issueFilterRefusal(bugOnly, [])).not.toBeNull();
  });
});
