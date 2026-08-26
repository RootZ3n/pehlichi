# TRIO-001 Open Questions and Operator Decisions

1. Should Ptah's work-order tools, Occasio tools, and `guardToolOutput` become identical runtime features in all three agents with capsule/config-controlled enablement, or be removed/moved? This blocks any parity-preserving `tui/src/server.ts` containment patch.
2. Which exact, trusted server-side registration format will identify disposable Howa fixtures? Until specified, caller workspace override should remain disabled rather than treating a broad parent as a capability.
3. Is Pehlichi intentionally deployed without `IKBI_CHAT_TOKEN`? Live routing proves task endpoints fail open without it. Operator-controlled ingress containment is urgent.
4. Which non-chat HTTP routes are task-producing or state-changing by contract, and must they share the same authentication middleware (`reset`, model changes, undo, uploads, work orders, reports/onboarding, and agent-specific routes)?
5. Should cron handler construction be prohibited in production unless a separate trusted `CRON_MUTATION_ENABLED` setting is true, including suppression of persisted-job rearming?
6. Are delegation, browser/account mutation, execute-code, terminal/background process, brain sync/install, skill mutation, and durable memory writes each expected to have separate production capability switches? The current `AGENT_ALLOW_WRITES` bit is insufficient.
7. Are `agent_sync`, `todo`, `brain_think`, and network reads intentionally classified as read-only? Their observed effects do not fit a filesystem-only reading of “write.”
8. Should attachment persistence be disabled or staged ephemerally until after authentication, workspace resolution, and mutation authorization?
9. Which compiled `dist` tree is authoritative, and should generated output be part of release parity verification rather than committed source parity?
10. Should `lab-agent-core` be frozen/labeled historical while a future clean shared-runtime extraction is designed? Its current user modifications must be adjudicated first.
11. Is Truth Firewall command execution intended for trusted operators only? Its CLI defaults and optional `allowedCommands` need an explicit authority boundary before reuse.
12. Who is the trusted issuer for evidence receipts, and how will receipts bind task, repository, runtime tree, commit, tool invocation, and result without model/caller forgery?
13. Must future evidence enforcement fail closed when Truth Firewall is unavailable, and at which unavoidable pre-success boundary? Current trio and IKBI integrations proceed without it.
14. Are the current `LAB_TRUTH`, `TRUTH_FIREWALL_ROOT`, `IKBI_RUNTIME_TRUTH`, and production-evidence flags active in secret service env files? This census intentionally did not read credential-bearing files.
15. Should IKBI's “production evidence” context be renamed/documented to avoid implying enforcement when it only informs builder/critic prompts and emits receipts?

No question above authorizes runtime redesign, service changes, or data mutation under TRIO-000/TRIO-001.
