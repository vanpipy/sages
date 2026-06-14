# /minimax-quickstart

Verify pi-minimax is installed correctly and walk through basic usage.

## Steps

1. Run `minimax_auth_status` to check mmx auth state.
   - If `NOT_AUTHED`: tell the user to either `mmx auth login` or `export MINIMAX_API_KEY=sk-…`.
   - If `MMX_NOT_FOUND`: tell the user to `npm install -g mmx-cli`.
   - If success: continue.

2. Run `minimax_search_query({ query: "MiniMax AI" })` as a smoke test.
   - Show the first 2 results (title + link).
   - If empty, note that search returned no results (still success).

3. Show one example of `minimax_exec` for text chat:
   ```
   minimax_exec({
     command: "text chat",
     args: { message: "Say hello in one word" }
   })
   ```

4. Summarize what's installed and ready:
   - 3 tools: `minimax_auth_status`, `minimax_exec`, `minimax_search_query`
   - All other modalities reachable via `minimax_exec`
   - Auto-auth from `MINIMAX_API_KEY` env is enabled

If any step fails, show the structured error and recommend the fix from the
SKILL.md troubleshooting table.
