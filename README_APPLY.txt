Trading-booooo v6.10.0 dashboard runtime hotfix r4

Confirmed browser error:
  ReferenceError: finite is not defined

Apply:
1. Open this folder.
2. Upload its contents to the GitHub repository root while preserving paths.
3. Commit as a new commit. Do not upload the containing hotfix folder itself.
4. Wait for GitHub Pages and the new "Validate Trading Dashboard" action.
5. On iPhone/Safari, close the old tab and reopen the page. app.js uses a new cache key v6.10.0-r4.

No Supabase migration or trading-engine redeploy is required for this browser-only fix.
