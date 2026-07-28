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

3. (Optional) Demo a non-typed modality via the AFT-backed `bash` tool:
   ```
   mmx text chat --message "Say hello in one word" \
     --output json --quiet --non-interactive
   ```

   (See the `mmxc-cli` skill for the full mmx flag reference.)

4. Summarize what's installed and ready:
   - 2 tools: `minimax_auth_status`, `minimax_search_query`
   - All other modalities (text/image/video/speech/music/vision/quota/file)
     reachable via the AFT-backed `bash` tool + `mmx <resource> <command>`,
     guided by the `mmxc-cli` skill
   - Auto-auth from `MINIMAX_API_KEY` env is enabled

If any step fails, show the structured error and recommend the fix from the
SKILL.md troubleshooting table.
