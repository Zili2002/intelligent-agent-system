# Research Reader Web

Local-only React and PDF.js interface for `research-reader`.

```sh
npm run build --workspace @intelligent-agent-system/research-reader-web
research-reader-web --root <wiki> --port 4173
```

The server rejects non-localhost bind addresses. API mutations require a
per-process CSRF token, paths remain confined to the Wiki and built client
directories, and LLM-backed Q&A is disabled unless explicitly approved when
the server starts.
