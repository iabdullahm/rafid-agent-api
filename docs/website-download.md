# `website_download`

`website_download` mirrors a publicly accessible HTTP(S) website with internally generated `wget` arguments and returns a manifest plus an optional ZIP artifact. Callers cannot provide shell flags.

The capability is registered centrally at `$0.75` per successful paid call. The existing REST, MCP, x402/L402/MPP, unified billing, OpenAPI, discovery, preview, and analytics layers consume that registry entry.

Security boundaries:

- Only HTTP(S) URLs without embedded credentials are accepted.
- DNS is resolved with all addresses checked against loopback, private, link-local, metadata, multicast, reserved, and unique-local ranges.
- The downloader uses an argument array and `--max-redirect=0`; redirects are not followed by the worker.
- Size, file-count, depth, timeout, and archive limits are enforced before cleanup.
- Authentication, paywalls, CAPTCHAs, robots restrictions, and anti-bot controls are not bypassed.

Local development stores ZIP artifacts under `WEBSITE_DOWNLOAD_STORAGE_DIR` and returns an opaque file ID. Durable production operation requires a worker environment with `wget`, bounded temporary disk, and an object-storage-backed implementation; a normal Vercel function is not a suitable downloader worker.
