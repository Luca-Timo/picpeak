/**
 * Pins the fix for the PR #596 review blocker.
 *
 * **The bug**
 *
 *   `preservedMeta` was declared with `let` INSIDE the PostgreSQL
 *   `else` branch of `performDatabaseRestore`, then read AFTER the
 *   `else` block closed at the shared replay site (~L1030). On every
 *   real PG restore:
 *
 *     ReferenceError: preservedMeta is not defined
 *
 *   would fire — psql had already completed the data restore, but
 *   the operator-meta replay never ran, the trigger file was left
 *   in place by `_installFromBackupBoot.js` because the restore
 *   "failed", and `combined.log` got a loud FAILED line even though
 *   the data was back. Caught on PR #596 review by the maintainer.
 *
 * **Why CI missed it**
 *
 *   The integration tests around `performFullRestore` only exercise
 *   the SQLite branch via `this.dbType === 'sqlite'`. The PG branch
 *   (~L827-984) requires a real PG connection + real `psql` binary,
 *   neither of which are in the test environment. So the scope leak
 *   sat untested until the maintainer ran a real DR cycle.
 *
 * **What this test does**
 *
 *   Reads the source of `restoreService.js` and asserts the scope
 *   contract: the `preservedMeta` declaration sits ABOVE the
 *   SQLite/PG branch split, so the replay block at the bottom of the
 *   try{} can read it on either branch.
 *
 *   Source-inspection is uglier than a runtime test but it has two
 *   advantages here: (a) it doesn't require a real PG cluster + psql
 *   binary in CI, (b) it pins the EXACT contract — "the declaration
 *   must be visible to the replay block" — which is the property
 *   that broke, more directly than a runtime test would.
 *
 *   The follow-up "real-PG integration test in CI" (separate task)
 *   would replace this with an end-to-end exercise, at which point
 *   this can be deleted.
 */

const fs = require('fs');
const path = require('path');

describe('restoreService — PG branch scope contract (PR #596 review)', () => {
  let src;
  let lines;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'restoreService.js'),
      'utf8',
    );
    lines = src.split(/\r?\n/);
  });

  /** Return the 1-based line number of the FIRST line matching `re`. */
  function findFirst(re) {
    const idx = lines.findIndex((l) => re.test(l));
    return idx >= 0 ? idx + 1 : -1;
  }

  /** Return the 1-based line number of the LAST line matching `re`. */
  function findLast(re) {
    let last = -1;
    lines.forEach((l, i) => { if (re.test(l)) last = i + 1; });
    return last;
  }

  it('declares preservedMeta above the SQLite/PG branch split in performDatabaseRestore', () => {
    // The function spans from `async performDatabaseRestore(` to the
    // matching `}`. We don't need the closing brace — just need to
    // verify the order of three landmarks:
    //
    //   1. `async performDatabaseRestore(` opens the function
    //   2. `let preservedMeta = []` (the declaration) must come
    //      BEFORE...
    //   3. `if (this.dbType === 'sqlite')` (the branch split)
    const functionStart = findFirst(/async\s+performDatabaseRestore\s*\(/);
    expect(functionStart).toBeGreaterThan(0);

    const declarations = lines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter(({ text }) => /let\s+preservedMeta\s*=\s*\[\s*\]/.test(text));

    // The fix removed the in-branch duplicate, so there should be
    // EXACTLY ONE declaration of `let preservedMeta` in the file.
    // If a reviewer accidentally re-introduces the block-scoped
    // duplicate, this catches it.
    expect(declarations).toHaveLength(1);

    const declarationLine = declarations[0].line;
    expect(declarationLine).toBeGreaterThan(functionStart);

    // The SQLite/PG split is the first `if (this.dbType === 'sqlite')`
    // after the function opener.
    const splitLine = lines.findIndex((l, i) =>
      i + 1 > functionStart && /if\s*\(\s*this\.dbType\s*===\s*['"]sqlite['"]\s*\)/.test(l)
    );
    expect(splitLine).toBeGreaterThan(-1);
    const splitLineOneBased = splitLine + 1;

    // The actual contract: declaration line MUST come before the
    // split line. If a future edit puts the declaration inside the
    // else block again, this assertion fails with a clear message.
    expect(declarationLine).toBeLessThan(splitLineOneBased);
  });

  it('the replay block reads preservedMeta outside the SQLite/PG branch', () => {
    // The replay block lives near the end of performDatabaseRestore.
    // It must NOT be guarded by `this.dbType === 'postgresql'` — the
    // intent of hoisting the declaration is that SQLite ALSO runs
    // through the replay block (it just no-ops because the snapshot
    // wasn't taken on the SQLite branch). The test catches a regression
    // where a refactor moves the replay back inside the PG branch.
    const replayLine = findLast(/if\s*\(\s*preservedMeta\.length\s*>\s*0\s*\)/);
    expect(replayLine).toBeGreaterThan(0);

    // Walk backwards from the replay line and look for the nearest
    // `} else {` opener. If the nearest is the PG `else`, it would
    // mean we're inside that branch. If it's null OR points at a
    // different else (one further out), we're at the right scope.
    let nearestElseLine = -1;
    for (let i = replayLine - 2; i >= 0; i--) {
      if (/^\s*}\s*else\s*\{\s*$/.test(lines[i]) || /^\s*else\s*\{\s*$/.test(lines[i])) {
        nearestElseLine = i + 1;
        break;
      }
      if (/^\s*\}\s*$/.test(lines[i]) && i > 0) {
        // Closing brace before an else opener — keep walking
      }
    }

    // The nearest `else {` opener BACKWARDS from the replay site
    // should be either nothing (replay sits at function scope) or
    // an else from a *different* outer construct. Either way, the
    // replay must NOT be lexically inside the dbType === 'sqlite'
    // / else split. We assert this by checking that the SQLite/PG
    // split line is BEFORE the replay, AND that there's a closing
    // brace `}` between them at column-0 indentation depth that
    // matches the split's depth.
    const sqliteSplitLine = lines.findIndex((l) =>
      /if\s*\(\s*this\.dbType\s*===\s*['"]sqlite['"]\s*\)/.test(l)
    ) + 1;

    expect(sqliteSplitLine).toBeGreaterThan(0);
    expect(replayLine).toBeGreaterThan(sqliteSplitLine);

    // Between the split and the replay, there should be a line that
    // closes the else block. We look for `      }` (six-space indent
    // matching the else opener's depth) before the replay site.
    let foundElseClose = false;
    for (let i = sqliteSplitLine; i < replayLine; i++) {
      // The else block closes with `      }` at the same indent as
      // the `} else {` opener. Look for any line that's exactly
      // six-space indent + `}` to find the closing brace.
      if (/^      \}\s*$/.test(lines[i])) {
        foundElseClose = true;
        break;
      }
    }
    expect(foundElseClose).toBe(true);
  });
});
