`claude-subagents-synthetic.jsonl` is a synthetic fixture based on the installed Claude ACP 0.95.0 native-subagent implementation. It covers resolved configuration, launch messages, nested sessions, inline permissions, completion and duplicate reply suppression. It is not evidence from a live agent run.

Replay in an isolated dev profile:

```sh
TAWNY_ACP_FIXTURE="$PWD/test/fixtures/acp/claude-subagents-synthetic.jsonl" npm run dev -- --data /tmp/tawny-subagents
```

The fixture loader replays child history on session/load without asking historical permissions again. Resume retains the existing transcript.

The live spike remains pending: repository instructions prohibit actual agent calls during dev verification. With separate authorization to run it, `node scripts/acp-spike.ts --subagents --scenario all` records `claude-subagents.jsonl` and `claude-subagents-load.jsonl`. It exercises default Explore configuration and explicit haiku/low configuration. Live effort reporting and root-versus-child cancellation behavior still need confirmation. Stop currently sends cancellation to the root and all known running/requires_action children.
