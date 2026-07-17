# Research Reader

`research-reader` is the evidence-grounded reading workflow layer for the
Intelligent Agent System. It stores versioned Paper Passports, Reviews,
Reading Sessions, subscriptions, and Research Profiles in a companion Wiki.

External tracking, full-text downloads, and LLM review are disabled by default.

## Commands

```sh
research-reader --root <wiki> init
research-reader --root <wiki> status
research-reader --root <wiki> papers
research-reader --root <wiki> paper-show <paper-id>
research-reader --root <wiki> paper-mark <paper-id> --status reading
research-reader --root <wiki> subscription-add <name> <query>
research-reader --root <wiki> track --approve-network
research-reader --root <wiki> paper-acquire <paper-id> --approve-network
research-reader --root <wiki> paper-review <paper-id> --level standard --approve-llm
research-reader --root <wiki> read-start <paper-id> --mode guided-read
research-reader --root <wiki> paper-ask <paper-id> <question> --approve-llm
research-reader --root <wiki> paper-compare <paper-id> <paper-id> --approve-llm
research-reader --root <wiki> extract <paper-id> --approve-llm
research-reader --root <wiki> feedback <paper-id> --type personal-value --value 9
research-reader --root <wiki> profile-rebuild --force
research-reader --root <wiki> report-weekly
research-reader --root <wiki> daemon --approve-network
research-reader --root <wiki> navigation
research-reader --root <wiki> survey-plan "research question"
research-reader --root <wiki> adapter-run zotero <export.json>
```

State is stored under `meta/reader/`, reports under `reports/reader/`, and
generated paper/comparison pages under `wiki/`. JSON, JSONL, and Markdown are
the canonical state; external databases are not required.

Fast Review sees only title/abstract and leaves scientific dimensions unknown.
Standard and Deep Review require acquired full text and exact validated source
quotes for every assessed dimension.

Network, full-text, LLM, compilation, and external notification effects are
independently approval-gated. Deterministic tests inject providers and never
use paid credentials or the live network.
