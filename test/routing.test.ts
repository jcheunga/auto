import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSuggestedBranch,
  mergeRoutingDirectives,
  parseRepoHint,
  parseRoutingDirectives,
  resolveColumnRouting,
  stripRoutingDirectives,
  type RoutingDirectives
} from "../src/lib/routing";

test("parseRoutingDirectives handles repo/base/branch and column routes", () => {
  const directives = parseRoutingDirectives(`
    @repo acme/mobile
    base: develop
    @branch feature/login-refresh
    @column-route team=ios => repo: acme/mobile; base: develop; branch: ios-login
    column-route status=Approved => branch: release/approved
  `);

  assert.equal(directives.repoHint, "acme/mobile");
  assert.equal(directives.baseBranchHint, "develop");
  assert.equal(directives.branchHint, "feature/login-refresh");
  assert.equal(directives.columnRoutes?.length, 2);
  assert.deepEqual(directives.columnRoutes?.[0], {
    column: "team",
    match: "ios",
    repoHint: "acme/mobile",
    baseBranchHint: "develop",
    branchHint: "ios-login"
  });
});

test("mergeRoutingDirectives applies later overrides and preserves route lists", () => {
  const merged = mergeRoutingDirectives(
    {
      repoHint: "acme/mobile",
      columnRoutes: [{ column: "team", match: "ios", repoHint: "acme/mobile" }]
    },
    {
      baseBranchHint: "develop",
      branchHint: "feature/foo",
      columnRoutes: [{ column: "status", match: "approved", branchHint: "release/approved" }]
    }
  );

  assert.equal(merged.repoHint, "acme/mobile");
  assert.equal(merged.baseBranchHint, "develop");
  assert.equal(merged.branchHint, "feature/foo");
  assert.equal(merged.columnRoutes?.length, 2);
});

test("resolveColumnRouting matches by column text and status label", () => {
  const routing: RoutingDirectives = {
    columnRoutes: [
      { column: "team", match: "ios", repoHint: "acme/mobile", baseBranchHint: "develop" },
      { column: "status", match: "approved", branchHint: "release/approved" }
    ]
  };

  const resolved = resolveColumnRouting(
    routing,
    [
      { id: "team", title: "Team", text: "ios" },
      { id: "priority", title: "Priority", text: "high" }
    ],
    { statusLabel: "APPROVED" }
  );

  assert.equal(resolved.repoHint, "acme/mobile");
  assert.equal(resolved.baseBranchHint, "develop");
  assert.equal(resolved.branchHint, "release/approved");
});

test("resolveColumnRouting ignores unmatched routes", () => {
  const resolved = resolveColumnRouting(
    {
      columnRoutes: [{ column: "team", match: "android", repoHint: "acme/android" }]
    },
    [{ id: "team", title: "Team", text: "ios" }]
  );

  assert.deepEqual(resolved, {});
});

test("stripRoutingDirectives removes directive lines but preserves prompt content", () => {
  const stripped = stripRoutingDirectives(`
    @repo acme/mobile
    Investigate the crash on launch.
    base: develop
    Please keep the existing UX.
  `);

  assert.match(stripped, /Investigate the crash on launch\./);
  assert.match(stripped, /Please keep the existing UX\./);
  assert.doesNotMatch(stripped, /@repo|base:/);
});

test("parseRepoHint accepts owner/repo and rejects malformed hints", () => {
  assert.deepEqual(parseRepoHint("acme/mobile"), { owner: "acme", repo: "mobile" });
  assert.equal(parseRepoHint("mobile"), null);
  assert.equal(parseRepoHint("acme/mobile/extra"), null);
});

test("deriveSuggestedBranch creates a stable compact slug", () => {
  const branch = deriveSuggestedBranch({
    title: "Fix login flow + edge case / crash !!!",
    itemId: "item-123-abc",
    boardName: "Mobile App Board",
    repoHint: "acme/mobile"
  });

  assert.match(branch, /^monday-/);
  assert.ok(branch.length <= 72);
  assert.equal(branch.includes(" "), false);
  assert.equal(branch.endsWith("-"), false);
});
